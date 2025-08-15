import * as vscode from "vscode"
import type { ServerConnection } from "./serverConnection"

export interface DebugSession {
  id: string
  name: string
  type: "simulator" | "device"
  target: string
  status: "running" | "paused" | "stopped"
  processId?: number
}

export interface Breakpoint {
  id: string
  file: string
  line: number
  condition?: string
  enabled: boolean
  verified: boolean
}

export interface StackFrame {
  id: number
  name: string
  file: string
  line: number
  column: number
}

export interface Variable {
  name: string
  value: string
  type: string
  variablesReference?: number
  children?: Variable[]
}

export class DebugService implements vscode.DebugAdapterDescriptorFactory {
  private debugSessions: Map<string, DebugSession> = new Map()
  private breakpoints: Map<string, Breakpoint[]> = new Map()
  private watchExpressions: string[] = []
  private outputChannel: vscode.OutputChannel
  private debugConsole: vscode.OutputChannel

  constructor(private serverConnection: ServerConnection) {
    this.outputChannel = vscode.window.createOutputChannel("iOS Debug")
    this.debugConsole = vscode.window.createOutputChannel("iOS Debug Console")
    this.setupDebugAdapter()
  }

  private setupDebugAdapter(): void {
    // Register debug adapter factory
    vscode.debug.registerDebugAdapterDescriptorFactory("swift", this)

    // Register debug configuration provider
    vscode.debug.registerDebugConfigurationProvider("swift", {
      provideDebugConfigurations: this.provideDebugConfigurations.bind(this),
      resolveDebugConfiguration: this.resolveDebugConfiguration.bind(this),
    })

    // Listen for debug events
    vscode.debug.onDidStartDebugSession(this.onDebugSessionStart.bind(this))
    vscode.debug.onDidTerminateDebugSession(this.onDebugSessionEnd.bind(this))
    vscode.debug.onDidChangeBreakpoints(this.onBreakpointsChanged.bind(this))
  }

  createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    executable: vscode.DebugAdapterExecutable | undefined,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    // Return a debug adapter server that communicates with our remote macOS server
    return new vscode.DebugAdapterServer(8081) // Debug adapter port
  }

  private provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined): vscode.DebugConfiguration[] {
    return [
      {
        name: "Debug iOS Simulator",
        type: "swift",
        request: "launch",
        target: "simulator",
        device: "iPhone 15 Pro",
        program: "${workspaceFolder}",
        stopOnEntry: false,
        console: "debugConsole",
      },
      {
        name: "Debug iOS Device",
        type: "swift",
        request: "launch",
        target: "device",
        program: "${workspaceFolder}",
        stopOnEntry: false,
        console: "debugConsole",
      },
      {
        name: "Attach to Process",
        type: "swift",
        request: "attach",
        target: "simulator",
        processId: "${command:pickProcess}",
      },
    ]
  }

  private resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.DebugConfiguration {
    // Resolve configuration variables
    if (!config.program) {
      config.program = folder?.uri.fsPath || "${workspaceFolder}"
    }

    return config
  }

  private async onDebugSessionStart(session: vscode.DebugSession): Promise<void> {
    if (session.type !== "swift") return

    const debugSession: DebugSession = {
      id: session.id,
      name: session.name,
      type: session.configuration.target === "device" ? "device" : "simulator",
      target: session.configuration.device || "iPhone 15 Pro",
      status: "running",
    }

    this.debugSessions.set(session.id, debugSession)

    // Start debug session on server
    try {
      await this.serverConnection.sendMessage({
        type: "start_debug_session",
        data: {
          sessionId: session.id,
          configuration: session.configuration,
        },
      })

      this.outputChannel.appendLine(`Debug session started: ${session.name}`)
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to start debug session: ${error}`)
    }
  }

  private async onDebugSessionEnd(session: vscode.DebugSession): Promise<void> {
    if (session.type !== "swift") return

    this.debugSessions.delete(session.id)

    // Stop debug session on server
    try {
      await this.serverConnection.sendMessage({
        type: "stop_debug_session",
        data: { sessionId: session.id },
      })

      this.outputChannel.appendLine(`Debug session ended: ${session.name}`)
    } catch (error) {
      console.error("Failed to stop debug session:", error)
    }
  }

  private async onBreakpointsChanged(event: vscode.BreakpointsChangeEvent): Promise<void> {
    // Handle added breakpoints
    for (const bp of event.added) {
      if (bp instanceof vscode.SourceBreakpoint) {
        await this.addBreakpoint(bp)
      }
    }

    // Handle removed breakpoints
    for (const bp of event.removed) {
      if (bp instanceof vscode.SourceBreakpoint) {
        await this.removeBreakpoint(bp)
      }
    }

    // Handle changed breakpoints
    for (const bp of event.changed) {
      if (bp instanceof vscode.SourceBreakpoint) {
        await this.updateBreakpoint(bp)
      }
    }
  }

  private async addBreakpoint(vscodeBreakpoint: vscode.SourceBreakpoint): Promise<void> {
    const filePath = vscode.workspace.asRelativePath(vscodeBreakpoint.location.uri)
    const line = vscodeBreakpoint.location.range.start.line + 1 // Convert to 1-based

    const breakpoint: Breakpoint = {
      id: `${filePath}:${line}`,
      file: filePath,
      line,
      condition: vscodeBreakpoint.condition,
      enabled: vscodeBreakpoint.enabled,
      verified: false,
    }

    // Add to local storage
    if (!this.breakpoints.has(filePath)) {
      this.breakpoints.set(filePath, [])
    }
    this.breakpoints.get(filePath)!.push(breakpoint)

    // Send to server
    try {
      await this.serverConnection.sendMessage({
        type: "add_breakpoint",
        data: breakpoint,
      })

      this.outputChannel.appendLine(`Breakpoint added: ${filePath}:${line}`)
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to add breakpoint: ${error}`)
    }
  }

  private async removeBreakpoint(vscodeBreakpoint: vscode.SourceBreakpoint): Promise<void> {
    const filePath = vscode.workspace.asRelativePath(vscodeBreakpoint.location.uri)
    const line = vscodeBreakpoint.location.range.start.line + 1

    const breakpointId = `${filePath}:${line}`

    // Remove from local storage
    const fileBreakpoints = this.breakpoints.get(filePath)
    if (fileBreakpoints) {
      const index = fileBreakpoints.findIndex((bp) => bp.id === breakpointId)
      if (index !== -1) {
        fileBreakpoints.splice(index, 1)
      }
    }

    // Send to server
    try {
      await this.serverConnection.sendMessage({
        type: "remove_breakpoint",
        data: { id: breakpointId },
      })

      this.outputChannel.appendLine(`Breakpoint removed: ${filePath}:${line}`)
    } catch (error) {
      console.error("Failed to remove breakpoint:", error)
    }
  }

  private async updateBreakpoint(vscodeBreakpoint: vscode.SourceBreakpoint): Promise<void> {
    // Handle breakpoint updates (enabled/disabled, condition changes)
    await this.removeBreakpoint(vscodeBreakpoint)
    await this.addBreakpoint(vscodeBreakpoint)
  }

  async startDebugging(target: "simulator" | "device", deviceName?: string): Promise<void> {
    if (!this.serverConnection.isConnected()) {
      vscode.window.showErrorMessage("Please connect to macOS server first")
      return
    }

    const config: vscode.DebugConfiguration = {
      name: `Debug iOS ${target}`,
      type: "swift",
      request: "launch",
      target,
      device: deviceName || "iPhone 15 Pro",
      program: "${workspaceFolder}",
      stopOnEntry: false,
      console: "debugConsole",
    }

    await vscode.debug.startDebugging(undefined, config)
  }

  async addWatchExpression(expression: string): Promise<void> {
    this.watchExpressions.push(expression)

    try {
      await this.serverConnection.sendMessage({
        type: "add_watch_expression",
        data: { expression },
      })

      this.outputChannel.appendLine(`Watch expression added: ${expression}`)
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to add watch expression: ${error}`)
    }
  }

  async removeWatchExpression(expression: string): Promise<void> {
    const index = this.watchExpressions.indexOf(expression)
    if (index !== -1) {
      this.watchExpressions.splice(index, 1)
    }

    try {
      await this.serverConnection.sendMessage({
        type: "remove_watch_expression",
        data: { expression },
      })

      this.outputChannel.appendLine(`Watch expression removed: ${expression}`)
    } catch (error) {
      console.error("Failed to remove watch expression:", error)
    }
  }

  getDebugSessions(): DebugSession[] {
    return Array.from(this.debugSessions.values())
  }

  getBreakpoints(): Map<string, Breakpoint[]> {
    return new Map(this.breakpoints)
  }

  getWatchExpressions(): string[] {
    return [...this.watchExpressions]
  }
}
