import * as childProcess from "child_process";
import * as vscode from "vscode";
import { startIntentScanner } from "./intent-scanner";
import { startIntentDecorations } from "./intent-decorations";
import { registerIntentCommands } from "./intent-commands";
import { IntentViewProvider } from "./intent-view";
import { installGlobalConfig } from "./global-config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isClaudeCliAvailable(): boolean {
  try {
    childProcess.execFileSync("claude", ["--version"], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("CodeSpark");
  context.subscriptions.push(log);

  if (!isClaudeCliAvailable()) {
    const installAction = "Install Claude Code";
    vscode.window
      .showWarningMessage(
        "CodeSpark requires the Claude Code CLI. Please install it to use this extension.",
        installAction,
      )
      .then((action) => {
        if (action === installAction) {
          vscode.env.openExternal(
            vscode.Uri.parse("https://code.claude.com/docs/en/quickstart"),
          );
        }
      });
    log.appendLine("[activate] Claude Code CLI not found on PATH — extension disabled");
    return;
  }

  installGlobalConfig(log);

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

  registerIntentCommands(context);

  const intentScanner = startIntentScanner(workspaceFolder, log);
  context.subscriptions.push(intentScanner);

  const intentDecorations = startIntentDecorations(context);
  context.subscriptions.push(intentDecorations);

  const intentView = new IntentViewProvider(workspaceFolder, intentScanner);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      IntentViewProvider.viewId,
      intentView,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
}

export function deactivate() {}
