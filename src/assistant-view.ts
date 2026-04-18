import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  startAssistantQuery,
  getLiveQuery,
  abortLiveQuery,
  iterateAssistantEvents,
  getAssistantSummary,
  appendAssistantContext,
  getActiveSessionId,
  getActiveSession,
  createSession,
  switchSession,
  deleteSession,
  updateSessionEntries,
  saveAgentMessages,
  saveBreakdownSteps,
  getSessionInfos,
} from "./assistant-agent";
import { IpcServer, BreakdownStepInput } from "./ipc-server";

function getNonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export class AssistantViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "codeSpark.assistant";

  private _view?: vscode.WebviewView;
  private _pendingFileContext?: {
    filePath: string;
    cursorLine: number;
    selection?: string;
  };
  /** Queue of prompts awaiting done events, in order */
  private _promptQueue: { text: string; files: string[] }[] = [];
  /** Whether an event loop is already running for the active session */
  private _eventLoopRunning = false;
  private _readyResolve?: () => void;
  private _readyPromise: Promise<void> = new Promise((resolve) => {
    this._readyResolve = resolve;
  });
  /** Current breakdown steps for the active session */
  private _steps: BreakdownStepInput[] = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _log: vscode.OutputChannel,
    private readonly _mcpConfigPath: string | undefined,
    private readonly _ipcServer: IpcServer,
  ) {
    this._ipcServer.onBreakdown((steps) => {
      this._steps = steps;
      this._postBreakdown();
      this._persistBreakdown();
      this._log.appendLine(
        `[assistant-view] Breakdown created: ${steps.length} step(s)`,
      );
    });
  }

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
        `[assistant-view] msg: ${JSON.stringify(msg).slice(0, 200)}`,
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
      this._steps = session.breakdownSteps ?? [];
      this._post({
        type: "restore",
        entries: session.entries,
        sessions: getSessionInfos(),
        activeSessionId: getActiveSessionId(),
        hasContext: !!session.summary,
      });
    } else {
      this._steps = session?.breakdownSteps ?? [];
      this._post({
        type: "init",
        hasContext: !!getAssistantSummary(),
        sessions: getSessionInfos(),
        activeSessionId: getActiveSessionId(),
      });
    }
    this._postBreakdown();
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
    this._steps = [];
    createSession();
    this._sendSessionsUpdate();
    this._postBreakdown();
  }

  private _handleSwitchSession(id: string, currentEntries: any[]): void {
    this._saveCurrentSession(currentEntries);
    this._cancelCurrent();
    const session = switchSession(id);
    if (session) {
      // Restore breakdown steps from session
      this._steps = session.breakdownSteps ?? [];
      this._post({
        type: "restore",
        entries: session.entries,
        sessions: getSessionInfos(),
        activeSessionId: id,
        hasContext: !!session.summary,
      });
      this._postBreakdown();
    }
  }

  private _saveCurrentSession(entries: any[]): void {
    const sessionId = getActiveSessionId();
    if (!sessionId) return;
    const hasAssistantResponse = entries.some(
      (e: any) => e.role === "assistant" && e.turns?.length > 0,
    );
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
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) return;

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
      this._log.appendLine(`[assistant-view] Could not open file: ${absolute}`);
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

    if (
      this._terminal &&
      !this._terminal.exitStatus &&
      !this._busyTerminals.has(this._terminal)
    ) {
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
  // Breakdown
  // ---------------------------------------------------------------------------

  private _postBreakdown(): void {
    this._post({
      type: "breakdown",
      steps: this._steps.map((s) => ({
        title: s.title,
        description: s.description,
        filePath: s.filePath,
        lineHint: s.lineHint,
      })),
    });
  }

  private _persistBreakdown(): void {
    const sessionId = getActiveSessionId();
    if (!sessionId) return;
    saveBreakdownSteps(sessionId, this._steps);
  }

  private _buildBreakdownContext(): string {
    if (this._steps.length === 0) return "";

    const lines: string[] = ["[Breakdown:"];
    for (let i = 0; i < this._steps.length; i++) {
      const step = this._steps[i];
      lines.push(
        `${i + 1}. ${step.title} — ${step.filePath}${step.lineHint ? `:${step.lineHint}` : ""}`,
      );
    }
    lines.push("]");
    return lines.join("\n") + "\n\n";
  }

  private async _handlePrompt(
    text: string,
    files: string[] = [],
  ): Promise<void> {
    // Prepend breakdown context so the agent knows current state
    const breakdownContext = this._buildBreakdownContext();
    if (breakdownContext) {
      text = breakdownContext + text;
    }
    this._log.appendLine(`[assistant-view:prompt] ${text}`);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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

    const { handle, isFollowUp } = startAssistantQuery(
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
      for await (const evt of iterateAssistantEvents(handle, this._log)) {
        if (evt.type === "done") {
          const prompt = this._promptQueue.shift();
          if (evt.resultText.trim() && prompt) {
            appendAssistantContext(
              sessionId,
              prompt.text,
              evt.resultText.trim(),
              prompt.files,
              this._log,
            );
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
      this._log.appendLine(`[assistant:error] ${msg}`);
      this._post({ type: "error", text: msg });
      this._post({ type: "done" });
    }
    this._eventLoopRunning = false;
  }

  /** Set file context to be attached to the next query from the webview */
  public setFileContext(ctx: {
    filePath: string;
    cursorLine: number;
    selection?: string;
  }): void {
    this._pendingFileContext = ctx;
    this._post({
      type: "set-file-context",
      filePath: ctx.filePath,
      cursorLine: ctx.cursorLine,
      selection: ctx.selection ?? null,
    });
    this._log.appendLine(
      `[assistant-view] File context set: ${ctx.filePath}:${ctx.cursorLine}`,
    );
  }

  /** Create a new session with file context (SHIFT+CMD+I) */
  public startFileSession(ctx: {
    filePath: string;
    cursorLine: number;
    selection?: string;
  }): void {
    // If there's already a pending file context for this file, just update it
    if (this._pendingFileContext?.filePath === ctx.filePath) {
      this._pendingFileContext = ctx;
      this._post({
        type: "set-file-context",
        filePath: ctx.filePath,
        cursorLine: ctx.cursorLine,
        selection: ctx.selection ?? null,
      });
      this._log.appendLine(
        `[assistant-view] Continuing file session: ${ctx.filePath}`,
      );
      return;
    }

    this._cancelCurrent();

    createSession();
    this._sendSessionsUpdate();

    this._pendingFileContext = ctx;
    this._post({
      type: "set-file-context",
      filePath: ctx.filePath,
      cursorLine: ctx.cursorLine,
      selection: ctx.selection ?? null,
    });
    this._log.appendLine(
      `[assistant-view] File session started: ${ctx.filePath}`,
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
    await vscode.commands.executeCommand("codeSpark.assistant.focus");

    if (this._view) {
      // Show clean user message + file context indicator in the webview
      this._post({ type: "inject-user", text: opts.query });
      this._post({ type: "tool-start", tool: "read_reference", toolId: -1 });
      this._post({
        type: "tool-end",
        tool: "read_reference",
        toolId: -1,
        isError: false,
      });

      await this._handlePromptWithContext(opts);
    }
  }

  private async _handleSendWithContext(text: string): Promise<void> {
    const ctx = this._pendingFileContext!;

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      this._post({ type: "error", text: "No workspace folder open." });
      this._post({ type: "done" });
      return;
    }

    const absolute = path.resolve(workspaceFolder, ctx.filePath);
    let fileContent: string;
    try {
      fileContent = await fs.promises.readFile(absolute, "utf-8");
    } catch {
      this._post({
        type: "error",
        text: `Could not read file: ${ctx.filePath}`,
      });
      this._post({ type: "done" });
      return;
    }

    // Show file context indicator in tool list
    this._post({ type: "tool-start", tool: "read_reference", toolId: -1 });
    this._post({
      type: "tool-end",
      tool: "read_reference",
      toolId: -1,
      isError: false,
    });

    const query = ctx.selection
      ? `\`\`\`\n${ctx.selection}\n\`\`\`\n\n${text}`
      : text;
    this._log.appendLine(`[assistant-view:prompt] ${query}`);

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
  <title>Assistant</title>
</head>
<body>
  <div id="root" data-logo="${logoUri}"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
