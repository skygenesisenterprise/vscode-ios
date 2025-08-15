import * as vscode from "vscode"
import * as path from "path"
import type { ServerConnection } from "./serverConnection"

export interface HotReloadConfig {
  enabled: boolean
  debounceDelay: number
  incrementalCompilation: boolean
  swiftUIPreviewMode: boolean
  autoSave: boolean
  excludePatterns: string[]
}

export interface ChangeAnalysis {
  type: "ui-only" | "logic" | "structure" | "dependency"
  files: string[]
  affectedComponents: string[]
  requiresFullRebuild: boolean
  estimatedRebuildTime: number
}

export interface HotReloadResult {
  success: boolean
  duration: number
  changeType: string
  errors?: string[]
  warnings?: string[]
}

export class HotReloadService {
  private config: HotReloadConfig = {
    enabled: true,
    debounceDelay: 1000,
    incrementalCompilation: true,
    swiftUIPreviewMode: true,
    autoSave: true,
    excludePatterns: ["**/Tests/**", "**/*.test.swift"],
  }

  private debounceTimer: NodeJS.Timeout | null = null
  private fileWatchers: vscode.FileSystemWatcher[] = []
  private changeQueue: Map<string, { timestamp: number; content: string }> = new Map()
  private lastSuccessfulBuild: Map<string, string> = new Map()
  private buildCache: Map<string, any> = new Map()
  private statusBarItem: vscode.StatusBarItem
  private outputChannel: vscode.OutputChannel
  private isReloading = false
  private reloadHistory: HotReloadResult[] = []

  constructor(private serverConnection: ServerConnection) {
    this.setupStatusBar()
    this.setupOutputChannel()
    this.setupFileWatchers()
    this.loadConfiguration()
  }

  private setupStatusBar(): void {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    this.statusBarItem.command = "ios-vscode.hotReloadToggle"
    this.updateStatusBar()
    this.statusBarItem.show()
  }

  private setupOutputChannel(): void {
    this.outputChannel = vscode.window.createOutputChannel("iOS Hot Reload")
  }

  private updateStatusBar(): void {
    if (this.config.enabled) {
      if (this.isReloading) {
        this.statusBarItem.text = "$(sync~spin) Hot Reload: Building..."
        this.statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground")
      } else {
        this.statusBarItem.text = "$(zap) Hot Reload: Ready"
        this.statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.prominentBackground")
      }
    } else {
      this.statusBarItem.text = "$(circle-slash) Hot Reload: Disabled"
      this.statusBarItem.backgroundColor = undefined
    }
  }

  private loadConfiguration(): void {
    const config = vscode.workspace.getConfiguration("ios-vscode.hotReload")
    this.config = {
      enabled: config.get("enabled", true),
      debounceDelay: config.get("debounceDelay", 1000),
      incrementalCompilation: config.get("incrementalCompilation", true),
      swiftUIPreviewMode: config.get("swiftUIPreviewMode", true),
      autoSave: config.get("autoSave", true),
      excludePatterns: config.get("excludePatterns", ["**/Tests/**", "**/*.test.swift"]),
    }
  }

  private setupFileWatchers(): void {
    // Watch Swift files
    const swiftWatcher = vscode.workspace.createFileSystemWatcher("**/*.swift")
    swiftWatcher.onDidChange((uri) => this.handleFileChange(uri, "change"))
    swiftWatcher.onDidCreate((uri) => this.handleFileChange(uri, "create"))
    swiftWatcher.onDidDelete((uri) => this.handleFileChange(uri, "delete"))
    this.fileWatchers.push(swiftWatcher)

    // Watch SwiftUI files specifically
    const swiftUIWatcher = vscode.workspace.createFileSystemWatcher("**/*View.swift")
    swiftUIWatcher.onDidChange((uri) => this.handleSwiftUIChange(uri))
    this.fileWatchers.push(swiftUIWatcher)

    // Watch project configuration files
    const configWatcher = vscode.workspace.createFileSystemWatcher("**/Package.swift")
    configWatcher.onDidChange((uri) => this.handleConfigChange(uri))
    this.fileWatchers.push(configWatcher)

    // Watch asset files
    const assetWatcher = vscode.workspace.createFileSystemWatcher("**/*.{png,jpg,jpeg,svg,json}")
    assetWatcher.onDidChange((uri) => this.handleAssetChange(uri))
    this.fileWatchers.push(assetWatcher)
  }

