import * as vscode from "vscode"
import { Client } from "ssh2"
import * as WebSocket from "ws"

export interface ServerMessage {
  type: string
  data: any
  id?: string
}

export interface ProjectFile {
  path: string
  content: string
  lastModified: number
}

export class ServerConnection {
  private sshClient: Client | null = null
  private websocket: WebSocket | null = null
  private connected = false
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectInterval = 5000
  private messageHandlers: Map<string, (data: any) => void> = new Map()
  private pendingRequests: Map<string, { resolve: Function; reject: Function; timeout: NodeJS.Timeout }> = new Map()
  private fileWatcher: vscode.FileSystemWatcher | null = null
  private serverHost = ""
  private serverPort = 0
  private username = ""

  constructor() {
    this.setupMessageHandlers()
  }

  async connect(host: string, port: number, username: string): Promise<void> {
    this.serverHost = host
    this.serverPort = port
    this.username = username

    return new Promise((resolve, reject) => {
      this.sshClient = new Client()

      this.sshClient.on("ready", async () => {
        console.log("SSH connection established")

        try {
          // Setup SSH tunnel for WebSocket connection
          await this.setupSSHTunnel()

          // Connect WebSocket through tunnel
          await this.connectWebSocket()

          // Initialize project synchronization
          await this.initializeProjectSync()

          this.connected = true
          this.reconnectAttempts = 0
          vscode.commands.executeCommand("setContext", "ios-vscode.connected", true)
          vscode.window.showInformationMessage("Connected to macOS server")
          resolve()
        } catch (error) {
          console.error("Post-connection setup failed:", error)
          reject(error)
        }
      })

      this.sshClient.on("error", (err) => {
        console.error("SSH connection error:", err)
        vscode.window.showErrorMessage(`Connection failed: ${err.message}`)
        this.handleConnectionError()
        reject(err)
      })

      this.sshClient.on("close", () => {
        console.log("SSH connection closed")
        this.handleDisconnection()
      })

      // Prompt for password
      vscode.window
        .showInputBox({
          prompt: "Enter SSH password",
          password: true,
        })
        .then((password) => {
          if (password) {
            this.sshClient!.connect({
              host,
              port: 22, // SSH port
              username,
              password,
              keepaliveInterval: 30000,
              keepaliveCountMax: 3,
            })
          } else {
            reject(new Error("Password required"))
          }
        })
    })
  }

  private async setupSSHTunnel(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.sshClient) {
        reject(new Error("SSH client not connected"))
        return
      }

