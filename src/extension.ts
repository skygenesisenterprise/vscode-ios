import * as vscode from "vscode"
import { SimulatorProvider } from "./providers/simulatorProvider"
import { DeviceProvider } from "./providers/deviceProvider"
import { ServerConnection } from "./services/serverConnection"
import { SwiftLanguageService } from "./services/swiftLanguageService"
import { HotReloadService } from "./services/hotReloadService"
import { SimulatorService } from "./services/simulatorService"
import { DebugService } from "./services/debugService"
import { DeploymentService } from "./services/deploymentService"
import { registerHotReloadCommands } from "./commands/hotReloadCommands"

let serverConnection: ServerConnection
let swiftLanguageService: SwiftLanguageService
let hotReloadService: HotReloadService
let simulatorService: SimulatorService
let debugService: DebugService
let deploymentService: DeploymentService

export function activate(context: vscode.ExtensionContext) {
  console.log("iOS for VS Code extension is now active!")

  // Initialize services
  serverConnection = new ServerConnection()
  swiftLanguageService = new SwiftLanguageService(serverConnection)
  hotReloadService = new HotReloadService(serverConnection)
  simulatorService = new SimulatorService(serverConnection)
  debugService = new DebugService(serverConnection)
  deploymentService = new DeploymentService(serverConnection)

  // Register providers
  const simulatorProvider = new SimulatorProvider(serverConnection)
  const deviceProvider = new DeviceProvider(serverConnection)

  // Register tree data providers
  vscode.window.registerTreeDataProvider("ios-simulator", simulatorProvider)
  vscode.window.registerTreeDataProvider("ios-devices", deviceProvider)

  // Register hot reload commands
  registerHotReloadCommands(context, hotReloadService)

  // Register commands
  const connectCommand = vscode.commands.registerCommand("ios-vscode.connectServer", async () => {
    const config = vscode.workspace.getConfiguration("ios-vscode")
    const host = config.get<string>("serverHost")
    const port = config.get<number>("serverPort")
    const username = config.get<string>("sshUsername")

    if (!host || !username) {
      const hostInput = await vscode.window.showInputBox({
        prompt: "Enter macOS server hostname or IP address",
        value: host || "",
      })

      const usernameInput = await vscode.window.showInputBox({
        prompt: "Enter SSH username",
        value: username || "",
      })

      if (hostInput && usernameInput) {
        await config.update("serverHost", hostInput, vscode.ConfigurationTarget.Global)
        await config.update("sshUsername", usernameInput, vscode.ConfigurationTarget.Global)

        await serverConnection.connect(hostInput, port || 8080, usernameInput)
      }
    } else {
      await serverConnection.connect(host, port || 8080, username)
    }
  })

  const openSimulatorCommand = vscode.commands.registerCommand("ios-vscode.openSimulator", async () => {
    await simulatorService.openSimulator()
  })

  const selectDeviceCommand = vscode.commands.registerCommand(
    "ios-vscode.selectDevice",
    async (deviceName?: string) => {
      if (deviceName) {
        await simulatorService.selectDevice(deviceName)
      } else {
        const devices = simulatorService.getAvailableDevices()
        const selectedDevice = await vscode.window.showQuickPick(devices, {
          placeHolder: "Select target device",
        })

        if (selectedDevice) {
          await simulatorService.selectDevice(selectedDevice)
        }
      }
    },
  )

  const hotReloadCommand = vscode.commands.registerCommand("ios-vscode.hotReload", () => {
    hotReloadService.toggle()
  })

  const startDebuggingCommand = vscode.commands.registerCommand("ios-vscode.startDebugging", async () => {
    const target = await vscode.window.showQuickPick(["simulator", "device"], {
      placeHolder: "Select debug target",
    })

    if (target) {
      await debugService.startDebugging(target as "simulator" | "device")
    }
  })

  const addWatchCommand = vscode.commands.registerCommand("ios-vscode.addWatch", async () => {
    const expression = await vscode.window.showInputBox({
      prompt: "Enter watch expression",
      placeHolder: "variable name or expression",
    })

    if (expression) {
      await debugService.addWatchExpression(expression)
    }
  })

  const deployCommand = vscode.commands.registerCommand("ios-vscode.deployDevice", async () => {
    await deploymentService.refreshDeploymentTargets()
    const targets = deploymentService.getDeploymentTargets()

    const targetOptions = targets.map((target) => ({
      label: target.name,
      description: target.type,
      detail: target.status,
      target,
    }))

    const selected = await vscode.window.showQuickPick(targetOptions, {
      placeHolder: "Select deployment target",
    })

    if (selected) {
      await deploymentService.deployToTarget(selected.target.id)
    }
  })

  const deployAppStoreCommand = vscode.commands.registerCommand("ios-vscode.deployAppStore", async () => {
    const confirm = await vscode.window.showWarningMessage(
      "Deploy to App Store? This will build and upload your app to App Store Connect.",
      "Deploy",
      "Cancel",
    )

    if (confirm === "Deploy") {
      await deploymentService.deployToAppStore()
    }
  })

  const manageCertificatesCommand = vscode.commands.registerCommand("ios-vscode.manageCertificates", async () => {
    await deploymentService.refreshCertificates()
    const certificates = deploymentService.getCertificates()

    const panel = vscode.window.createWebviewPanel("certificates", "iOS Certificates", vscode.ViewColumn.One, {
      enableScripts: true,
    })

    panel.webview.html = getCertificatesWebview(certificates)
  })

  const buildConfigCommand = vscode.commands.registerCommand("ios-vscode.buildConfiguration", async () => {
    const configurations = deploymentService.getBuildConfigurations()

    const options = [
      { label: "Create New Configuration", action: "create" },
      ...configurations.map((config) => ({
        label: config.name,
        description: `${config.bundleId} v${config.version}`,
        action: "edit",
        config,
      })),
    ]

    const selected = await vscode.window.showQuickPick(options, {
      placeHolder: "Select build configuration",
    })

    if (selected) {
      if (selected.action === "create") {
        await deploymentService.createBuildConfiguration()
      } else {
        await deploymentService.editBuildConfiguration(selected.config.name)
      }
    }
  })

  // Register language features
  const diagnosticCollection = vscode.languages.createDiagnosticCollection("swift")
  context.subscriptions.push(diagnosticCollection)

  const documentChangeListener = vscode.workspace.onDidChangeTextDocument(async (event) => {
    if (event.document.languageId === "swift") {
      const diagnostics = await swiftLanguageService.provideDiagnostics(event.document)
      diagnosticCollection.set(event.document.uri, diagnostics)
    }
  })

  const documentOpenListener = vscode.workspace.onDidOpenTextDocument(async (document) => {
    if (document.languageId === "swift") {
      const diagnostics = await swiftLanguageService.provideDiagnostics(document)
      diagnosticCollection.set(document.uri, diagnostics)
    }
  })

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider("swift", swiftLanguageService, ".", "@"),
    vscode.languages.registerHoverProvider("swift", swiftLanguageService),
    vscode.languages.registerDefinitionProvider("swift", swiftLanguageService),
    documentChangeListener,
    documentOpenListener,
  )

  // Add services to subscriptions for proper cleanup
  context.subscriptions.push(
    {
      dispose: () => hotReloadService.dispose(),
    },
    connectCommand,
    openSimulatorCommand,
    selectDeviceCommand,
    hotReloadCommand,
    startDebuggingCommand,
    addWatchCommand,
    deployCommand,
    deployAppStoreCommand,
    manageCertificatesCommand,
    buildConfigCommand,
  )

  // Set context for when extension is connected
  vscode.commands.executeCommand("setContext", "ios-vscode.connected", false)
}

