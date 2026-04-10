import * as vscode from "vscode";
import {
  createResearchAgent,
  getLiveAgent,
  disposeLiveAgent,
  resolveModel,
  resolveResearchModel,
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
  private _currentUnsub?: () => void;
  private _pendingFileContext?: { filePath: string; cursorLine: number; selection?: string };

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _log: vscode.OutputChannel,
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
        this._post({ type: "focus" });
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

  private _toolDescription(toolName: string, args: any): string | undefined {
    if (toolName === "search_and_summarize") return args?.query;
    if (toolName === "explore_codebase") return args?.question;
    return undefined;
  }

  private _sendInit(): void {
    const session = getActiveSession();
    if (session && session.entries.length > 0) {
      // Restore previous session
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
      const agent = getLiveAgent(sessionId);
      if (agent) {
        agent.abort();
      }
    }
    if (this._currentUnsub) {
      this._currentUnsub();
      this._currentUnsub = undefined;
    }
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
    const agent = getLiveAgent(sessionId);
    if (agent) {
      saveAgentMessages(sessionId, [...agent.state.messages]);
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

  private async _handlePrompt(text: string): Promise<void> {
    this._log.appendLine(`[research-view:prompt] ${text}`);
    const workspaceFolder =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      this._post({ type: "error", text: "No workspace folder open." });
      this._post({ type: "done" });
      return;
    }

    let headResolved;
    let subResolved;
    try {
      [headResolved, subResolved] = await Promise.all([
        resolveResearchModel(this._log),
        resolveModel(this._log),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._post({ type: "error", text: `Failed to resolve model: ${msg}` });
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

    // Get or create agent for this session
    let ag = getLiveAgent(sessionId);
    if (!ag) {
      // Check if session has saved messages to restore
      const session = getActiveSession();
      const savedMessages = session?.agentMessages?.length
        ? session.agentMessages
        : undefined;

      this._log.appendLine(
        `[research-view] Models resolved, creating agent (head: ${headResolved.piModel?.id}, sub: ${subResolved.piModel?.id})`,
      );
      ag = createResearchAgent(
        headResolved.piModel,
        subResolved.piModel,
        headResolved.apiKey,
        workspaceFolder,
        this._log,
        sessionId,
        savedMessages,
      );
    } else {
      // Update tools/model on existing agent in case settings changed
      this._log.appendLine(
        `[research-view] Reusing live agent for session ${sessionId}`,
      );
    }

    const filesRead = new Set<string>();
    let lastAssistantText = "";
    let toolIdCounter = 0;
    const pendingToolIds = new Map<string, number[]>();

    const unsub = ag.subscribe((event: any) => {
      if (event.type === "message_start" && event.message?.role === "assistant") {
        this._post({ type: "turn-start" });
        lastAssistantText = "";
      }
      if (event.type === "message_update") {
        const evt = event.assistantMessageEvent;
        if (evt?.type === "text_delta") {
          lastAssistantText += evt.delta;
          this._post({ type: "token", text: evt.delta });
        }
      }
      if (event.type === "tool_execution_start") {
        if (event.toolName === "read" && event.args?.path) {
          filesRead.add(event.args.path);
        }
        const id = ++toolIdCounter;
        const queue = pendingToolIds.get(event.toolName) || [];
        queue.push(id);
        pendingToolIds.set(event.toolName, queue);
        this._post({ type: "tool-start", tool: event.toolName, toolId: id, description: this._toolDescription(event.toolName, event.args) });
      }
      if (event.type === "tool_execution_end") {
        const queue = pendingToolIds.get(event.toolName) || [];
        const id = queue.shift() || 0;
        this._post({
          type: "tool-end",
          tool: event.toolName,
          toolId: id,
          isError: !!event.isError,
        });
      }
    });
    this._currentUnsub = unsub;

    try {
      this._log.appendLine(`[research-view] Prompting agent with: ${text.slice(0, 100)}`);
      await ag.prompt(text);
      this._log.appendLine(`[research-view] Agent prompt settled, waiting for idle`);
      await ag.waitForIdle();
      this._log.appendLine(`[research-view] Agent idle`);

      // Append the user prompt + final response + files to session context
      if (lastAssistantText.trim()) {
        appendResearchContext(
          sessionId,
          text,
          lastAssistantText.trim(),
          [...filesRead],
          this._log,
        );
        this._post({ type: "context-updated" });
        // Update session name in dropdown after first prompt names it
        this._sendSessionsUpdate();
      }

      // Save agent messages for persistence
      saveAgentMessages(sessionId, [...ag.state.messages]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log.appendLine(`[research:error] ${msg}`);
      this._post({ type: "error", text: msg });
    } finally {
      unsub();
      this._currentUnsub = undefined;
      this._post({ type: "done" });
    }
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
      this._post({ type: "tool-start", tool: "read", toolId: -1, description: opts.filePath });
      this._post({ type: "tool-end", tool: "read", toolId: -1, isError: false });

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
    this._post({ type: "tool-start", tool: "read", toolId: -1, description: ctx.filePath });
    this._post({ type: "tool-end", tool: "read", toolId: -1, isError: false });

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
    const workspaceFolder =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      this._post({ type: "error", text: "No workspace folder open." });
      this._post({ type: "done" });
      return;
    }

    let headResolved;
    let subResolved;
    try {
      [headResolved, subResolved] = await Promise.all([
        resolveResearchModel(this._log),
        resolveModel(this._log),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._post({ type: "error", text: `Failed to resolve model: ${msg}` });
      this._post({ type: "done" });
      return;
    }

    let sessionId = getActiveSessionId();
    if (!sessionId) {
      const session = createSession();
      sessionId = session.id;
      this._sendSessionsUpdate();
    }

    let ag = getLiveAgent(sessionId);
    if (!ag) {
      const session = getActiveSession();
      const savedMessages = session?.agentMessages?.length
        ? session.agentMessages
        : undefined;

      ag = createResearchAgent(
        headResolved.piModel,
        subResolved.piModel,
        headResolved.apiKey,
        workspaceFolder,
        this._log,
        sessionId,
        savedMessages,
      );
    }

    // Inject file context as a fake explore_codebase tool call + result
    const toolCallId = `ctx-${Date.now()}`;
    const now = Date.now();
    const fakeAssistant = {
      role: "assistant" as const,
      content: [
        {
          type: "text" as const,
          text: `Let me look at the file the user is currently viewing.`,
        },
        {
          type: "toolCall" as const,
          id: toolCallId,
          name: "explore_codebase",
          arguments: { question: `Read ${opts.filePath} around line ${opts.cursorLine}` },
        },
      ],
      api: "anthropic-messages" as const,
      provider: "anthropic",
      model: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse" as const,
      timestamp: now,
    };
    const fakeToolResult = {
      role: "toolResult" as const,
      toolCallId,
      toolName: "explore_codebase",
      content: [{ type: "text" as const, text: `File: ${opts.filePath} (cursor at line ${opts.cursorLine})\n\n${opts.fileContent}` }],
      isError: false,
      timestamp: now,
    };

    // Inject into agent message history before the user prompt
    const messages = [...ag.state.messages];
    messages.push(
      { role: "user" as const, content: opts.query, timestamp: now } as any,
      fakeAssistant as any,
      fakeToolResult as any,
    );
    ag.state.messages = messages;

    // Now continue the agent (it has user + tool result, will generate next response)
    const filesRead = new Set<string>();
    let lastAssistantText = "";
    let toolIdCounter = 0;
    const pendingToolIds = new Map<string, number[]>();

    const unsub = ag.subscribe((event: any) => {
      if (event.type === "message_start" && event.message?.role === "assistant") {
        this._post({ type: "turn-start" });
        lastAssistantText = "";
      }
      if (event.type === "message_update") {
        const evt = event.assistantMessageEvent;
        if (evt?.type === "text_delta") {
          lastAssistantText += evt.delta;
          this._post({ type: "token", text: evt.delta });
        }
      }
      if (event.type === "tool_execution_start") {
        if (event.toolName === "read" && event.args?.path) {
          filesRead.add(event.args.path);
        }
        const id = ++toolIdCounter;
        const queue = pendingToolIds.get(event.toolName) || [];
        queue.push(id);
        pendingToolIds.set(event.toolName, queue);
        this._post({ type: "tool-start", tool: event.toolName, toolId: id, description: this._toolDescription(event.toolName, event.args) });
      }
      if (event.type === "tool_execution_end") {
        const queue = pendingToolIds.get(event.toolName) || [];
        const id = queue.shift() || 0;
        this._post({
          type: "tool-end",
          tool: event.toolName,
          toolId: id,
          isError: !!event.isError,
        });
      }
    });
    this._currentUnsub = unsub;

    try {
      this._log.appendLine(`[research-view] Continuing agent with file context: ${opts.filePath}`);
      await ag.continue();
      await ag.waitForIdle();

      if (lastAssistantText.trim()) {
        appendResearchContext(
          sessionId,
          opts.query,
          lastAssistantText.trim(),
          [opts.filePath, ...filesRead],
          this._log,
        );
        this._post({ type: "context-updated" });
        this._sendSessionsUpdate();
      }

      saveAgentMessages(sessionId, [...ag.state.messages]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log.appendLine(`[research:error] ${msg}`);
      this._post({ type: "error", text: msg });
    } finally {
      unsub();
      this._currentUnsub = undefined;
      this._post({ type: "done" });
    }
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
