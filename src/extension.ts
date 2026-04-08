import * as vscode from "vscode";
import { InstructionFileDecorationProvider } from "./instructionDecorations";
import { warmupSession, closeSession } from "./llm-sdk";
import { initStats, showStats, resetStats } from "./stats";
import { createInvokeCommand } from "./invoker";
import { createUpdateActiveInstructions } from "./statusbar";
import {
  initResearchSummary,
  clearResearchSummary,
} from "./research-agent";
import { ResearchViewProvider } from "./research-view";

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("CodeSpark");
  context.subscriptions.push(log);

  initStats(context.workspaceState);
  initResearchSummary(context.workspaceState);

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
  context.subscriptions.push(statusBarItem);

  const activeInstructions = createUpdateActiveInstructions(statusBarItem);

  // Update on editor change
  activeInstructions.update();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() =>
      activeInstructions.update(),
    ),
  );

  // Watch for CLAUDE.md and AGENT.md file changes
  const watcher = vscode.workspace.createFileSystemWatcher(
    "**/{CLAUDE,AGENT}.md",
  );
  const onInstructionsChanged = (type: string) => (uri: vscode.Uri) => {
    log.appendLine(
      `[instructions] ${type}: ${vscode.workspace.asRelativePath(uri)}`,
    );
    activeInstructions.update();
  };
  watcher.onDidCreate(onInstructionsChanged("Created"));
  watcher.onDidChange(onInstructionsChanged("Updated"));
  watcher.onDidDelete(onInstructionsChanged("Deleted"));
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeSpark.invoke",
      createInvokeCommand(
        log,
        decorationProvider,
        statusBarItem,
        activeInstructions.update,
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

  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.openResearch", () => {
      vscode.commands.executeCommand("codeSpark.research.focus");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.clearResearchSummary", () => {
      clearResearchSummary();
      vscode.window.showInformationMessage(
        "CodeSpark: Research summary cleared.",
      );
    }),
  );

  // Research agent webview panel
  const researchView = new ResearchViewProvider(context.extensionUri, log);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ResearchViewProvider.viewId,
      researchView,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
}

export function deactivate() {
  closeSession();
}
