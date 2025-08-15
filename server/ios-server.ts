// This file would run on the macOS server
import * as WebSocket from "ws"
import * as http from "http"
import * as fs from "fs"
import * as path from "path"
import { spawn, type ChildProcess } from "child_process"

interface ClientSession {
  id: string
  username: string
  projectPath: string
  websocket: WebSocket
}

export class iOSServer {
  private server: http.Server
  private wss: WebSocket.Server
  private clients: Map<string, ClientSession> = new Map()
  private simulatorProcess: ChildProcess | null = null
  private buildProcess: ChildProcess | null = null

  constructor(port = 8080) {
    this.server = http.createServer()
    this.wss = new WebSocket.Server({ server: this.server, path: "/ios-vscode" })

    this.setupWebSocketHandlers()
    this.server.listen(port, () => {
      console.log(`iOS VS Code Server listening on port ${port}`)
    })
  }

  private setupWebSocketHandlers(): void {
    this.wss.on("connection", (ws: WebSocket) => {
      console.log("New client connected")

      ws.on("message", (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString())
          this.handleClientMessage(ws, message)
        } catch (error) {
          console.error("Failed to parse client message:", error)
          this.sendError(ws, "Invalid message format")
        }
      })

      ws.on("close", () => {
        console.log("Client disconnected")
        this.removeClient(ws)
      })

      ws.on("error", (error) => {
        console.error("WebSocket error:", error)
        this.removeClient(ws)
      })
    })
  }

  private async handleClientMessage(ws: WebSocket, message: any): Promise<void> {
    const { type, data, id } = message

    try {
      let response: any = {}

      switch (type) {
        case "authenticate":
          response = await this.handleAuthenticate(ws, data)
          break

        case "sync_file":
          response = await this.handleSyncFile(ws, data)
          break

        case "sync_project":
          response = await this.handleSyncProject(ws, data)
          break

        case "delete_file":
          response = await this.handleDeleteFile(ws, data)
          break

        case "get_devices":
          response = await this.handleGetDevices()
          break

        case "select_device":
          response = await this.handleSelectDevice(ws, data)
          break

        case "build_project":
          response = await this.handleBuildProject(ws)
          break

        case "run_project":
          response = await this.handleRunProject(ws)
          break

        case "simulator_input":
          response = await this.handleSimulatorInput(data)
          break

        case "deploy_device":
          response = await this.handleDeployDevice(ws)
          break

        case "execute_command":
          response = await this.handleExecuteCommand(data)
          break

        case "request_frame":
          response = await this.handleRequestFrame(ws, data)
          break

        default:
          throw new Error(`Unknown message type: ${type}`)
      }

      this.sendResponse(ws, type, response, id)
    } catch (error) {
      console.error(`Error handling ${type}:`, error)
      this.sendError(ws, error.message, id)
    }
  }

  private async handleAuthenticate(ws: WebSocket, data: any): Promise<any> {
    const sessionId = Math.random().toString(36).substr(2, 9)
    const projectPath = path.join(process.env.HOME || "/tmp", "ios-vscode-projects", data.username)

    // Create project directory if it doesn't exist
    if (!fs.existsSync(projectPath)) {
      fs.mkdirSync(projectPath, { recursive: true })
    }

    const session: ClientSession = {
      id: sessionId,
      username: data.username,
      projectPath,
      websocket: ws,
    }

    this.clients.set(sessionId, session)
    return { sessionId, projectPath }
  }

  private async handleSyncFile(ws: WebSocket, data: any): Promise<any> {
    const session = this.getClientSession(ws)
    if (!session) throw new Error("Not authenticated")

    const filePath = path.join(session.projectPath, data.path)
    const fileDir = path.dirname(filePath)

    // Create directory if it doesn't exist
    if (!fs.existsSync(fileDir)) {
      fs.mkdirSync(fileDir, { recursive: true })
    }

    // Write file content
    fs.writeFileSync(filePath, data.content, "utf8")

    console.log(`File synced: ${data.path}`)
    return { success: true }
  }

  private async handleSyncProject(ws: WebSocket, data: any): Promise<any> {
    const session = this.getClientSession(ws)
    if (!session) throw new Error("Not authenticated")

    let syncedCount = 0

    for (const file of data.files) {
      const filePath = path.join(session.projectPath, file.path)
      const fileDir = path.dirname(filePath)

      // Create directory if it doesn't exist
      if (!fs.existsSync(fileDir)) {
        fs.mkdirSync(fileDir, { recursive: true })
      }

      // Write file content
      fs.writeFileSync(filePath, file.content, "utf8")
      syncedCount++
    }

    console.log(`Project synced: ${syncedCount} files`)
    return { syncedCount }
  }

  private async handleDeleteFile(ws: WebSocket, data: any): Promise<any> {
    const session = this.getClientSession(ws)
    if (!session) throw new Error("Not authenticated")

    const filePath = path.join(session.projectPath, data.path)

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      console.log(`File deleted: ${data.path}`)
    }

    return { success: true }
  }

  private async handleGetDevices(): Promise<any> {
    return new Promise((resolve, reject) => {
      const process = spawn("xcrun", ["simctl", "list", "devices", "available"])
      let output = ""

      process.stdout.on("data", (data) => {
        output += data.toString()
      })

      process.on("close", (code) => {
        if (code === 0) {
          const devices = this.parseDeviceList(output)
          resolve({ devices })
        } else {
          reject(new Error("Failed to get device list"))
        }
      })
    })
  }

  private parseDeviceList(output: string): string[] {
    const devices: string[] = []
    const lines = output.split("\n")

    for (const line of lines) {
      if (line.includes("iPhone") || line.includes("iPad")) {
        const match = line.match(/^\s*(.+?)\s*\(/)
        if (match) {
          devices.push(match[1].trim())
        }
      }
    }

    return devices
  }

  private async handleSelectDevice(ws: WebSocket, data: any): Promise<any> {
    // Implementation for selecting target device
    console.log(`Selected device: ${data.device}`)
    return { success: true, device: data.device }
  }

  private async handleBuildProject(ws: WebSocket): Promise<any> {
    const session = this.getClientSession(ws)
    if (!session) throw new Error("Not authenticated")

    return new Promise((resolve, reject) => {
      // Kill existing build process
      if (this.buildProcess) {
        this.buildProcess.kill()
      }

      this.buildProcess = spawn("xcodebuild", ["-project", session.projectPath], {
        cwd: session.projectPath,
      })

      this.buildProcess.stdout?.on("data", (data) => {
        const output = data.toString()
        this.sendMessage(ws, "build_output", { output, show: false })
      })

      this.buildProcess.stderr?.on("data", (data) => {
        const output = data.toString()
        this.sendMessage(ws, "build_output", { output, show: true })
      })

      this.buildProcess.on("close", (code) => {
        if (code === 0) {
          resolve({ success: true })
        } else {
          reject(new Error(`Build failed with code ${code}`))
        }
      })
    })
  }

  private async handleRunProject(ws: WebSocket): Promise<any> {
    const session = this.getClientSession(ws)
    if (!session) throw new Error("Not authenticated")

    // Implementation for running project in simulator
    console.log("Running project in simulator")
    return { success: true }
  }

  private async handleSimulatorInput(data: any): Promise<any> {
    try {
      switch (data.type) {
        case "touch":
          await this.executeCommand(`xcrun simctl io booted tap ${data.x} ${data.y}`)
          break

        case "control":
          switch (data.action) {
            case "home":
              await this.executeCommand("xcrun simctl io booted pressButton home")
              break
            case "lock":
              await this.executeCommand("xcrun simctl io booted pressButton lock")
              break
            case "screenshot":
              const screenshotPath = path.join(
                process.env.HOME || "/tmp",
                "Desktop",
                `simulator_screenshot_${Date.now()}.png`,
              )
              await this.executeCommand(`xcrun simctl io booted screenshot "${screenshotPath}"`)
              break
            case "shake":
              await this.executeCommand("xcrun simctl io booted shake")
              break
          }
          break

        case "rotate":
          // Rotate simulator
          await this.executeCommand("xcrun simctl io booted rotate left")
          break
      }

      return { success: true }
    } catch (error) {
      console.error("Simulator input failed:", error)
      throw error
    }
  }

  private async handleRequestFrame(ws: WebSocket, data: any): Promise<any> {
    const session = this.getClientSession(ws)
    if (!session) throw new Error("Not authenticated")

    try {
      // Capture simulator screenshot
      const screenshotPath = path.join(session.projectPath, "simulator_frame.png")

      await this.executeCommand(`xcrun simctl io booted screenshot "${screenshotPath}"`)

      // Read and encode image
      const imageBuffer = fs.readFileSync(screenshotPath)
      const imageData = imageBuffer.toString("base64")

      // Clean up temporary file
      fs.unlinkSync(screenshotPath)

      // Send frame update to client
      this.sendMessage(ws, "simulator_frame", {
        imageData,
        width: 375, // Will be adjusted based on device
        height: 812,
        orientation: data.orientation || "portrait",
        timestamp: Date.now(),
      })

      return { success: true }
    } catch (error) {
      console.error("Failed to capture simulator frame:", error)
      throw error
    }
  }

  private async handleDeployDevice(ws: WebSocket): Promise<any> {
    // Implementation for deploying to physical device
    console.log("Deploying to device")
    return { success: true }
  }

  private async handleExecuteCommand(data: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const process = spawn("bash", ["-c", data.command])
      let output = ""
      let error = ""

      process.stdout.on("data", (data) => {
        output += data.toString()
      })

      process.stderr.on("data", (data) => {
        error += data.toString()
      })

      process.on("close", (code) => {
        if (code === 0) {
          resolve(output)
        } else {
          reject(new Error(error || `Command failed with code ${code}`))
        }
      })
    })
  }

  private getClientSession(ws: WebSocket): ClientSession | undefined {
    for (const session of this.clients.values()) {
      if (session.websocket === ws) {
        return session
      }
    }
    return undefined
  }

  private removeClient(ws: WebSocket): void {
    const session = this.getClientSession(ws)
    if (session) {
      this.clients.delete(session.id)
    }
  }

  private sendMessage(ws: WebSocket, type: string, data: any, id?: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, data, id }))
    }
  }

  private sendResponse(ws: WebSocket, type: string, data: any, id?: string): void {
    this.sendMessage(ws, `${type}_response`, data, id)
  }

  private sendError(ws: WebSocket, message: string, id?: string): void {
    this.sendMessage(ws, "error", { message }, id)
  }

  private async executeCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const process = spawn("bash", ["-c", command])
      let output = ""
      let error = ""

      process.stdout.on("data", (data) => {
        output += data.toString()
      })

      process.stderr.on("data", (data) => {
        error += data.toString()
      })

      process.on("close", (code) => {
        if (code === 0) {
          resolve(output)
        } else {
          reject(new Error(error || `Command failed with code ${code}`))
        }
      })
    })
  }
}

// Start the server
if (require.main === module) {
  new iOSServer(8080)
}
