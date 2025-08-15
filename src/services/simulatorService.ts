import * as vscode from "vscode"
import type { ServerConnection } from "./serverConnection"

export interface DeviceSpec {
  name: string
  width: number
  height: number
  scale: number
  cornerRadius: number
  hasNotch: boolean
  homeIndicator: boolean
}

export interface SimulatorFrame {
  imageData: string // Base64 encoded image
  width: number
  height: number
  orientation: "portrait" | "landscape"
  timestamp: number
}

export class SimulatorService {
  private currentDevice: DeviceSpec
  private currentOrientation: "portrait" | "landscape" = "portrait"
  private simulatorPanel: vscode.WebviewPanel | null = null
  private frameUpdateInterval: NodeJS.Timeout | null = null
  private touchEnabled = true

  private deviceSpecs: Map<string, DeviceSpec> = new Map([
    [
      "iPhone 15 Pro",
      {
        name: "iPhone 15 Pro",
        width: 393,
        height: 852,
        scale: 3,
        cornerRadius: 47,
        hasNotch: true,
        homeIndicator: true,
      },
    ],
    [
      "iPhone 15",
      {
        name: "iPhone 15",
        width: 393,
        height: 852,
        scale: 3,
        cornerRadius: 47,
        hasNotch: true,
        homeIndicator: true,
      },
    ],
    [
      "iPhone SE",
      {
        name: "iPhone SE",
        width: 375,
        height: 667,
        scale: 2,
        cornerRadius: 0,
        hasNotch: false,
        homeIndicator: false,
      },
    ],
    [
      "iPad Pro 12.9",
      {
        name: "iPad Pro 12.9",
        width: 1024,
        height: 1366,
        scale: 2,
        cornerRadius: 18,
        hasNotch: false,
        homeIndicator: true,
      },
    ],
    [
      "iPad Air",
      {
        name: "iPad Air",
        width: 820,
        height: 1180,
        scale: 2,
        cornerRadius: 18,
        hasNotch: false,
        homeIndicator: true,
      },
    ],
  ])

  constructor(private serverConnection: ServerConnection) {
    this.currentDevice = this.deviceSpecs.get("iPhone 15 Pro")!
    this.setupMessageHandlers()
  }

  private setupMessageHandlers(): void {
    // Listen for simulator frame updates from server
    vscode.commands.registerCommand("ios-vscode.simulatorFrameUpdate", (frameData: SimulatorFrame) => {
      this.handleFrameUpdate(frameData)
    })
  }

  async openSimulator(): Promise<void> {
    if (!this.serverConnection.isConnected()) {
      vscode.window.showErrorMessage("Please connect to macOS server first")
      return
    }

    // Create or show existing simulator panel
    if (this.simulatorPanel) {
      this.simulatorPanel.reveal(vscode.ViewColumn.Two)
      return
    }

    this.simulatorPanel = vscode.window.createWebviewPanel("ios-simulator", "iOS Simulator", vscode.ViewColumn.Two, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    })

    // Set webview content
    this.simulatorPanel.webview.html = this.getSimulatorWebviewContent()

    // Handle messages from webview
    this.simulatorPanel.webview.onDidReceiveMessage((message) => {
      this.handleWebviewMessage(message)
    })

    // Handle panel disposal
    this.simulatorPanel.onDidDispose(() => {
      this.simulatorPanel = null
      if (this.frameUpdateInterval) {
        clearInterval(this.frameUpdateInterval)
        this.frameUpdateInterval = null
      }
    })

