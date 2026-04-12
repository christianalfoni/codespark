import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
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
import {
  getEditLog,
  getEditLogCount,
  clearEditLog,
  type EditLogEntry,
} from "./edit-log";
import type { SuggestionData } from "./ipc-server";

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
  private _isReviewMode = false;
  private _reviewSuggestions: Array<{
    id: string;
    description: string;
    filePath: string;
    isNewFile: boolean;
    proposedContent: string;
    originalContent: string;
  }> = [];
  private _mcpConfigPath?: string;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _log: vscode.OutputChannel,
  ) {}

  public setMcpConfigPath(configPath: string): void {
    this._mcpConfigPath = configPath;
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
        case "review-edits":
          this._handleReviewEdits();
          break;
        case "suggestion-action":
          this._handleSuggestionAction(msg.action, msg.id);
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
    // Send current edit log count
    this._post({ type: "edit-log-count", count: getEditLogCount() });
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
  }

  private _exitReviewModeIfActive(): void {
    if (!this._isReviewMode) return;
    this._isReviewMode = false;
    this._reviewSuggestions = [];
    clearEditLog();
    this._post({ type: "review-mode", active: false });
    this._post({ type: "edit-log-count", count: 0 });
  }

  private _handleNewSession(currentEntries: any[]): void {
    this._exitReviewModeIfActive();
    this._saveCurrentSession(currentEntries);
    this._cancelCurrent();
    this._pendingFileContext = undefined;
    createSession();
    this._sendSessionsUpdate();
  }

  private _handleSwitchSession(id: string, currentEntries: any[]): void {
    this._exitReviewModeIfActive();
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

  private async _handlePrompt(text: string): Promise<void> {
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

    // Check if session has a saved SDK session ID for resume
    const session = getActiveSession();
    const savedSdkSessionId = session?.agentMessages?.[0]?.sdkSessionId;

    const handle = startResearchQuery(
      text,
      workspaceFolder,
      this._log,
      sessionId,
      savedSdkSessionId,
    );

    try {
      for await (const evt of iterateResearchEvents(handle, this._log)) {
        if (evt.type === "done") {
          if (evt.resultText.trim()) {
            appendResearchContext(sessionId, text, evt.resultText.trim(), [], this._log);
            this._post({ type: "context-updated" });
            this._sendSessionsUpdate();
          }
          if (evt.sdkSessionId) {
            saveAgentMessages(sessionId, [{ sdkSessionId: evt.sdkSessionId }]);
          }
          this._post({ type: "done" });
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

    let sessionId = getActiveSessionId();
    if (!sessionId) {
      const session = createSession();
      sessionId = session.id;
      this._sendSessionsUpdate();
    }

    // Prepend file content to the prompt so the agent has context
    const contextPrompt = `Currently viewing \`${opts.filePath}\` (line ${opts.cursorLine}):\n\`\`\`\n${opts.fileContent}\n\`\`\`\n\n${opts.query}`;

    const session = getActiveSession();
    const savedSdkSessionId = session?.agentMessages?.[0]?.sdkSessionId;

    const handle = startResearchQuery(
      contextPrompt,
      workspaceFolder,
      this._log,
      sessionId,
      savedSdkSessionId,
    );

    try {
      for await (const evt of iterateResearchEvents(handle, this._log)) {
        if (evt.type === "done") {
          if (evt.resultText.trim()) {
            appendResearchContext(
              sessionId,
              opts.query,
              evt.resultText.trim(),
              [opts.filePath],
              this._log,
            );
            this._post({ type: "context-updated" });
            this._sendSessionsUpdate();
          }
          if (evt.sdkSessionId) {
            saveAgentMessages(sessionId, [{ sdkSessionId: evt.sdkSessionId }]);
          }
          this._post({ type: "done" });
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
  }

  // ── Review mode ────────────────────────────────────────────

  public updateEditLogCount(): void {
    this._post({ type: "edit-log-count", count: getEditLogCount() });
  }

  public handleSuggestionsFromIpc(suggestions: SuggestionData[]): void {
    const workspaceFolder =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) return;

    this._reviewSuggestions = suggestions.map((s, i) => {
      const absPath = path.resolve(workspaceFolder, s.filePath);
      let originalContent = "";
      let isNewFile = true;
      try {
        originalContent = fs.readFileSync(absPath, "utf-8");
        isNewFile = false;
      } catch {
        // file doesn't exist — new file
      }
      return {
        id: `suggestion-${Date.now()}-${i}`,
        description: s.description,
        filePath: s.filePath,
        isNewFile,
        proposedContent: s.proposedContent,
        originalContent,
      };
    });

    this._post({
      type: "review-suggestions",
      suggestions: this._reviewSuggestions,
    });
  }

  private async _handleReviewEdits(): Promise<void> {
    const workspaceFolder =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      this._post({ type: "error", text: "No workspace folder open." });
      this._post({ type: "done" });
      return;
    }

    const editLog = getEditLog();
    if (editLog.length === 0) {
      this._post({ type: "error", text: "No edits to review." });
      this._post({ type: "done" });
      return;
    }

    // Enter review mode
    this._isReviewMode = true;
    this._post({ type: "review-mode", active: true });

    // Write edit log to a temp file so the agent can read it via tools
    const editLogContent = editLog
      .map(
        (e, i) =>
          `## Edit ${i + 1}: ${e.filePath}\n\n**Instruction:** ${e.instruction}\n\n**Changes:**\n\`\`\`diff\n${e.diff}\n\`\`\``,
      )
      .join("\n\n---\n\n");

    const tmpDir = path.join(os.tmpdir(), "codespark-review");
    fs.mkdirSync(tmpDir, { recursive: true });
    const editLogFile = path.join(tmpDir, `edit-log-${Date.now()}.md`);
    fs.writeFileSync(editLogFile, editLogContent, "utf-8");

    const prompt = `Review the user's recent inline edits for patterns that should be codified into CLAUDE.md instruction files.

1. Read the edit log at \`${editLogFile}\`
2. Use Glob to find any existing \`**/CLAUDE.md\` files, then Read them to understand what's already documented
3. Look for recurring patterns, conventions, or corrections across the edits
4. Identify rules that would help the inline agent make better edits in the future
5. Use the \`update_suggestions\` tool to propose CLAUDE.md changes
6. Focus on patterns, not one-off fixes
7. Consider whether a rule belongs in the root CLAUDE.md or a subdirectory-specific one
8. If existing CLAUDE.md files already cover a pattern, skip it or suggest refinements
9. Each suggestion should include the FULL proposed content for the file (not just the addition)

After calling update_suggestions, respond only with "Suggestions updated" — do not summarize the suggestions, they are already visible to the user.`;

    // Show as a user message in the webview
    this._post({ type: "inject-user", text: "Review my recent inline edits for CLAUDE.md suggestions" });

    // Ensure we have a session
    let sessionId = getActiveSessionId();
    if (!sessionId) {
      const session = createSession();
      sessionId = session.id;
      this._sendSessionsUpdate();
    }

    const handle = startResearchQuery(
      prompt,
      workspaceFolder,
      this._log,
      sessionId,
      undefined,
      {
        tools: "Read,Glob,Grep,mcp__codespark__update_suggestions",
        mcpConfigPath: this._mcpConfigPath,
      },
    );

    try {
      for await (const evt of iterateResearchEvents(handle, this._log)) {
        if (evt.type === "done") {
          if (evt.resultText.trim()) {
            appendResearchContext(
              sessionId,
              "Review inline edits for CLAUDE.md suggestions",
              evt.resultText.trim(),
              [],
              this._log,
            );
            this._post({ type: "context-updated" });
            this._sendSessionsUpdate();
          }
          if (evt.sdkSessionId) {
            saveAgentMessages(sessionId, [{ sdkSessionId: evt.sdkSessionId }]);
          }
          this._post({ type: "done" });
        } else {
          this._post(evt);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log.appendLine(`[research:review-error] ${msg}`);
      this._post({ type: "error", text: msg });
      this._post({ type: "done" });
    }
  }

  private async _handleSuggestionAction(
    action: string,
    id?: string,
  ): Promise<void> {
    const workspaceFolder =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (action === "diff" && id) {
      const suggestion = this._reviewSuggestions.find((s) => s.id === id);
      if (!suggestion || !workspaceFolder) return;

      // Create temp file with proposed content
      const tmpDir = path.join(os.tmpdir(), "codespark-review");
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `proposed-${path.basename(suggestion.filePath)}`);
      fs.writeFileSync(tmpFile, suggestion.proposedContent, "utf-8");

      const proposedUri = vscode.Uri.file(tmpFile);

      if (suggestion.isNewFile) {
        // Show proposed content in a regular editor
        const doc = await vscode.workspace.openTextDocument(proposedUri);
        await vscode.window.showTextDocument(doc, { preview: true });
      } else {
        const originalUri = vscode.Uri.file(
          path.resolve(workspaceFolder, suggestion.filePath),
        );
        await vscode.commands.executeCommand(
          "vscode.diff",
          originalUri,
          proposedUri,
          `${suggestion.filePath} (proposed changes)`,
        );
      }
      return;
    }

    if (action === "approve-all" && workspaceFolder) {
      for (const suggestion of this._reviewSuggestions) {
        const absPath = path.resolve(workspaceFolder, suggestion.filePath);
        const dir = path.dirname(absPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(absPath, suggestion.proposedContent, "utf-8");
        this._log.appendLine(`[review] Applied suggestion to ${suggestion.filePath}`);
      }
    }

    // Both approve-all and dismiss exit review mode and clear the log
    this._exitReviewModeIfActive();
    this._cancelCurrent();

    // Start a fresh session
    createSession();
    this._post({
      type: "restore",
      entries: [],
      sessions: getSessionInfos(),
      activeSessionId: getActiveSessionId(),
      hasContext: false,
    });
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