  private async handleFileChange(uri: vscode.Uri, changeType: "change" | "create" | "delete"): Promise<void> {
    if (!this.config.enabled || !this.serverConnection.isConnected()) {
      return
    }

    // Check if file should be excluded
    const relativePath = vscode.workspace.asRelativePath(uri)
    if (this.shouldExcludeFile(relativePath)) {
      return
    }

    // Auto-save if enabled
    if (this.config.autoSave && changeType === "change") {
      const document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString())
      if (document && document.isDirty) {
        await document.save()
      }
    }

    // Add to change queue
    let content = ""
    if (changeType !== "delete") {
      try {
        const fileContent = await vscode.workspace.fs.readFile(uri)
        content = fileContent.toString()
      } catch (error) {
        console.error("Failed to read file content:", error)
        return
      }
    }

    this.changeQueue.set(relativePath, {
      timestamp: Date.now(),
      content,
    })

    this.triggerHotReload()
  }

  private async handleSwiftUIChange(uri: vscode.Uri): Promise<void> {
    if (!this.config.swiftUIPreviewMode) {
      return this.handleFileChange(uri, "change")
    }

    // Fast SwiftUI preview update
    const relativePath = vscode.workspace.asRelativePath(uri)
    this.outputChannel.appendLine(`SwiftUI Preview Update: ${relativePath}`)

    try {
      const content = await vscode.workspace.fs.readFile(uri)
      await this.serverConnection.sendMessage({
        type: "swiftui_preview_update",
        data: {
          path: relativePath,
          content: content.toString(),
        },
      })

      this.showNotification("SwiftUI preview updated", "info")
    } catch (error) {
      console.error("SwiftUI preview update failed:", error)
      this.handleFileChange(uri, "change") // Fallback to full reload
    }
  }

  private async handleConfigChange(uri: vscode.Uri): Promise<void> {
    this.outputChannel.appendLine("Project configuration changed - full rebuild required")
    this.buildCache.clear()
    this.triggerHotReload(true) // Force full rebuild
  }

  private async handleAssetChange(uri: vscode.Uri): Promise<void> {
    const relativePath = vscode.workspace.asRelativePath(uri)
    this.outputChannel.appendLine(`Asset changed: ${relativePath}`)

    try {
      await this.serverConnection.sendMessage({
        type: "asset_update",
        data: { path: relativePath },
      })
    } catch (error) {
      console.error("Asset update failed:", error)
    }
  }

  private shouldExcludeFile(filePath: string): boolean {
    return this.config.excludePatterns.some((pattern) => {
      const regex = new RegExp(pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*"))
      return regex.test(filePath)
    })
  }

  private triggerHotReload(forceFullRebuild = false): void {
    // Debounce rapid changes
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(async () => {
      await this.performHotReload(forceFullRebuild)
    }, this.config.debounceDelay)
  }

  private async performHotReload(forceFullRebuild = false): Promise<void> {
    if (this.isReloading) {
      this.outputChannel.appendLine("Hot reload already in progress, skipping...")
      return
    }

    this.isReloading = true
    this.updateStatusBar()

    const startTime = Date.now()
    let result: HotReloadResult

    try {
      // Analyze changes
      const analysis = await this.analyzeChanges()
      this.outputChannel.appendLine(`Change analysis: ${analysis.type} (${analysis.files.length} files)`)

      // Determine reload strategy
      const strategy = forceFullRebuild || analysis.requiresFullRebuild ? "full" : this.getReloadStrategy(analysis)

      // Perform reload based on strategy
      switch (strategy) {
        case "swiftui-preview":
          result = await this.performSwiftUIPreviewReload(analysis)
          break
        case "incremental":
          result = await this.performIncrementalReload(analysis)
          break
        case "full":
        default:
          result = await this.performFullReload(analysis)
          break
      }

      // Update build cache
      this.updateBuildCache()

      // Clear change queue
      this.changeQueue.clear()

      // Show result
      this.showReloadResult(result)
    } catch (error) {
      result = {
        success: false,
        duration: Date.now() - startTime,
        changeType: "error",
        errors: [error.message],
      }

      this.outputChannel.appendLine(`Hot reload failed: ${error.message}`)
      this.showNotification(`Hot reload failed: ${error.message}`, "error")
    } finally {
      this.isReloading = false
      this.updateStatusBar()

      // Add to history
      this.reloadHistory.push(result!)
      if (this.reloadHistory.length > 50) {
        this.reloadHistory.shift()
      }
    }
  }

  private async analyzeChanges(): Promise<ChangeAnalysis> {
    const changedFiles = Array.from(this.changeQueue.keys())
    let changeType: ChangeAnalysis["type"] = "logic"
    let requiresFullRebuild = false
    const affectedComponents: string[] = []

    // Analyze file types and content
    for (const filePath of changedFiles) {
      const change = this.changeQueue.get(filePath)!

      // Check if it's a SwiftUI view
      if (filePath.includes("View.swift") || change.content.includes("@State") || change.content.includes("View {")) {
        changeType = "ui-only"
        affectedComponents.push(path.basename(filePath, ".swift"))
      }

      // Check for structural changes
      if (
        change.content.includes("import ") ||
        change.content.includes("class ") ||
        change.content.includes("struct ") ||
        change.content.includes("enum ") ||
        change.content.includes("protocol ")
      ) {
        changeType = "structure"
        requiresFullRebuild = true
      }

      // Check for dependency changes
      if (filePath.includes("Package.swift") || change.content.includes("@main")) {
        changeType = "dependency"
        requiresFullRebuild = true
      }
    }

    // Estimate rebuild time based on change type and file count
    let estimatedRebuildTime = 0
    switch (changeType) {
      case "ui-only":
        estimatedRebuildTime = Math.min(changedFiles.length * 200, 2000) // 200ms per UI file, max 2s
        break
      case "logic":
        estimatedRebuildTime = Math.min(changedFiles.length * 500, 5000) // 500ms per logic file, max 5s
        break
      case "structure":
        estimatedRebuildTime = Math.min(changedFiles.length * 1000, 15000) // 1s per structural file, max 15s
        break
      case "dependency":
        estimatedRebuildTime = 30000 // 30s for dependency changes
        break
    }

    return {
      type: changeType,
      files: changedFiles,
      affectedComponents,
      requiresFullRebuild,
      estimatedRebuildTime,
    }
  }

  private getReloadStrategy(analysis: ChangeAnalysis): "swiftui-preview" | "incremental" | "full" {
    if (analysis.type === "ui-only" && this.config.swiftUIPreviewMode && analysis.files.length <= 3) {
      return "swiftui-preview"
    }

    if (this.config.incrementalCompilation && !analysis.requiresFullRebuild && analysis.files.length <= 10) {
      return "incremental"
    }

    return "full"
  }

  private async performSwiftUIPreviewReload(analysis: ChangeAnalysis): Promise<HotReloadResult> {
    const startTime = Date.now()

    try {
      // Send SwiftUI preview updates
      for (const filePath of analysis.files) {
        const change = this.changeQueue.get(filePath)!
        await this.serverConnection.sendMessage({
          type: "swiftui_preview_update",
          data: {
            path: filePath,
            content: change.content,
            components: analysis.affectedComponents,
          },
        })
      }

      return {
        success: true,
        duration: Date.now() - startTime,
        changeType: "SwiftUI Preview",
      }
    } catch (error) {
      throw new Error(`SwiftUI preview reload failed: ${error.message}`)
    }
  }

  private async performIncrementalReload(analysis: ChangeAnalysis): Promise<HotReloadResult> {
    const startTime = Date.now()

    try {
      // Send incremental build request
      const response = await this.serverConnection.sendMessage({
        type: "incremental_build",
        data: {
          changedFiles: analysis.files,
          buildCache: this.getBuildCacheForFiles(analysis.files),
        },
      })

      // Apply incremental update
      await this.serverConnection.sendMessage({
        type: "apply_incremental_update",
        data: response,
      })

      return {
        success: true,
        duration: Date.now() - startTime,
        changeType: "Incremental",
        warnings: response.warnings,
      }
    } catch (error) {
      throw new Error(`Incremental reload failed: ${error.message}`)
    }
  }

  private async performFullReload(analysis: ChangeAnalysis): Promise<HotReloadResult> {
    const startTime = Date.now()

    try {
      // Sync all changed files
      for (const filePath of analysis.files) {
        const change = this.changeQueue.get(filePath)!
        await this.serverConnection.sendMessage({
          type: "sync_file",
          data: {
            path: filePath,
            content: change.content,
            lastModified: change.timestamp,
          },
        })
      }

      // Build project
      await this.serverConnection.buildProject()

      // Run project
      await this.serverConnection.runProject()

      return {
        success: true,
        duration: Date.now() - startTime,
        changeType: "Full Rebuild",
      }
    } catch (error) {
      throw new Error(`Full reload failed: ${error.message}`)
    }
  }

  private getBuildCacheForFiles(files: string[]): any {
    const cache: any = {}
    for (const file of files) {
      if (this.buildCache.has(file)) {
        cache[file] = this.buildCache.get(file)
      }
    }
    return cache
  }

  private updateBuildCache(): void {
    // Update build cache with current file states
    for (const [filePath, change] of this.changeQueue) {
      this.buildCache.set(filePath, {
        content: change.content,
        timestamp: change.timestamp,
        hash: this.hashContent(change.content),
      })
      this.lastSuccessfulBuild.set(filePath, change.content)
    }
  }

  private hashContent(content: string): string {
    // Simple hash function for content comparison
    let hash = 0
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash // Convert to 32-bit integer
    }
    return hash.toString()
  }

  private showReloadResult(result: HotReloadResult): void {
    const duration = result.duration
    const message = result.success
      ? `Hot reload completed in ${duration}ms (${result.changeType})`
      : `Hot reload failed after ${duration}ms`

    this.outputChannel.appendLine(message)

    if (result.warnings && result.warnings.length > 0) {
      this.outputChannel.appendLine("Warnings:")
      result.warnings.forEach((warning) => this.outputChannel.appendLine(`  - ${warning}`))
    }

    if (result.errors && result.errors.length > 0) {
      this.outputChannel.appendLine("Errors:")
      result.errors.forEach((error) => this.outputChannel.appendLine(`  - ${error}`))
    }

    // Show notification for significant events
    if (!result.success || duration > 10000) {
      this.showNotification(message, result.success ? "info" : "error")
    }
  }

  private showNotification(message: string, type: "info" | "warning" | "error"): void {
    switch (type) {
      case "info":
        vscode.window.showInformationMessage(message)
        break
      case "warning":
        vscode.window.showWarningMessage(message)
        break
      case "error":
        vscode.window.showErrorMessage(message)
        break
    }
  }

  // Public methods
  toggle(): void {
    this.config.enabled = !this.config.enabled
    this.updateStatusBar()

    const status = this.config.enabled ? "enabled" : "disabled"
    this.showNotification(`Hot reload ${status}`, "info")
    this.outputChannel.appendLine(`Hot reload ${status}`)
  }

  isEnabled(): boolean {
    return this.config.enabled
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled
    this.updateStatusBar()
  }

  async forceReload(): Promise<void> {
    if (!this.serverConnection.isConnected()) {
      this.showNotification("Not connected to server", "error")
      return
    }

    this.outputChannel.appendLine("Force reload triggered")
    await this.performHotReload(true)
  }

  getReloadHistory(): HotReloadResult[] {
    return [...this.reloadHistory]
  }

  getConfiguration(): HotReloadConfig {
    return { ...this.config }
  }

  updateConfiguration(newConfig: Partial<HotReloadConfig>): void {
    this.config = { ...this.config, ...newConfig }
    this.updateStatusBar()

    // Save to VS Code settings
    const config = vscode.workspace.getConfiguration("ios-vscode.hotReload")
    Object.entries(newConfig).forEach(([key, value]) => {
      config.update(key, value, vscode.ConfigurationTarget.Global)
    })
  }

  dispose(): void {
    // Clean up resources
    this.fileWatchers.forEach((watcher) => watcher.dispose())
    this.statusBarItem.dispose()
    this.outputChannel.dispose()

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
  }
}