    // Start requesting frames from server
    await this.startFrameUpdates()
  }

  private async startFrameUpdates(): Promise<void> {
    // Request initial frame
    await this.requestFrame()

    // Set up periodic frame updates (30 FPS)
    this.frameUpdateInterval = setInterval(async () => {
      if (this.serverConnection.isConnected()) {
        await this.requestFrame()
      }
    }, 1000 / 30)
  }

  private async requestFrame(): Promise<void> {
    try {
      await this.serverConnection.sendMessage({
        type: "request_frame",
        data: {
          device: this.currentDevice.name,
          orientation: this.currentOrientation,
        },
      })
    } catch (error) {
      console.error("Failed to request simulator frame:", error)
    }
  }

  private handleFrameUpdate(frameData: SimulatorFrame): void {
    if (this.simulatorPanel) {
      this.simulatorPanel.webview.postMessage({
        command: "updateFrame",
        data: frameData,
      })
    }
  }

  private async handleWebviewMessage(message: any): Promise<void> {
    switch (message.command) {
      case "touch":
        await this.handleTouch(message.data)
        break

      case "deviceControl":
        await this.handleDeviceControl(message.data)
        break

      case "selectDevice":
        await this.selectDevice(message.data.device)
        break

      case "rotate":
        await this.rotateDevice()
        break

      case "ready":
        // Webview is ready, send initial device info
        this.simulatorPanel?.webview.postMessage({
          command: "deviceInfo",
          data: {
            device: this.currentDevice,
            orientation: this.currentOrientation,
            availableDevices: Array.from(this.deviceSpecs.keys()),
          },
        })
        break
    }
  }

  private async handleTouch(touchData: any): Promise<void> {
    if (!this.touchEnabled) return

    try {
      // Convert webview coordinates to simulator coordinates
      const simulatorCoords = this.convertToSimulatorCoordinates(touchData.x, touchData.y)

      await this.serverConnection.sendSimulatorInput({
        type: "touch",
        x: simulatorCoords.x,
        y: simulatorCoords.y,
        pressure: touchData.pressure || 1.0,
        touchType: touchData.touchType || "tap",
      })
    } catch (error) {
      console.error("Failed to send touch input:", error)
    }
  }

  private convertToSimulatorCoordinates(webX: number, webY: number): { x: number; y: number } {
    // Convert from webview coordinates to actual simulator coordinates
    // This accounts for device scaling and orientation
    const deviceWidth = this.currentOrientation === "portrait" ? this.currentDevice.width : this.currentDevice.height
    const deviceHeight = this.currentOrientation === "portrait" ? this.currentDevice.height : this.currentDevice.width

    return {
      x: Math.round((webX / 375) * deviceWidth), // 375 is the webview width
      y: Math.round((webY / 812) * deviceHeight), // 812 is the webview height
    }
  }

  private async handleDeviceControl(controlData: any): Promise<void> {
    try {
      await this.serverConnection.sendSimulatorInput({
        type: "control",
        action: controlData.action,
      })

      // Show feedback for certain actions
      switch (controlData.action) {
        case "screenshot":
          vscode.window.showInformationMessage("Screenshot taken")
          break
        case "home":
          vscode.window.showInformationMessage("Home button pressed")
          break
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Control action failed: ${error}`)
    }
  }

  async selectDevice(deviceName: string): Promise<void> {
    const deviceSpec = this.deviceSpecs.get(deviceName)
    if (!deviceSpec) {
      vscode.window.showErrorMessage(`Unknown device: ${deviceName}`)
      return
    }

    this.currentDevice = deviceSpec
    await this.serverConnection.selectDevice(deviceName)

    // Update webview with new device info
    if (this.simulatorPanel) {
      this.simulatorPanel.webview.postMessage({
        command: "deviceChanged",
        data: {
          device: this.currentDevice,
          orientation: this.currentOrientation,
        },
      })
    }

    vscode.window.showInformationMessage(`Selected device: ${deviceName}`)
  }

  private async rotateDevice(): Promise<void> {
    this.currentOrientation = this.currentOrientation === "portrait" ? "landscape" : "portrait"

    try {
      await this.serverConnection.sendSimulatorInput({
        type: "rotate",
        orientation: this.currentOrientation,
      })

      // Update webview
      if (this.simulatorPanel) {
        this.simulatorPanel.webview.postMessage({
          command: "orientationChanged",
          data: {
            orientation: this.currentOrientation,
            device: this.currentDevice,
          },
        })
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Rotation failed: ${error}`)
    }
  }

  private getSimulatorWebviewContent(): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>iOS Simulator</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            
            body {
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                font-family: var(--vscode-font-family);
                padding: 20px;
                overflow-x: auto;
            }
            
            .simulator-container {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 20px;
                min-height: 100vh;
            }
            
            .controls-bar {
                display: flex;
                gap: 10px;
                flex-wrap: wrap;
                align-items: center;
                padding: 15px;
                background: var(--vscode-editor-inactiveSelectionBackground);
                border-radius: 8px;
                width: 100%;
                max-width: 800px;
            }
            
            .device-selector {
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
                padding: 6px 12px;
                border-radius: 4px;
                font-size: 14px;
            }
            
            .control-button {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 8px 16px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                transition: background-color 0.2s;
            }
            
            .control-button:hover {
                background: var(--vscode-button-hoverBackground);
            }
            
            .control-button:active {
                transform: translateY(1px);
            }
            
            .status-indicator {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 12px;
                background: var(--vscode-textCodeBlock-background);
                border-radius: 4px;
                font-size: 12px;
            }
            
            .status-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #4CAF50;
                animation: pulse 2s infinite;
            }
            
            @keyframes pulse {
                0% { opacity: 1; }
                50% { opacity: 0.5; }
                100% { opacity: 1; }
            }
            
            .device-frame {
                position: relative;
                background: #1a1a1a;
                border-radius: 30px;
                padding: 20px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.4);
                transition: all 0.3s ease;
            }
            
            .device-frame.landscape {
                transform: rotate(90deg);
                margin: 100px 0;
            }
            
            .simulator-screen {
                position: relative;
                background: #000;
                border-radius: 25px;
                overflow: hidden;
                cursor: crosshair;
                transition: all 0.3s ease;
            }
            
            .simulator-canvas {
                width: 100%;
                height: 100%;
                display: block;
                background: #000;
            }
            
            .placeholder-content {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                text-align: center;
                color: #666;
                font-size: 16px;
                pointer-events: none;
            }
            
            .notch {
                position: absolute;
                top: 0;
                left: 50%;
                transform: translateX(-50%);
                width: 150px;
                height: 30px;
                background: #1a1a1a;
                border-radius: 0 0 15px 15px;
                z-index: 10;
            }
            
            .home-indicator {
                position: absolute;
                bottom: 8px;
                left: 50%;
                transform: translateX(-50%);
                width: 134px;
                height: 5px;
                background: rgba(255,255,255,0.3);
                border-radius: 3px;
                z-index: 10;
            }
            
            .touch-feedback {
                position: absolute;
                width: 40px;
                height: 40px;
                border: 2px solid #007ACC;
                border-radius: 50%;
                pointer-events: none;
                animation: touchRipple 0.3s ease-out;
                z-index: 20;
            }
            
            @keyframes touchRipple {
                0% {
                    transform: scale(0);
                    opacity: 1;
                }
                100% {
                    transform: scale(1);
                    opacity: 0;
                }
            }
            
            .performance-stats {
                position: fixed;
                top: 10px;
                right: 10px;
                background: var(--vscode-textCodeBlock-background);
                padding: 8px 12px;
                border-radius: 4px;
                font-size: 11px;
                font-family: monospace;
                opacity: 0.7;
            }
        </style>
    </head>
    <body>
        <div class="simulator-container">
            <div class="controls-bar">
                <select class="device-selector" id="deviceSelector">
                    <option value="">Select Device...</option>
                </select>
                
                <button class="control-button" onclick="sendControl('home')">Home</button>
                <button class="control-button" onclick="sendControl('lock')">Lock</button>
                <button class="control-button" onclick="rotateDevice()">Rotate</button>
                <button class="control-button" onclick="sendControl('screenshot')">Screenshot</button>
                <button class="control-button" onclick="sendControl('shake')">Shake</button>
                
                <div class="status-indicator">
                    <div class="status-dot"></div>
                    <span id="statusText">Connected</span>
                </div>
            </div>
            
            <div class="device-frame" id="deviceFrame">
                <div class="simulator-screen" id="simulatorScreen">
                    <canvas class="simulator-canvas" id="simulatorCanvas"></canvas>
                    <div class="placeholder-content" id="placeholderContent">
                        <div>iOS Simulator</div>
                        <div style="font-size: 12px; margin-top: 8px;">Waiting for connection...</div>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="performance-stats" id="performanceStats">
            FPS: <span id="fpsCounter">0</span> | 
            Latency: <span id="latencyCounter">0ms</span>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            let currentDevice = null;
            let currentOrientation = 'portrait';
            let canvas = null;
            let ctx = null;
            let frameCount = 0;
            let lastFrameTime = Date.now();
            
            // Initialize
            document.addEventListener('DOMContentLoaded', () => {
                canvas = document.getElementById('simulatorCanvas');
                ctx = canvas.getContext('2d');
                setupEventListeners();
                
                // Notify extension that webview is ready
                vscode.postMessage({ command: 'ready' });
            });
            
            function setupEventListeners() {
                const screen = document.getElementById('simulatorScreen');
                const deviceSelector = document.getElementById('deviceSelector');
                
                // Touch/click events
                screen.addEventListener('mousedown', handleMouseDown);
                screen.addEventListener('touchstart', handleTouchStart, { passive: false });
                
                // Device selection
                deviceSelector.addEventListener('change', (e) => {
                    if (e.target.value) {
                        vscode.postMessage({
                            command: 'selectDevice',
                            data: { device: e.target.value }
                        });
                    }
                });
                
                // Prevent context menu
                screen.addEventListener('contextmenu', (e) => e.preventDefault());
            }
            
            function handleMouseDown(e) {
                if (e.button !== 0) return; // Only left click
                
                const rect = e.target.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                
                sendTouch(x, y, 'tap');
                showTouchFeedback(x, y);
            }
            
            function handleTouchStart(e) {
                e.preventDefault();
                
                const touch = e.touches[0];
                const rect = e.target.getBoundingClientRect();
                const x = touch.clientX - rect.left;
                const y = touch.clientY - rect.top;
                
                sendTouch(x, y, 'tap');
                showTouchFeedback(x, y);
            }
            
            function sendTouch(x, y, touchType = 'tap') {
                vscode.postMessage({
                    command: 'touch',
                    data: { x, y, touchType, pressure: 1.0 }
                });
            }
            
            function showTouchFeedback(x, y) {
                const feedback = document.createElement('div');
                feedback.className = 'touch-feedback';
                feedback.style.left = (x - 20) + 'px';
                feedback.style.top = (y - 20) + 'px';
                
                document.getElementById('simulatorScreen').appendChild(feedback);
                
                setTimeout(() => {
                    feedback.remove();
                }, 300);
            }
            
            function sendControl(action) {
                vscode.postMessage({
                    command: 'deviceControl',
                    data: { action }
                });
            }
            
            function rotateDevice() {
                vscode.postMessage({ command: 'rotate' });
            }
            
            // Handle messages from extension
            window.addEventListener('message', (event) => {
                const message = event.data;
                
                switch (message.command) {
                    case 'deviceInfo':
                        handleDeviceInfo(message.data);
                        break;
                        
                    case 'deviceChanged':
                        handleDeviceChanged(message.data);
                        break;
                        
                    case 'orientationChanged':
                        handleOrientationChanged(message.data);
                        break;
                        
                    case 'updateFrame':
                        handleFrameUpdate(message.data);
                        break;
                }
            });
            
            function handleDeviceInfo(data) {
                currentDevice = data.device;
                currentOrientation = data.orientation;
                
                // Populate device selector
                const selector = document.getElementById('deviceSelector');
                selector.innerHTML = '<option value="">Select Device...</option>';
                
                data.availableDevices.forEach(device => {
                    const option = document.createElement('option');
                    option.value = device;
                    option.textContent = device;
                    option.selected = device === currentDevice.name;
                    selector.appendChild(option);
                });
                
                updateDeviceFrame();
            }
            
            function handleDeviceChanged(data) {
                currentDevice = data.device;
                currentOrientation = data.orientation;
                updateDeviceFrame();
            }
            
            function handleOrientationChanged(data) {
                currentOrientation = data.orientation;
                updateDeviceFrame();
            }
            
            function updateDeviceFrame() {
                if (!currentDevice) return;
                
                const frame = document.getElementById('deviceFrame');
                const screen = document.getElementById('simulatorScreen');
                
                // Update frame class for orientation
                frame.className = 'device-frame' + (currentOrientation === 'landscape' ? ' landscape' : '');
                
                // Update screen dimensions
                const width = currentOrientation === 'portrait' ? currentDevice.width : currentDevice.height;
                const height = currentOrientation === 'portrait' ? currentDevice.height : currentDevice.width;
                
                // Scale to fit webview (max 375px width)
                const scale = Math.min(375 / width, 812 / height);
                const scaledWidth = width * scale;
                const scaledHeight = height * scale;
                
                screen.style.width = scaledWidth + 'px';
                screen.style.height = scaledHeight + 'px';
                screen.style.borderRadius = (currentDevice.cornerRadius * scale) + 'px';
                
                // Update canvas
                canvas.width = scaledWidth;
                canvas.height = scaledHeight;
                
                // Add device-specific elements
                updateDeviceElements(scale);
            }
            
            function updateDeviceElements(scale) {
                // Remove existing elements
                document.querySelectorAll('.notch, .home-indicator').forEach(el => el.remove());
                
                const screen = document.getElementById('simulatorScreen');
                
                // Add notch for devices that have it
                if (currentDevice.hasNotch && currentOrientation === 'portrait') {
                    const notch = document.createElement('div');
                    notch.className = 'notch';
                    notch.style.width = (150 * scale) + 'px';
                    notch.style.height = (30 * scale) + 'px';
                    screen.appendChild(notch);
                }
                
                // Add home indicator for devices that have it
                if (currentDevice.homeIndicator) {
                    const indicator = document.createElement('div');
                    indicator.className = 'home-indicator';
                    indicator.style.width = (134 * scale) + 'px';
                    indicator.style.height = (5 * scale) + 'px';
                    screen.appendChild(indicator);
                }
            }
            
            function handleFrameUpdate(frameData) {
                if (!ctx || !frameData.imageData) return;
                
                // Hide placeholder
                document.getElementById('placeholderContent').style.display = 'none';
                
                // Create image from base64 data
                const img = new Image();
                img.onload = () => {
                    // Clear canvas and draw new frame
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    
                    // Update performance stats
                    updatePerformanceStats(frameData.timestamp);
                };
                img.src = 'data:image/png;base64,' + frameData.imageData;
            }
            
            function updatePerformanceStats(timestamp) {
                frameCount++;
                const now = Date.now();
                const deltaTime = now - lastFrameTime;
                
                if (deltaTime >= 1000) {
                    const fps = Math.round((frameCount * 1000) / deltaTime);
                    document.getElementById('fpsCounter').textContent = fps;
                    
                    frameCount = 0;
                    lastFrameTime = now;
                }
                
                // Calculate latency (rough estimate)
                const latency = now - timestamp;
                document.getElementById('latencyCounter').textContent = latency + 'ms';
            }
        </script>
    </body>
    </html>`
  }

  getAvailableDevices(): string[] {
    return Array.from(this.deviceSpecs.keys())
  }

  getCurrentDevice(): DeviceSpec {
    return this.currentDevice
  }

  getCurrentOrientation(): "portrait" | "landscape" {
    return this.currentOrientation
  }
}
