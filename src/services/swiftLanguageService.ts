import * as vscode from "vscode"

export class SwiftLanguageService
  implements vscode.CompletionItemProvider, vscode.HoverProvider, vscode.DefinitionProvider
{
  private serverConnection: any

  constructor(serverConnection?: any) {
    this.serverConnection = serverConnection
  }

  // Completion Provider
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext,
  ): Promise<vscode.CompletionItem[]> {
    const completions: vscode.CompletionItem[] = []

    // Swift keywords
    const keywords = [
      "class",
      "struct",
      "enum",
      "protocol",
      "extension",
      "func",
      "var",
      "let",
      "if",
      "else",
      "for",
      "while",
      "switch",
      "case",
      "default",
      "return",
      "import",
      "public",
      "private",
      "internal",
      "fileprivate",
      "open",
      "static",
      "final",
      "override",
      "mutating",
      "nonmutating",
      "lazy",
      "weak",
      "unowned",
      "optional",
      "required",
      "convenience",
      "dynamic",
      "infix",
      "prefix",
      "postfix",
      "operator",
      "associatedtype",
      "typealias",
      "init",
      "deinit",
      "subscript",
      "willSet",
      "didSet",
      "get",
      "set",
      "throws",
      "rethrows",
      "try",
      "catch",
      "finally",
      "defer",
      "guard",
      "where",
      "as",
      "is",
      "super",
      "self",
      "Self",
      "Type",
      "true",
      "false",
      "nil",
    ]

    keywords.forEach((keyword) => {
      const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword)
      item.insertText = keyword
      completions.push(item)
    })

    // SwiftUI specific completions
    const swiftUIComponents = [
      {
        name: "VStack",
        snippet: "VStack {\n\t$0\n}",
        documentation: "A view that arranges its children in a vertical line.",
      },
      {
        name: "HStack",
        snippet: "HStack {\n\t$0\n}",
        documentation: "A view that arranges its children in a horizontal line.",
      },
      {
        name: "ZStack",
        snippet: "ZStack {\n\t$0\n}",
        documentation: "A view that overlays its children, aligning them in both axes.",
      },
      {
        name: "Text",
        snippet: 'Text("$0")',
        documentation: "A view that displays one or more lines of read-only text.",
      },
      {
        name: "Button",
        snippet: 'Button("$1") {\n\t$0\n}',
        documentation: "A control that initiates an action.",
      },
      {
        name: "Image",
        snippet: 'Image("$0")',
        documentation: "A view that displays an image.",
      },
      {
        name: "NavigationView",
        snippet: "NavigationView {\n\t$0\n}",
        documentation:
          "A view for presenting a stack of views that represents a visible path in a navigation hierarchy.",
      },
      {
        name: "List",
        snippet: "List {\n\t$0\n}",
        documentation: "A container that presents rows of data arranged in a single column.",
      },
      {
        name: "Form",
        snippet: "Form {\n\t$0\n}",
        documentation: "A container for grouping controls used for data entry.",
      },
      {
        name: "TextField",
        snippet: 'TextField("$1", text: $$$0)',
        documentation: "A control that displays an editable text interface.",
      },
    ]

    swiftUIComponents.forEach((component) => {
      const item = new vscode.CompletionItem(component.name, vscode.CompletionItemKind.Class)
      item.insertText = new vscode.SnippetString(component.snippet)
      item.documentation = new vscode.MarkdownString(component.documentation)
      completions.push(item)
    })

    // iOS Framework completions
    const iosFrameworks = [
      "UIKit",
      "Foundation",
      "SwiftUI",
      "Combine",
      "CoreData",
      "AVFoundation",
      "MapKit",
      "CoreLocation",
    ]

    iosFrameworks.forEach((framework) => {
      const item = new vscode.CompletionItem(framework, vscode.CompletionItemKind.Module)
      item.insertText = framework
      item.documentation = new vscode.MarkdownString(`Import ${framework} framework`)
      completions.push(item)
    })

    // If connected to server, get remote completions
    if (this.serverConnection && this.serverConnection.isConnected()) {
      try {
        const remoteCompletions = await this.getRemoteCompletions(document, position)
        completions.push(...remoteCompletions)
      } catch (error) {
        console.error("Failed to get remote completions:", error)
      }
    }

    return completions
  }

  // Hover Provider
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const wordRange = document.getWordRangeAtPosition(position)
    if (!wordRange) return undefined

    const word = document.getText(wordRange)

    // Swift built-in types documentation
    const builtInTypes: { [key: string]: string } = {
      String: "A Unicode string value that is a collection of characters.",
      Int: "A signed integer value type.",
      Double: "A double-precision, floating-point value type.",
      Float: "A single-precision, floating-point value type.",
      Bool: "A value type whose instances are either true or false.",
      Array: "An ordered, random-access collection.",
      Dictionary: "A collection whose elements are key-value pairs.",
      Optional: "A type that represents either a wrapped value or nil, the absence of a value.",
      Set: "An unordered collection of unique elements.",
    }

    if (builtInTypes[word]) {
      const hoverContent = new vscode.MarkdownString()
      hoverContent.appendCodeblock(`${word}`, "swift")
      hoverContent.appendMarkdown(builtInTypes[word])
      return new vscode.Hover(hoverContent, wordRange)
    }

    // If connected to server, get remote hover info
    if (this.serverConnection && this.serverConnection.isConnected()) {
      try {
        const remoteHover = await this.getRemoteHover(document, position, word)
        if (remoteHover) return remoteHover
      } catch (error) {
        console.error("Failed to get remote hover info:", error)
      }
    }

    return undefined
  }

  // Definition Provider
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Definition | undefined> {
    const wordRange = document.getWordRangeAtPosition(position)
    if (!wordRange) return undefined

    const word = document.getText(wordRange)

    // Search for definitions in current workspace
    const workspaceDefinitions = await this.findWorkspaceDefinitions(word)
    if (workspaceDefinitions.length > 0) {
      return workspaceDefinitions
    }

    // If connected to server, get remote definitions
    if (this.serverConnection && this.serverConnection.isConnected()) {
      try {
        const remoteDefinition = await this.getRemoteDefinition(document, position, word)
        if (remoteDefinition) return remoteDefinition
      } catch (error) {
        console.error("Failed to get remote definition:", error)
      }
    }

    return undefined
  }

  private async getRemoteCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    // Implementation for getting completions from remote Swift server
    // This would use SourceKit-LSP or similar Swift language server
    return []
  }

  private async getRemoteHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    word: string,
  ): Promise<vscode.Hover | undefined> {
    // Implementation for getting hover info from remote Swift server
    return undefined
  }

  private async getRemoteDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    word: string,
  ): Promise<vscode.Definition | undefined> {
    // Implementation for getting definitions from remote Swift server
    return undefined
  }

  private async findWorkspaceDefinitions(word: string): Promise<vscode.Location[]> {
    const locations: vscode.Location[] = []

    // Search for function, class, struct, enum definitions
    const searchPatterns = [
      `func ${word}`,
      `class ${word}`,
      `struct ${word}`,
      `enum ${word}`,
      `protocol ${word}`,
      `extension ${word}`,
      `let ${word}`,
      `var ${word}`,
    ]

    for (const pattern of searchPatterns) {
      const files = await vscode.workspace.findFiles("**/*.swift", "**/node_modules/**")

      for (const file of files) {
        const document = await vscode.workspace.openTextDocument(file)
        const text = document.getText()
        const lines = text.split("\n")

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(pattern)) {
            const position = new vscode.Position(i, lines[i].indexOf(word))
            locations.push(new vscode.Location(file, position))
          }
        }
      }
    }

    return locations
  }

  // Diagnostic provider for Swift syntax errors
  async provideDiagnostics(document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
    const diagnostics: vscode.Diagnostic[] = []
    const text = document.getText()
    const lines = text.split("\n")

    // Basic Swift syntax validation
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Check for common Swift syntax errors
      if (line.includes("func") && !line.includes("{") && !line.includes(";")) {
        const range = new vscode.Range(i, 0, i, line.length)
        const diagnostic = new vscode.Diagnostic(
          range,
          "Function declaration should end with '{' or ';'",
          vscode.DiagnosticSeverity.Error,
        )
        diagnostics.push(diagnostic)
      }

      // Check for missing semicolons in certain contexts
      if (line.trim().startsWith("import") && !line.trim().endsWith(";") && !line.includes("//")) {
        const range = new vscode.Range(i, 0, i, line.length)
        const diagnostic = new vscode.Diagnostic(
          range,
          "Import statement should end with ';'",
          vscode.DiagnosticSeverity.Warning,
        )
        diagnostics.push(diagnostic)
      }
    }

    return diagnostics
  }
}
