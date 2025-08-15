import * as vscode from "vscode"
import type { ServerConnection } from "./serverConnection"

export interface DeploymentTarget {
  id: string
  name: string
  type: "simulator" | "device" | "testflight" | "appstore"
  status: "available" | "unavailable" | "deploying"
  details?: any
}

export interface Certificate {
  id: string
  name: string
  type: "development" | "distribution"
  expirationDate: Date
  isValid: boolean
}

export interface ProvisioningProfile {
  id: string
  name: string
  appId: string
  type: "development" | "adhoc" | "appstore"
  expirationDate: Date
  devices: string[]
  isValid: boolean
}

export interface BuildConfiguration {
  name: string
  bundleId: string
  version: string
  buildNumber: string
  signingIdentity: string
  provisioningProfile: string
  buildSettings: Record<string, any>
}

export class DeploymentService {
  private deploymentTargets: Map<string, DeploymentTarget> = new Map()
  private certificates: Certificate[] = []
  private provisioningProfiles: ProvisioningProfile[] = []
  private buildConfigurations: BuildConfiguration[] = []
  private outputChannel: vscode.OutputChannel

  constructor(private serverConnection: ServerConnection) {
    this.outputChannel = vscode.window.createOutputChannel("iOS Deployment")
    this.setupDefaultConfigurations()
  }

  private setupDefaultConfigurations(): void {
    this.buildConfigurations = [
      {
        name: "Debug",
        bundleId: "com.example.app",
        version: "1.0.0",
        buildNumber: "1",
        signingIdentity: "iPhone Developer",
        provisioningProfile: "Automatic",
        buildSettings: {
          SWIFT_OPTIMIZATION_LEVEL: "-Onone",
          DEBUG_INFORMATION_FORMAT: "dwarf-with-dsym",
        },
      },
      {
        name: "Release",
        bundleId: "com.example.app",
        version: "1.0.0",
        buildNumber: "1",
        signingIdentity: "iPhone Distribution",
        provisioningProfile: "Automatic",
        buildSettings: {
          SWIFT_OPTIMIZATION_LEVEL: "-O",
          DEBUG_INFORMATION_FORMAT: "dwarf-with-dsym",
        },
      },
    ]
  }

