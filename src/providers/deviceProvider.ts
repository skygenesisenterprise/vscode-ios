import * as vscode from "vscode"
import type { ServerConnection } from "../services/serverConnection"

export class DeviceProvider implements vscode.TreeDataProvider<DeviceItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<DeviceItem | undefined | null | void> = new vscode.EventEmitter<
    DeviceItem | undefined | null | void
  >()
  readonly onDidChangeTreeData: vscode.Event<DeviceItem | undefined | null | void> = this._onDidChangeTreeData.event

  constructor(private serverConnection: ServerConnection) {}

  refresh(): void {
    this._onDidChangeTreeData.fire()
  }

  getTreeItem(element: DeviceItem): vscode.TreeItem {
    return element
  }

  async getChildren(element?: DeviceItem): Promise<DeviceItem[]> {
    if (!this.serverConnection.isConnected()) {
      return []
    }

    if (!element) {
      // Root level - show available devices
      try {
        const devices = await this.serverConnection.getAvailableDevices()
        return devices.map(
          (device) =>
            new DeviceItem(device, "Available", vscode.TreeItemCollapsibleState.None, {
              command: "ios-vscode.selectDevice",
              title: "Select Device",
              arguments: [device],
            }),
        )
      } catch (error) {
        return [new DeviceItem("Error loading devices", "Disconnected", vscode.TreeItemCollapsibleState.None)]
      }
    }

    return []
  }
}

class DeviceItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command,
  ) {
    super(label, collapsibleState)
    this.tooltip = `${this.label}: ${this.description}`
    this.description = description

    // Set appropriate icons
    if (label.includes("iPhone")) {
      this.iconPath = new vscode.ThemeIcon("device-mobile")
    } else if (label.includes("iPad")) {
      this.iconPath = new vscode.ThemeIcon("device-desktop")
    } else {
      this.iconPath = new vscode.ThemeIcon("circle-outline")
    }
  }
}
