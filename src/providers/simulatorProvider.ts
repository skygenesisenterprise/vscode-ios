import * as vscode from "vscode"
import type { ServerConnection } from "../services/serverConnection"
import type { Thenable } from "vscode"

export class SimulatorProvider implements vscode.TreeDataProvider<SimulatorItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<SimulatorItem | undefined | null | void> = new vscode.EventEmitter<
    SimulatorItem | undefined | null | void
  >()
  readonly onDidChangeTreeData: vscode.Event<SimulatorItem | undefined | null | void> = this._onDidChangeTreeData.event

  constructor(private serverConnection: ServerConnection) {}

  refresh(): void {
    this._onDidChangeTreeData.fire()
  }

  getTreeItem(element: SimulatorItem): vscode.TreeItem {
    return element
  }

  getChildren(element?: SimulatorItem): Thenable<SimulatorItem[]> {
    if (!this.serverConnection.isConnected()) {
      return Promise.resolve([])
    }

    if (!element) {
      // Root level - show simulator status and controls
      return Promise.resolve([
        new SimulatorItem("Simulator Status", "Running", vscode.TreeItemCollapsibleState.None, {
          command: "ios-vscode.openSimulator",
          title: "Open Simulator",
        }),
        new SimulatorItem("Current Device", "iPhone 15", vscode.TreeItemCollapsibleState.None, {
          command: "ios-vscode.selectDevice",
          title: "Select Device",
        }),
        new SimulatorItem("Hot Reload", "Enabled", vscode.TreeItemCollapsibleState.None, {
          command: "ios-vscode.hotReload",
          title: "Toggle Hot Reload",
        }),
      ])
    }

    return Promise.resolve([])
  }
}

class SimulatorItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command,
  ) {
    super(label, collapsibleState)
    this.tooltip = `${this.label}: ${this.description}`
    this.description = description
  }
}