function getCertificatesWebview(certificates: any[]): string {
  const certRows = certificates
    .map(
      (cert) => `
    <tr class="${cert.isValid ? "valid" : "expired"}">
      <td>${cert.name}</td>
      <td>${cert.type}</td>
      <td>${cert.expirationDate.toLocaleDateString()}</td>
      <td>${cert.isValid ? "Valid" : "Expired"}</td>
    </tr>
  `,
    )
    .join("")

  return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>iOS Certificates</title>
        <style>
            body {
                font-family: var(--vscode-font-family);
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                padding: 20px;
            }
            
            table {
                width: 100%;
                border-collapse: collapse;
                margin-top: 20px;
            }
            
            th, td {
                padding: 12px;
                text-align: left;
                border-bottom: 1px solid var(--vscode-panel-border);
            }
            
            th {
                background-color: var(--vscode-editor-inactiveSelectionBackground);
                font-weight: 600;
            }
            
            .valid {
                background-color: rgba(0, 255, 0, 0.1);
            }
            
            .expired {
                background-color: rgba(255, 0, 0, 0.1);
            }
        </style>
    </head>
    <body>
        <h1>iOS Certificates</h1>
        
        <table>
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Expiration Date</th>
                    <th>Status</th>
                </tr>
            </thead>
            <tbody>
                ${certRows}
            </tbody>
        </table>
    </body>
    </html>`
}

export function deactivate() {
  if (serverConnection) {
    serverConnection.disconnect()
  }
  if (hotReloadService) {
    hotReloadService.dispose()
  }
}
