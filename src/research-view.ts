import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  startResearchQuery,
  getLiveQuery,
  abortLiveQuery,
  iterateResearchEvents,
  clearResearchSummary,
  getResearchSummary,
  appendResearchContext,
  getSessions,
  getActiveSessionId,
  getActiveSession,
  createSession,
  switchSession,
  deleteSession,
  updateSessionEntries,
  saveAgentMessages,
  getSessionInfos,
} from "./research-agent";
import { IpcServer } from "./ipc-server";
import {
  prepareInlineAgent,
  executeInlineAgent,
  abortInlineAgent,
} from "./claude-code-inline";
import { ResolvedContext } from "./types";
import { startFileScan } from "./editor-effects";


function getNonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export class ResearchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "codeSpark.research";

  private _view?: vscode.WebviewView;
  private _pendingFileContext?: { filePath: string; cursorLine: number; selection?: string };
  /** Queue of prompts awaiting done events, in order */
  private _promptQueue: { text: string; files: string[] }[] = [];
  /** Whether an event loop is already running for the active session */
  private _eventLoopRunning = false;
  private _readyResolve?: () => void;
  private _readyPromise: Promise<void> = new Promise((resolve) => {
    this._readyResolve = resolve;
  });

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _log: vscode.OutputChannel,
    private readonly _mcpConfigPath: string | undefined,
    private readonly _ipcServer: IpcServer,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, "out"),
        vscode.Uri.joinPath(this._extensionUri, "media"),
      ],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => {
      this._log.appendLine(
        `[research-view] msg: ${JSON.stringify(msg).slice(0, 200)}`,
      );

      switch (msg.type) {
        case "send":
          if (this._pendingFileContext) {
            this._handleSendWithContext(msg.text);
          } else {
            this._handlePrompt(msg.text);
          }
          break;
        case "cancel":
          this._cancelCurrent();
          break;
        case "clear":
          this._cancelCurrent();
          break;
        case "ready":
          this._readyResolve?.();
          this._sendInit();
          break;
        case "open-file":
          this._openFile(msg.path, msg.line);
          break;
        case "run-command":
          this._runInTerminal(msg.command);
          break;
        case "new-session":
          this._handleNewSession(msg.currentEntries);
          break;
        case "switch-session":
          this._handleSwitchSession(msg.id, msg.currentEntries);
          break;
        case "apply-code":
          this._handleApplyCode(msg.filePath, msg.code);
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._sendInit();
      }
    });

    webviewView.onDidDispose(() => {
      this._cancelCurrent();
      this._view = undefined;
    });
  }

  private _post(msg: unknown): void {
    this._view?.webview.postMessage(msg);
  }

  private _sendInit(): void {
    const session = getActiveSession();
    if (session && session.entries.length > 0) {
      this._post({
        type: "restore",
        entries: session.entries,
        sessions: getSessionInfos(),
        activeSessionId: getActiveSessionId(),
        hasContext: !!session.summary,
      });
    } else {
      this._post({
        type: "init",
        hasContext: !!getResearchSummary(),
        sessions: getSessionInfos(),
        activeSessionId: getActiveSessionId(),
      });
    }
  }

  private _sendSessionsUpdate(): void {
    this._post({
      type: "sessions-updated",
      sessions: getSessionInfos(),
      activeSessionId: getActiveSessionId(),
    });
  }

  private _cancelCurrent(): void {
    const sessionId = getActiveSessionId();
    if (sessionId) {
      abortLiveQuery(sessionId);
    }
    this._eventLoopRunning = false;
    this._promptQueue = [];
  }

  private _handleNewSession(currentEntries: any[]): void {
    this._saveCurrentSession(currentEntries);
    this._cancelCurrent();
    this._pendingFileContext = undefined;
    createSession();
    this._sendSessionsUpdate();
  }

  private _handleSwitchSession(id: string, currentEntries: any[]): void {
    this._saveCurrentSession(currentEntries);
    this._cancelCurrent();
    const session = switchSession(id);
    if (session) {
      this._post({
        type: "restore",
        entries: session.entries,
        sessions: getSessionInfos(),
        activeSessionId: id,
        hasContext: !!session.summary,
      });
    }
  }

  private _saveCurrentSession(entries: any[]): void {
    const sessionId = getActiveSessionId();
    if (!sessionId) return;
    const hasAssistantResponse = entries.some((e: any) => e.role === "assistant" && e.turns?.length > 0);
    if (!hasAssistantResponse) {
      deleteSession(sessionId);
      return;
    }
    updateSessionEntries(sessionId, entries);
    // SDK manages its own session persistence — save the SDK session ID
    const handle = getLiveQuery(sessionId);
    if (handle?.sdkSessionId) {
      saveAgentMessages(sessionId, [{ sdkSessionId: handle.sdkSessionId }]);
    }
  }

  private async _openFile(filePath: string, line?: number): Promise<void> {
    const workspaceFolder =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) return;

    const path = await import("path");
    const absolute = path.resolve(workspaceFolder, filePath);
    const uri = vscode.Uri.file(absolute);

    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const options: vscode.TextDocumentShowOptions = {};
      if (line && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        options.selection = new vscode.Range(pos, pos);
      }
      await vscode.window.showTextDocument(doc, options);
    } catch {
      this._log.appendLine(`[research-view] Could not open file: ${absolute}`);
    }
  }

  private _terminal: vscode.Terminal | undefined;
  private _busyTerminals = new Set<vscode.Terminal>();
  private _shellListenersReady = false;

  private _ensureShellListeners(): void {
    if (this._shellListenersReady) return;
    this._shellListenersReady = true;
    vscode.window.onDidStartTerminalShellExecution((e) => {
      this._busyTerminals.add(e.terminal);
    });
    vscode.window.onDidEndTerminalShellExecution((e) => {
      this._busyTerminals.delete(e.terminal);
    });
  }

  private _getTerminal(): vscode.Terminal {
    this._ensureShellListeners();

    if (this._terminal && !this._terminal.exitStatus && !this._busyTerminals.has(this._terminal)) {
      return this._terminal;
    }

    this._terminal = vscode.window.createTerminal("CodeSpark");
    return this._terminal;
  }

  private _runInTerminal(command: string): void {
    const terminal = this._getTerminal();
    terminal.show();
    terminal.sendText(command);
  }

  // ---------------------------------------------------------------------------
  // Apply code from research
  // ---------------------------------------------------------------------------

  private async _handleApplyCode(filePath: string, code: string): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) return;

    const absolute = path.resolve(workspaceFolder, filePath);
    this._log.appendLine(`[research-view:apply] Applying to ${filePath}`);

    // Open the file in the editor
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
    } catch {
      this._log.appendLine(`[research-view:apply] Could not open file: ${absolute}`);
      vscode.window.showErrorMessage(`CodeSpark: Could not open file ${filePath}`);
      return;
    }

    const editor = await vscode.window.showTextDocument(doc);
    const fileContent = doc.getText();

    if (!this._mcpConfigPath) {
      vscode.window.showErrorMessage("CodeSpark: MCP config not available");
      return;
    }

    // Prepare inline agent
    const agent = await prepareInlineAgent(
      {
        fileContent,
        filePath,
        referenceFiles: [],
        instructionContent: undefined,
        isInstructionFile: false,
      },
      this._log,
      this._mcpConfigPath,
    );

    // Start scanning animation
    const pulse = startFileScan(editor);

    // Build the "reverse focus" context — the research code block IS the instruction
    const ctx: ResolvedContext = {
      fileContent,
      filePath,
      selection: undefined,
      cursorLine: 1,
      cursorOnEmptyLine: false,
      contextSnippet: "The whole file",
      instruction: `The research agent suggested the following change for this file. Apply it:\n\n\`\`\`\n${code}\n\`\`\``,
      instructionContent: undefined,
      referenceFiles: [],
      isInstructionFile: false,
    };

    try {
      const result = await executeInlineAgent(
        agent,
        ctx,
        this._log,
        this._ipcServer,
      );

      pulse.dispose();
      this._log.appendLine(
        `[research-view:apply] Done (${result.latencyMs}ms, edits=${result.hasEdits})`,
      );

      if (result.editedLines.length > 0) {
        // Dim non-edited lines to highlight the changes
        const editedLineSet = new Set<number>();
        for (const range of result.editedLines) {
          for (let l = range.startLine; l <= range.endLine; l++) {
            editedLineSet.add(l);
          }
        }

        const dimType = vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          opacity: "0.3",
        });

        const dimRanges: vscode.Range[] = [];
        for (let l = 0; l < editor.document.lineCount; l++) {
          if (!editedLineSet.has(l)) {
            dimRanges.push(new vscode.Range(l, 0, l, 0));
          }
        }
        editor.setDecorations(dimType, dimRanges);

        function cleanup() {
          dimType.dispose();
          saveListener.dispose();
          changeListener.dispose();
        }

        const saveListener = vscode.workspace.onDidSaveTextDocument((d) => {
          if (d.uri.fsPath === doc.uri.fsPath) cleanup();
        });

        const changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
          if (
            e.document.uri.fsPath === doc.uri.fsPath &&
            e.reason === vscode.TextDocumentChangeReason.Undo
          ) {
            cleanup();
          }
        });
      }
    } catch (err: unknown) {
      pulse.dispose();
      const msg = err instanceof Error ? err.message : String(err);
      this._log.appendLine(`[research-view:apply] Error: ${msg}`);
      vscode.window.showErrorMessage(`CodeSpark: ${msg}`);
    }
  }

  private async _handlePrompt(text: string, files: string[] = []): Promise<void> {
    this._log.appendLine(`[research-view:prompt] ${text}`);
    const workspaceFolder =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      this._post({ type: "error", text: "No workspace folder open." });
      this._post({ type: "done" });
      return;
    }

    // Ensure we have an active session
    let sessionId = getActiveSessionId();
    if (!sessionId) {
      const session = createSession();
      sessionId = session.id;
      this._sendSessionsUpdate();
    }

    this._promptQueue.push({ text, files });

    // Check if session has a saved SDK session ID for resume
    const session = getActiveSession();
    const savedSdkSessionId = session?.agentMessages?.[0]?.sdkSessionId;

    const { handle, isFollowUp } = startResearchQuery(
      text,
      workspaceFolder,
      this._log,
      sessionId,
      this._mcpConfigPath,
      savedSdkSessionId,
    );

    // If this is a follow-up, the event loop is already running — just return
    if (isFollowUp) return;

    // Start the long-lived event loop for this process
    this._eventLoopRunning = true;
    try {
      for await (const evt of iterateResearchEvents(handle, this._log)) {
        if (evt.type === "done") {
          const prompt = this._promptQueue.shift();
          if (evt.resultText.trim() && prompt) {
            appendResearchContext(sessionId, prompt.text, evt.resultText.trim(), prompt.files, this._log);
            this._post({ type: "context-updated" });
            this._sendSessionsUpdate();
          }
          if (evt.sdkSessionId) {
            saveAgentMessages(sessionId, [{ sdkSessionId: evt.sdkSessionId }]);
          }
          this._post({
            type: "done",
            numTurns: evt.numTurns,
            totalCostUsd: evt.totalCostUsd,
          });
          // Don't break — keep listening for follow-up turns
        } else {
          this._post(evt);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log.appendLine(`[research:error] ${msg}`);
      this._post({ type: "error", text: msg });
      this._post({ type: "done" });
    }
    this._eventLoopRunning = false;
  }

  /** Set file context to be attached to the next query from the webview */
  public setFileContext(ctx: { filePath: string; cursorLine: number; selection?: string }): void {
    this._pendingFileContext = ctx;
    this._post({ type: "set-file-context", filePath: ctx.filePath, cursorLine: ctx.cursorLine, selection: ctx.selection ?? null });
    this._log.appendLine(
      `[research-view] File context set: ${ctx.filePath}:${ctx.cursorLine}`,
    );
  }

  public get isVisible(): boolean {
    return !!this._view?.visible;
  }

  public focusInput(): void {
    this._post({ type: "focus" });
  }

  /** Send a prompt programmatically (e.g. from CMD+I with > prefix) */
  public async sendPrompt(opts: {
    query: string;
    filePath: string;
    fileContent: string;
    cursorLine: number;
    contextSnippet: string;
  }): Promise<void> {
    // Ensure the panel is visible
    await vscode.commands.executeCommand("codeSpark.research.focus");

    if (this._view) {
      // Show clean user message + file context indicator in the webview
      this._post({ type: "inject-user", text: opts.query });
      this._post({ type: "tool-start", tool: "read_reference", toolId: -1 });
      this._post({ type: "tool-end", tool: "read_reference", toolId: -1, isError: false });

      await this._handlePromptWithContext(opts);
    }
  }

  private async _handleSendWithContext(text: string): Promise<void> {
    const ctx = this._pendingFileContext!;
    this._pendingFileContext = undefined;
    this._post({ type: "set-file-context", filePath: null, cursorLine: 0, selection: null });

    const workspaceFolder =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      this._post({ type: "error", text: "No workspace folder open." });
      this._post({ type: "done" });
      return;
    }

    const path = await import("path");
    const fs = await import("fs");
    const absolute = path.resolve(workspaceFolder, ctx.filePath);
    let fileContent: string;
    try {
      fileContent = await fs.promises.readFile(absolute, "utf-8");
    } catch {
      this._post({ type: "error", text: `Could not read file: ${ctx.filePath}` });
      this._post({ type: "done" });
      return;
    }

    // Show file context indicator in tool list
    this._post({ type: "tool-start", tool: "read_reference", toolId: -1 });
    this._post({ type: "tool-end", tool: "read_reference", toolId: -1, isError: false });

    const query = ctx.selection
      ? `\`\`\`\n${ctx.selection}\n\`\`\`\n\n${text}`
      : text;
    this._log.appendLine(`[research-view:prompt] ${query}`);

    await this._handlePromptWithContext({
      query,
      filePath: ctx.filePath,
      fileContent,
      cursorLine: ctx.cursorLine,
      contextSnippet: "",
    });
  }

  private async _handlePromptWithContext(opts: {
    query: string;
    filePath: string;
    fileContent: string;
    cursorLine: number;
    contextSnippet: string;
  }): Promise<void> {
    // Prepend file content to the prompt so the agent has context
    const contextPrompt = `Currently viewing \`${opts.filePath}\` (line ${opts.cursorLine}):\n\`\`\`\n${opts.fileContent}\n\`\`\`\n\n${opts.query}`;

    await this._handlePrompt(contextPrompt, [opts.filePath]);
  }

  /** Called from outside to save webview entries into the active session */
  public saveEntries(entries: any[]): void {
    const sessionId = getActiveSessionId();
    if (sessionId) {
      updateSessionEntries(sessionId, entries);
    }
  }

  private _getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "out", "webview.js"),
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "out", "webview.css"),
    );
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "logo.svg"),
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource};
      script-src 'nonce-${nonce}';
      font-src ${webview.cspSource};
      img-src ${webview.cspSource};">
  <link rel="stylesheet" href="${cssUri}">
  <title>Research</title>
</head>
<body>
  <div id="root" data-logo="${logoUri}"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
