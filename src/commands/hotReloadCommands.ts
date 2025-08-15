import * as vscode from "vscode"
import type { HotReloadService } from "../services/hotReloadService"

export function registerHotReloadCommands(context: vscode.ExtensionContext, hotReloadService: HotReloadService): void {
  // Toggle hot reload
  const toggleCommand = vscode.commands.registerCommand("ios-vscode.hotReloadToggle", () => {
    hotReloadService.toggle()
  })

  // Force reload
  const forceReloadCommand = vscode.commands.registerCommand("ios-vscode.hotReloadForce", async () => {
    await hotReloadService.forceReload()
  })

  // Show hot reload history
  const historyCommand = vscode.commands.registerCommand("ios-vscode.hotReloadHistory", () => {
    const history = hotReloadService.getReloadHistory()
    const panel = vscode.window.createWebviewPanel("hot-reload-history", "Hot Reload History", vscode.ViewColumn.One, {
      enableScripts: true,
    })

    panel.webview.html = getHotReloadHistoryWebview(history)
  })

  // Configure hot reload
  const configureCommand = vscode.commands.registerCommand("ios-vscode.hotReloadConfigure", async () => {
    const config = hotReloadService.getConfiguration()

    const options = [
      {
        label: `Enabled: ${config.enabled ? "Yes" : "No"}`,
        description: "Toggle hot reload on/off",
        action: "toggle-enabled",
      },
      {
        label: `Debounce Delay: ${config.debounceDelay}ms`,
        description: "Time to wait before triggering reload",
        action: "set-debounce",
      },
      {
        label: `Incremental Compilation: ${config.incrementalCompilation ? "Yes" : "No"}`,
        description: "Use incremental compilation for faster builds",
        action: "toggle-incremental",
      },
      {
        label: `SwiftUI Preview Mode: ${config.swiftUIPreviewMode ? "Yes" : "No"}`,
        description: "Enable fast SwiftUI preview updates",
        action: "toggle-swiftui",
      },
      {
        label: `Auto Save: ${config.autoSave ? "Yes" : "No"}`,
        description: "Automatically save files before reload",
        action: "toggle-autosave",
      },
    ]

    const selected = await vscode.window.showQuickPick(options, {
      placeHolder: "Select hot reload setting to configure",
    })

    if (selected) {
      await handleConfigurationAction(selected.action, hotReloadService)
    }
  })

  context.subscriptions.push(toggleCommand, forceReloadCommand, historyCommand, configureCommand)
}

async function handleConfigurationAction(action: string, hotReloadService: HotReloadService): Promise<void> {
  const config = hotReloadService.getConfiguration()

  switch (action) {
    case "toggle-enabled":
      hotReloadService.updateConfiguration({ enabled: !config.enabled })
      break

    case "set-debounce":
      const debounceInput = await vscode.window.showInputBox({
        prompt: "Enter debounce delay in milliseconds",
        value: config.debounceDelay.toString(),
        validateInput: (value) => {
          const num = Number.parseInt(value)
          if (isNaN(num) || num < 100 || num > 10000) {
            return "Please enter a number between 100 and 10000"
          }
          return null
        },
      })

      if (debounceInput) {
        hotReloadService.updateConfiguration({ debounceDelay: Number.parseInt(debounceInput) })
      }
      break

    case "toggle-incremental":
      hotReloadService.updateConfiguration({ incrementalCompilation: !config.incrementalCompilation })
      break

    case "toggle-swiftui":
      hotReloadService.updateConfiguration({ swiftUIPreviewMode: !config.swiftUIPreviewMode })
      break

    case "toggle-autosave":
      hotReloadService.updateConfiguration({ autoSave: !config.autoSave })
      break
  }
}

function getHotReloadHistoryWebview(history: any[]): string {
  const historyItems = history
    .slice(-20) // Show last 20 entries
    .reverse()
    .map(
      (item, index) => `
    <tr class="${item.success ? "success" : "error"}">
      <td>${new Date(Date.now() - index * 60000).toLocaleTimeString()}</td>
      <td>${item.changeType}</td>
      <td>${item.duration}ms</td>
      <td>${item.success ? "✓" : "✗"}</td>
      <td>${item.errors ? item.errors.join(", ") : ""}</td>
    </tr>
  `,
    )
    .join("")

  return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Hot Reload History</title>
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
                padding: 8px 12px;
                text-align: left;
                border-bottom: 1px solid var(--vscode-panel-border);
            }
            
            th {
                background-color: var(--vscode-editor-inactiveSelectionBackground);
                font-weight: 600;
            }
            
            .success {
                background-color: rgba(0, 255, 0, 0.1);
            }
            
            .error {
                background-color: rgba(255, 0, 0, 0.1);
            }
            
            .stats {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 20px;
                margin-bottom: 30px;
            }
            
            .stat-card {
                background-color: var(--vscode-editor-inactiveSelectionBackground);
                padding: 15px;
                border-radius: 4px;
            }
            
            .stat-value {
                font-size: 24px;
                font-weight: bold;
                color: var(--vscode-textLink-foreground);
            }
            
            .stat-label {
                font-size: 12px;
                opacity: 0.8;
                margin-top: 4px;
            }
        </style>
    </head>
    <body>
        <h1>Hot Reload History</h1>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-value">${history.filter((h) => h.success).length}</div>
                <div class="stat-label">Successful Reloads</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${history.filter((h) => !h.success).length}</div>
                <div class="stat-label">Failed Reloads</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${Math.round(history.reduce((sum, h) => sum + h.duration, 0) / history.length)}ms</div>
                <div class="stat-label">Average Duration</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${Math.round((history.filter((h) => h.success).length / history.length) * 100)}%</div>
                <div class="stat-label">Success Rate</div>
            </div>
        </div>
        
        <table>
            <thead>
                <tr>
                    <th>Time</th>
                    <th>Type</th>
                    <th>Duration</th>
                    <th>Status</th>
                    <th>Errors</th>
                </tr>
            </thead>
            <tbody>
                ${historyItems}
            </tbody>
        </table>
    </body>
    </html>`
}
