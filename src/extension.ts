import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { InstructionFileDecorationProvider } from "./instructionDecorations";
import { initStats, showStats, resetStats } from "./stats";
import { createInvokeCommand } from "./invoker";
import { createUpdateActiveInstructions } from "./statusbar";
import {
  initAssistantSummary,
  clearAssistantSummary,
} from "./assistant-agent";
import { AssistantViewProvider } from "./assistant-view";
import { startIpcServer } from "./ipc-server";

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

  initStats(context.workspaceState);
  initAssistantSummary(context.workspaceState);

  // Start IPC server and MCP server (long-lived HTTP transport)
  const ipcServer = startIpcServer(log);
  context.subscriptions.push({ dispose: () => ipcServer.dispose() });

  const mcpPort = 30000 + (process.pid % 10000);
  const mcpServerScript = path.join(context.extensionPath, "out", "mcp-server.js");
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

  // Wait for IPC socket to be ready before spawning MCP server
  ipcServer.ready.then(() => {
    const mcpProc = require("child_process").spawn(process.execPath, [mcpServerScript], {
      env: {
        ...process.env,
        CODESPARK_SOCKET: ipcServer.socketPath,
        CODESPARK_MCP_PORT: String(mcpPort),
        CODESPARK_WORKSPACE: workspaceFolder,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    mcpProc.stderr?.on("data", (chunk: Buffer) => {
      log.appendLine(`[mcp-server] ${chunk.toString().trim()}`);
    });
    mcpProc.on("error", (err: Error) => {
      log.appendLine(`[mcp-server] Failed to spawn: ${err.message}`);
    });
    mcpProc.on("exit", (code: number | null, signal: string | null) => {
      log.appendLine(`[mcp-server] Exited (code=${code}, signal=${signal})`);
    });
    context.subscriptions.push({
      dispose: () => {
        mcpProc.kill();
      },
    });
  });

  const mcpConfig = {
    mcpServers: {
      codespark: {
        type: "http",
        url: `http://127.0.0.1:${mcpPort}/mcp`,
      },
    },
  };
  const mcpConfigPath = path.join(os.tmpdir(), `codespark-mcp-${process.pid}.json`);
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));
  context.subscriptions.push({
    dispose: () => {
      try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }
    },
  });

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

  // Watch for CLAUDE.md file changes
  const watcher = vscode.workspace.createFileSystemWatcher(
    "**/CLAUDE.md",
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

  // Assistant agent webview panel (created before invoke command so it can be passed)
  const assistantView = new AssistantViewProvider(context.extensionUri, log, mcpConfigPath, ipcServer);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeSpark.invoke",
      createInvokeCommand(
        log,
        decorationProvider,
        statusBarItem,
        activeInstructions.update,
        mcpConfigPath,
        ipcServer,
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
    vscode.commands.registerCommand("codeSpark.openAssistant", async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const filePath = vscode.workspace.asRelativePath(
          editor.document.uri.fsPath,
        );
        const cursorLine = editor.selection.active.line + 1;
        const selection = editor.selection.isEmpty
          ? undefined
          : editor.document.getText(editor.selection);
        assistantView.startFileSession({ filePath, cursorLine, selection });
      }
      await vscode.commands.executeCommand("codeSpark.assistant.focus");
      assistantView.focusInput();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.clearAssistantSummary", () => {
      clearAssistantSummary();
      vscode.window.showInformationMessage(
        "CodeSpark: Assistant summary cleared.",
      );
    }),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      AssistantViewProvider.viewId,
      assistantView,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
}

export function deactivate() {}