  async refreshDeploymentTargets(): Promise<void> {
    if (!this.serverConnection.isConnected()) {
      return
    }

    try {
      // Get simulators
      const simulators = await this.serverConnection.sendMessage({
        type: "get_simulators",
        data: {},
      })

      simulators.forEach((sim: any) => {
        this.deploymentTargets.set(sim.id, {
          id: sim.id,
          name: sim.name,
          type: "simulator",
          status: sim.state === "Booted" ? "available" : "unavailable",
          details: sim,
        })
      })

      // Get physical devices
      const devices = await this.serverConnection.sendMessage({
        type: "get_physical_devices",
        data: {},
      })

      devices.forEach((device: any) => {
        this.deploymentTargets.set(device.id, {
          id: device.id,
          name: device.name,
          type: "device",
          status: device.connected ? "available" : "unavailable",
          details: device,
        })
      })

      this.outputChannel.appendLine(`Found ${this.deploymentTargets.size} deployment targets`)
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to refresh deployment targets: ${error}`)
    }
  }

  async refreshCertificates(): Promise<void> {
    if (!this.serverConnection.isConnected()) {
      return
    }

    try {
      const certs = await this.serverConnection.sendMessage({
        type: "get_certificates",
        data: {},
      })

      this.certificates = certs.map((cert: any) => ({
        id: cert.id,
        name: cert.name,
        type: cert.type,
        expirationDate: new Date(cert.expirationDate),
        isValid: new Date(cert.expirationDate) > new Date(),
      }))

      this.outputChannel.appendLine(`Found ${this.certificates.length} certificates`)
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to refresh certificates: ${error}`)
    }
  }

  async refreshProvisioningProfiles(): Promise<void> {
    if (!this.serverConnection.isConnected()) {
      return
    }

    try {
      const profiles = await this.serverConnection.sendMessage({
        type: "get_provisioning_profiles",
        data: {},
      })

      this.provisioningProfiles = profiles.map((profile: any) => ({
        id: profile.id,
        name: profile.name,
        appId: profile.appId,
        type: profile.type,
        expirationDate: new Date(profile.expirationDate),
        devices: profile.devices || [],
        isValid: new Date(profile.expirationDate) > new Date(),
      }))

      this.outputChannel.appendLine(`Found ${this.provisioningProfiles.length} provisioning profiles`)
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to refresh provisioning profiles: ${error}`)
    }
  }

  async deployToTarget(targetId: string, configuration = "Debug"): Promise<void> {
    const target = this.deploymentTargets.get(targetId)
    if (!target) {
      vscode.window.showErrorMessage(`Deployment target not found: ${targetId}`)
      return
    }

    if (target.status !== "available") {
      vscode.window.showErrorMessage(`Deployment target is not available: ${target.name}`)
      return
    }

    // Update target status
    target.status = "deploying"

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Deploying to ${target.name}...`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ increment: 0, message: "Building project..." })

          // Build project
          await this.serverConnection.sendMessage({
            type: "build_for_deployment",
            data: {
              configuration,
              target: target.type,
              targetId: target.id,
            },
          })

          progress.report({ increment: 50, message: "Installing on device..." })

          // Deploy to target
          await this.serverConnection.sendMessage({
            type: "deploy_to_target",
            data: {
              targetId: target.id,
              configuration,
            },
          })

          progress.report({ increment: 100, message: "Deployment complete" })
        },
      )

      target.status = "available"
      vscode.window.showInformationMessage(`Successfully deployed to ${target.name}`)
      this.outputChannel.appendLine(`Deployment successful: ${target.name}`)
    } catch (error) {
      target.status = "available"
      vscode.window.showErrorMessage(`Deployment failed: ${error}`)
      this.outputChannel.appendLine(`Deployment failed: ${error}`)
    }
  }

  async deployToAppStore(configuration = "Release"): Promise<void> {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Preparing App Store deployment...",
          cancellable: false,
        },
        async (progress) => {
          progress.report({ increment: 0, message: "Validating configuration..." })

          // Validate App Store configuration
          await this.validateAppStoreConfiguration(configuration)

          progress.report({ increment: 25, message: "Building for App Store..." })

          // Build for App Store
          await this.serverConnection.sendMessage({
            type: "build_for_appstore",
            data: { configuration },
          })

          progress.report({ increment: 75, message: "Uploading to App Store Connect..." })

          // Upload to App Store
          await this.serverConnection.sendMessage({
            type: "upload_to_appstore",
            data: { configuration },
          })

          progress.report({ increment: 100, message: "Upload complete" })
        },
      )

      vscode.window.showInformationMessage("App successfully uploaded to App Store Connect")
      this.outputChannel.appendLine("App Store deployment successful")
    } catch (error) {
      vscode.window.showErrorMessage(`App Store deployment failed: ${error}`)
      this.outputChannel.appendLine(`App Store deployment failed: ${error}`)
    }
  }

  private async validateAppStoreConfiguration(configuration: string): Promise<void> {
    const config = this.buildConfigurations.find((c) => c.name === configuration)
    if (!config) {
      throw new Error(`Configuration not found: ${configuration}`)
    }

    // Check for valid distribution certificate
    const distributionCerts = this.certificates.filter((cert) => cert.type === "distribution" && cert.isValid)
    if (distributionCerts.length === 0) {
      throw new Error("No valid distribution certificate found")
    }

    // Check for valid App Store provisioning profile
    const appStoreProfiles = this.provisioningProfiles.filter(
      (profile) => profile.type === "appstore" && profile.isValid && profile.appId === config.bundleId,
    )
    if (appStoreProfiles.length === 0) {
      throw new Error("No valid App Store provisioning profile found")
    }
  }

  async createBuildConfiguration(): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: "Enter configuration name",
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return "Configuration name is required"
        }
        if (this.buildConfigurations.some((c) => c.name === value)) {
          return "Configuration name already exists"
        }
        return null
      },
    })

    if (!name) return

    const bundleId = await vscode.window.showInputBox({
      prompt: "Enter bundle identifier",
      value: "com.example.app",
      validateInput: (value) => {
        if (!value || !value.match(/^[a-zA-Z0-9.-]+$/)) {
          return "Invalid bundle identifier format"
        }
        return null
      },
    })

    if (!bundleId) return

    const version = await vscode.window.showInputBox({
      prompt: "Enter version",
      value: "1.0.0",
    })

    if (!version) return

    const buildNumber = await vscode.window.showInputBox({
      prompt: "Enter build number",
      value: "1",
    })

    if (!buildNumber) return

    const newConfig: BuildConfiguration = {
      name,
      bundleId,
      version,
      buildNumber,
      signingIdentity: "iPhone Developer",
      provisioningProfile: "Automatic",
      buildSettings: {},
    }

    this.buildConfigurations.push(newConfig)
    vscode.window.showInformationMessage(`Build configuration created: ${name}`)
  }

  async editBuildConfiguration(configName: string): Promise<void> {
    const config = this.buildConfigurations.find((c) => c.name === configName)
    if (!config) {
      vscode.window.showErrorMessage(`Configuration not found: ${configName}`)
      return
    }

    // Create webview for configuration editing
    const panel = vscode.window.createWebviewPanel(
      "build-config",
      `Edit Configuration: ${configName}`,
      vscode.ViewColumn.One,
      { enableScripts: true },
    )

    panel.webview.html = this.getBuildConfigurationWebview(config)

    panel.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case "save":
          Object.assign(config, message.data)
          vscode.window.showInformationMessage(`Configuration saved: ${configName}`)
          panel.dispose()
          break
        case "cancel":
          panel.dispose()
          break
      }
    })
  }

  private getBuildConfigurationWebview(config: BuildConfiguration): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Build Configuration</title>
        <style>
            body {
                font-family: var(--vscode-font-family);
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                padding: 20px;
            }
            
            .form-group {
                margin-bottom: 20px;
            }
            
            label {
                display: block;
                margin-bottom: 5px;
                font-weight: 600;
            }
            
            input, select {
                width: 100%;
                padding: 8px 12px;
                background-color: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
                border-radius: 4px;
                font-size: 14px;
            }
            
            .button-group {
                display: flex;
                gap: 10px;
                margin-top: 30px;
            }
            
            button {
                padding: 10px 20px;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
            }
            
            .primary {
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
            }
            
            .secondary {
                background-color: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
            }
        </style>
    </head>
    <body>
        <h1>Build Configuration: ${config.name}</h1>
        
        <form id="configForm">
            <div class="form-group">
                <label for="bundleId">Bundle Identifier</label>
                <input type="text" id="bundleId" value="${config.bundleId}" required>
            </div>
            
            <div class="form-group">
                <label for="version">Version</label>
                <input type="text" id="version" value="${config.version}" required>
            </div>
            
            <div class="form-group">
                <label for="buildNumber">Build Number</label>
                <input type="text" id="buildNumber" value="${config.buildNumber}" required>
            </div>
            
            <div class="form-group">
                <label for="signingIdentity">Signing Identity</label>
                <select id="signingIdentity">
                    <option value="iPhone Developer" ${config.signingIdentity === "iPhone Developer" ? "selected" : ""}>iPhone Developer</option>
                    <option value="iPhone Distribution" ${config.signingIdentity === "iPhone Distribution" ? "selected" : ""}>iPhone Distribution</option>
                </select>
            </div>
            
            <div class="form-group">
                <label for="provisioningProfile">Provisioning Profile</label>
                <input type="text" id="provisioningProfile" value="${config.provisioningProfile}">
            </div>
            
            <div class="button-group">
                <button type="button" class="primary" onclick="saveConfiguration()">Save</button>
                <button type="button" class="secondary" onclick="cancelEdit()">Cancel</button>
            </div>
        </form>

        <script>
            const vscode = acquireVsCodeApi();
            
            function saveConfiguration() {
                const formData = {
                    bundleId: document.getElementById('bundleId').value,
                    version: document.getElementById('version').value,
                    buildNumber: document.getElementById('buildNumber').value,
                    signingIdentity: document.getElementById('signingIdentity').value,
                    provisioningProfile: document.getElementById('provisioningProfile').value,
                };
                
                vscode.postMessage({
                    command: 'save',
                    data: formData
                });
            }
            
            function cancelEdit() {
                vscode.postMessage({ command: 'cancel' });
            }
        </script>
    </body>
    </html>`
  }

  getDeploymentTargets(): DeploymentTarget[] {
    return Array.from(this.deploymentTargets.values())
  }

  getCertificates(): Certificate[] {
    return [...this.certificates]
  }

  getProvisioningProfiles(): ProvisioningProfile[] {
    return [...this.provisioningProfiles]
  }

  getBuildConfigurations(): BuildConfiguration[] {
    return [...this.buildConfigurations]
  }
}
