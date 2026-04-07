import * as vscode from "vscode";
import * as path from "path";
import { findInstructionsForFile, ResolvedInstructions } from "./instructions";
import { InstructionFileDecorationProvider } from "./instructionDecorations";
import { warmupSession, closeSession } from "./llm-sdk";
import { initStats, showStats, resetStats } from "./stats";
import { createInvokeCommand } from "./invoker";

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("CodeSpark");
  context.subscriptions.push(log);

  initStats(context.workspaceState);

  // Prewarm pi modules on startup
  warmupSession(log);

  // File decoration provider for context files
  const decorationProvider = new InstructionFileDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationProvider),
  );

  // Status bar item showing the active CLAUDE.md
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    0,
  );
  statusBarItem.command = "codeSpark.openInstructions";
  context.subscriptions.push(statusBarItem);

  let currentInstructions: ResolvedInstructions = {
    root: undefined,
    local: [],
    referencedFiles: [],
  };

  function updateActiveInstructions() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      currentInstructions = { root: undefined, local: [], referencedFiles: [] };
      statusBarItem.hide();
      return;
    }

    currentInstructions = findInstructionsForFile(editor.document.uri);

    const labels: string[] = [];
    if (currentInstructions.root) {
      labels.push("root");
    }
    for (const loc of currentInstructions.local) {
      labels.push(vscode.workspace.asRelativePath(loc.uri));
    }

    if (labels.length > 0) {
      statusBarItem.text = `$(sparkle) CodeSpark: ${labels.join(" + ")}`;
      statusBarItem.tooltip = `Active instructions: ${labels.join(", ")}`;
      statusBarItem.show();
    } else {
      statusBarItem.text = "$(sparkle) CodeSpark";
      statusBarItem.tooltip = "No CLAUDE.md or AGENT.md found for this file";
      statusBarItem.show();
    }
  }

  // Update on editor change
  updateActiveInstructions();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateActiveInstructions()),
  );

  // Watch for CLAUDE.md and AGENT.md file changes
  const watcher = vscode.workspace.createFileSystemWatcher(
    "**/{CLAUDE,AGENT}.md",
  );
  const onInstructionsChanged = (type: string) => (uri: vscode.Uri) => {
    log.appendLine(
      `[instructions] ${type}: ${vscode.workspace.asRelativePath(uri)}`,
    );
    updateActiveInstructions();
  };
  watcher.onDidCreate(onInstructionsChanged("Created"));
  watcher.onDidChange(onInstructionsChanged("Updated"));
  watcher.onDidDelete(onInstructionsChanged("Deleted"));
  context.subscriptions.push(watcher);

  // Command to open the active CLAUDE.md file (prefers local, falls back to root)
  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.openInstructions", () => {
      const target = currentInstructions.local[0] ?? currentInstructions.root;
      if (target) {
        vscode.window.showTextDocument(target.uri);
      } else {
        vscode.window.showInformationMessage(
          "No CLAUDE.md or AGENT.md found for the current file.",
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeSpark.invoke",
      createInvokeCommand(
        log,
        decorationProvider,
        statusBarItem,
        updateActiveInstructions,
      ),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.showStats", () => {
      showStats();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.resetStats", () => {
      resetStats();
      vscode.window.showInformationMessage("CodeSpark: Stats reset.");
    }),
  );
}

export function deactivate() {
  closeSession();
}