      // Create SSH tunnel for WebSocket connection (local port 8080 -> remote port 8080)
      this.sshClient.forwardOut("127.0.0.1", 0, "127.0.0.1", 8080, (err, stream) => {
        if (err) {
          reject(err)
          return
        }

        console.log("SSH tunnel established")
        resolve()
      })
    })
  }

  private async connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Connect to WebSocket server through SSH tunnel
        this.websocket = new WebSocket(`ws://localhost:8080/ios-vscode`)

        this.websocket.on("open", () => {
          console.log("WebSocket connection established")
          this.sendMessage({
            type: "authenticate",
            data: { username: this.username },
          })
          resolve()
        })

        this.websocket.on("message", (data: WebSocket.Data) => {
          try {
            const message: ServerMessage = JSON.parse(data.toString())
            this.handleServerMessage(message)
          } catch (error) {
            console.error("Failed to parse server message:", error)
          }
        })

        this.websocket.on("error", (error) => {
          console.error("WebSocket error:", error)
          reject(error)
        })

        this.websocket.on("close", () => {
          console.log("WebSocket connection closed")
          this.handleDisconnection()
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  private setupMessageHandlers(): void {
    this.messageHandlers.set("simulator_frame", (data) => {
      // Handle simulator frame updates
      this.notifySimulatorFrame(data)
    })

    this.messageHandlers.set("build_output", (data) => {
      // Handle build output
      this.notifyBuildOutput(data)
    })

    this.messageHandlers.set("device_list", (data) => {
      // Handle device list updates
      this.notifyDeviceList(data)
    })

    this.messageHandlers.set("error", (data) => {
      vscode.window.showErrorMessage(`Server error: ${data.message}`)
    })

    this.messageHandlers.set("file_changed", (data) => {
      // Handle remote file changes
      this.handleRemoteFileChange(data)
    })
  }

  private handleServerMessage(message: ServerMessage): void {
    if (message.id && this.pendingRequests.has(message.id)) {
      const request = this.pendingRequests.get(message.id)!
      clearTimeout(request.timeout)
      this.pendingRequests.delete(message.id)

      if (message.type === "error") {
        request.reject(new Error(message.data.message))
      } else {
        request.resolve(message.data)
      }
      return
    }

    const handler = this.messageHandlers.get(message.type)
    if (handler) {
      handler(message.data)
    } else {
      console.warn("Unhandled server message type:", message.type)
    }
  }

  private sendMessage(message: ServerMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected"))
        return
      }

      const messageId = Math.random().toString(36).substr(2, 9)
      message.id = messageId

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(messageId)
        reject(new Error("Request timeout"))
      }, 30000) // 30 second timeout

      this.pendingRequests.set(messageId, { resolve, reject, timeout })

      try {
        this.websocket.send(JSON.stringify(message))
      } catch (error) {
        clearTimeout(timeout)
        this.pendingRequests.delete(messageId)
        reject(error)
      }
    })
  }

  private async initializeProjectSync(): Promise<void> {
    // Setup file watcher for local project files
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath

    // Watch for Swift file changes
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, "**/*.swift"))

    this.fileWatcher.onDidChange(async (uri) => {
      await this.syncFileToServer(uri)
    })

    this.fileWatcher.onDidCreate(async (uri) => {
      await this.syncFileToServer(uri)
    })

    this.fileWatcher.onDidDelete(async (uri) => {
      await this.deleteFileOnServer(uri)
    })

    // Initial project sync
    await this.syncProjectToServer()
  }

  private async syncFileToServer(uri: vscode.Uri): Promise<void> {
    try {
      const content = await vscode.workspace.fs.readFile(uri)
      const relativePath = vscode.workspace.asRelativePath(uri)

      await this.sendMessage({
        type: "sync_file",
        data: {
          path: relativePath,
          content: content.toString(),
          lastModified: Date.now(),
        },
      })

      console.log(`Synced file to server: ${relativePath}`)
    } catch (error) {
      console.error("Failed to sync file to server:", error)
    }
  }

  private async deleteFileOnServer(uri: vscode.Uri): Promise<void> {
    try {
      const relativePath = vscode.workspace.asRelativePath(uri)

      await this.sendMessage({
        type: "delete_file",
        data: { path: relativePath },
      })

      console.log(`Deleted file on server: ${relativePath}`)
    } catch (error) {
      console.error("Failed to delete file on server:", error)
    }
  }

  private async syncProjectToServer(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return
    }

    try {
      const files = await vscode.workspace.findFiles("**/*.swift", "**/node_modules/**")
      const projectFiles: ProjectFile[] = []

      for (const file of files) {
        const content = await vscode.workspace.fs.readFile(file)
        const relativePath = vscode.workspace.asRelativePath(file)
        const stats = await vscode.workspace.fs.stat(file)

        projectFiles.push({
          path: relativePath,
          content: content.toString(),
          lastModified: stats.mtime,
        })
      }

      await this.sendMessage({
        type: "sync_project",
        data: { files: projectFiles },
      })

      vscode.window.showInformationMessage(`Synced ${projectFiles.length} files to server`)
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to sync project: ${error}`)
    }
  }

  private handleRemoteFileChange(data: any): void {
    // Handle file changes from the server (e.g., generated files, build artifacts)
    console.log("Remote file changed:", data)
  }

  private handleConnectionError(): void {
    this.connected = false
    vscode.commands.executeCommand("setContext", "ios-vscode.connected", false)

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      vscode.window.showWarningMessage(
        `Connection lost. Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`,
      )

      setTimeout(() => {
        this.connect(this.serverHost, this.serverPort, this.username).catch((error) => {
          console.error("Reconnection failed:", error)
        })
      }, this.reconnectInterval)
    } else {
      vscode.window.showErrorMessage("Connection lost. Maximum reconnection attempts reached.")
    }
  }

  private handleDisconnection(): void {
    this.connected = false
    vscode.commands.executeCommand("setContext", "ios-vscode.connected", false)

    if (this.fileWatcher) {
      this.fileWatcher.dispose()
      this.fileWatcher = null
    }

    // Clear pending requests
    this.pendingRequests.forEach((request) => {
      clearTimeout(request.timeout)
      request.reject(new Error("Connection closed"))
    })
    this.pendingRequests.clear()
  }

  disconnect(): void {
    if (this.websocket) {
      this.websocket.close()
      this.websocket = null
    }
    if (this.sshClient) {
      this.sshClient.end()
      this.sshClient = null
    }
    if (this.fileWatcher) {
      this.fileWatcher.dispose()
      this.fileWatcher = null
    }
    this.connected = false
    vscode.commands.executeCommand("setContext", "ios-vscode.connected", false)
  }

  isConnected(): boolean {
    return this.connected && this.websocket?.readyState === WebSocket.OPEN
  }

  async executeCommand(command: string): Promise<string> {
    return this.sendMessage({
      type: "execute_command",
      data: { command },
    })
  }

  async getAvailableDevices(): Promise<string[]> {
    const response = await this.sendMessage({
      type: "get_devices",
      data: {},
    })
    return response.devices || []
  }

  async selectDevice(deviceName: string): Promise<void> {
    await this.sendMessage({
      type: "select_device",
      data: { device: deviceName },
    })
  }

  async sendSimulatorInput(inputData: any): Promise<void> {
    await this.sendMessage({
      type: "simulator_input",
      data: inputData,
    })
  }

  async deployToDevice(): Promise<void> {
    await this.sendMessage({
      type: "deploy_device",
      data: {},
    })
  }

  async buildProject(): Promise<void> {
    await this.sendMessage({
      type: "build_project",
      data: {},
    })
  }

  async runProject(): Promise<void> {
    await this.sendMessage({
      type: "run_project",
      data: {},
    })
  }

  // Event notification methods
  private notifySimulatorFrame(data: any): void {
    // Emit event for simulator frame updates
    vscode.commands.executeCommand("ios-vscode.simulatorFrameUpdate", data)
  }

  private notifyBuildOutput(data: any): void {
    // Show build output in VS Code terminal
    const outputChannel = vscode.window.createOutputChannel("iOS Build")
    outputChannel.appendLine(data.output)
    if (data.show) {
      outputChannel.show()
    }
  }

  private notifyDeviceList(data: any): void {
    // Refresh device tree view
    vscode.commands.executeCommand("ios-vscode.refreshDevices")
  }
}
