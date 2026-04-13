import * as vscode from "vscode";
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
  getLastClaudeMdCheckSha,
  setLastClaudeMdCheckSha,
} from "./research-agent";
import { execSync } from "child_process";

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

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _log: vscode.OutputChannel,
    private readonly _mcpConfigPath?: string,
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
        case "claude-md-review":
          this._handleClaudeMdReview(msg.currentEntries);
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

  private _getCommitsSinceLastCheck(): number {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) return 0;

    const lastSha = getLastClaudeMdCheckSha();
    try {
      if (lastSha) {
        const count = execSync(`git rev-list ${lastSha}..HEAD --count`, {
          cwd: workspaceFolder,
          encoding: "utf-8",
        }).trim();
        return parseInt(count, 10) || 0;
      }
      // No previous check — count all commits
      const count = execSync("git rev-list HEAD --count", {
        cwd: workspaceFolder,
        encoding: "utf-8",
      }).trim();
      return parseInt(count, 10) || 0;
    } catch {
      return 0;
    }
  }

  private _getCurrentCommitSha(): string | undefined {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) return undefined;
    try {
      return execSync("git rev-parse HEAD", {
        cwd: workspaceFolder,
        encoding: "utf-8",
      }).trim();
    } catch {
      return undefined;
    }
  }

  private _sendInit(): void {
    const commitsSinceLastCheck = this._getCommitsSinceLastCheck();
    const session = getActiveSession();
    if (session && session.entries.length > 0) {
      this._post({
        type: "restore",
        entries: session.entries,
        sessions: getSessionInfos(),
        activeSessionId: getActiveSessionId(),
        hasContext: !!session.summary,
        commitsSinceLastCheck,
      });
    } else {
      this._post({
        type: "init",
        hasContext: !!getResearchSummary(),
        sessions: getSessionInfos(),
        activeSessionId: getActiveSessionId(),
        commitsSinceLastCheck,
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
        commitsSinceLastCheck: this._getCommitsSinceLastCheck(),
      });
    }
  }

  private _handleClaudeMdReview(currentEntries: any[]): void {
    this._saveCurrentSession(currentEntries);
    this._cancelCurrent();
    this._pendingFileContext = undefined;

    // Capture the previous check SHA before updating it
    const previousSha = getLastClaudeMdCheckSha();

    // Record current HEAD so we know when we last checked
    const currentSha = this._getCurrentCommitSha();
    if (currentSha) {
      setLastClaudeMdCheckSha(currentSha);
    }

    // Create a named session
    createSession("CLAUDE.md Review");
    this._sendSessionsUpdate();

    // Build the preset prompt
    const rangeHint = previousSha
      ? ` Focus on changes since commit ${previousSha.slice(0, 8)}.`
      : "";

    const prompt =
      `Based on any current and recent historic changes to my codebase, do you find any newly emerged patterns, styles, or violations to my existing patterns and styles?${rangeHint}\n\n` +
      `Review the existing CLAUDE.md files in the project and suggest specific additions or updates based on what you find. ` +
      `Also recommend creating new CLAUDE.md files in folders that could benefit from domain-specific instructions relevant to that folder's purpose.\n\n` +
      `Format all suggestions as markdown code blocks that can be copied directly into the target CLAUDE.md file. ` +
      `For each suggestion, specify the file path it applies to (e.g. \`src/components/CLAUDE.md\`) followed by the markdown block.`;

    // Inject user message + start streaming in the webview
    this._post({ type: "inject-user", text: prompt });

    // Fire the prompt
    this._handlePrompt(prompt);
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
      this._mcpConfigPath,
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
      this._post({ type: "tool-start", tool: "read_reference", toolId: -1, description: opts.filePath });
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
    this._post({ type: "tool-start", tool: "read_reference", toolId: -1, description: ctx.filePath });
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
      this._mcpConfigPath,
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
