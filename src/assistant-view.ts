import * as vscode from "vscode";
import * as path from "path";
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

import { InstructionFileDecorationProvider } from "./instructionDecorations";
import { getHtml } from "./webview-backend/html";
import { TerminalManager } from "./webview-backend/terminal";
import { buildFileContextQuery } from "./webview-backend/file-context";
import { PendingFileContext } from "./types";
import { ApplyBreakdownStep } from "./webview-backend/apply-breakdown-step";

export class AssistantViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "codeSpark.assistant";
  private _terminalManager = new TerminalManager();
  private _applyStepRunner: ApplyBreakdownStep;
  private _view?: vscode.WebviewView;
  private _pendingFileContext?: PendingFileContext;
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
  /** Whether the webview's prompt input currently holds focus */
  private _isInputFocused = false;

  public get isInputFocused(): boolean {
    return this._isInputFocused;
  }

  private get _workspaceFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _log: vscode.OutputChannel,
    private readonly _mcpConfigPath: string | undefined,
    private readonly _ipcServer: IpcServer,
    private readonly _decorationProvider: InstructionFileDecorationProvider,
    private readonly _features: { stackedCommitsEnabled: boolean },
  ) {
    this._ipcServer.onBreakdown((steps) => {
      this._steps = steps;
      this._postBreakdown();
      this._persistBreakdown();
      this._log.appendLine(
        `[assistant-view] Breakdown created: ${steps.length} step(s)`,
      );
    });
    this._applyStepRunner = new ApplyBreakdownStep(
      _log,
      _mcpConfigPath,
      _ipcServer,
      _decorationProvider,
      (message) => {
        this._post(message);
      },
      (usage) => {
        this.reportInlineUsage(usage);
      },
    );
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

    webviewView.webview.html = getHtml(webviewView.webview, this._extensionUri);

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type !== "input-focus") {
        this._log.appendLine(
          `[assistant-view] msg: ${JSON.stringify(msg).slice(0, 200)}`,
        );
      }

      switch (msg.type) {
        case "send":
          // TODO: You can have both pending file context and step focus
          if (this._pendingFileContext) {
            this._handleSendWithContext(this._pendingFileContext, msg.text);
          } else if (msg.stepIndex !== undefined && msg.stepIndex !== null) {
            this._handleSendWithStep(msg.text, msg.stepIndex);
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
          this._terminalManager.run(msg.command);
          break;
        case "new-session":
          this._handleNewSession(msg.currentEntries);
          break;
        case "switch-session":
          this._handleSwitchSession(msg.id, msg.currentEntries);
          break;
        case "select-step":
          this._handleSelectStep(msg.index);
          break;
        case "apply-step": {
          if (!this._workspaceFolder) {
            return;
          }
          this._applyStepRunner.apply(
            this._workspaceFolder,
            this._steps[msg.index],
            msg.index,
          );
          break;
        }

        case "input-focus":
          this._isInputFocused = !!msg.focused;
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._sendInit();
      } else {
        this._isInputFocused = false;
      }
    });

    webviewView.onDidDispose(() => {
      this._cancelCurrent();
      this._view = undefined;
      this._isInputFocused = false;
    });
  }

  private _post(msg: unknown): void {
    this._view?.webview.postMessage(msg);
  }

  // --- Session lifecycle ---

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
        features: this._features,
      });
    } else {
      this._steps = session?.breakdownSteps ?? [];
      this._post({
        type: "init",
        hasContext: !!getAssistantSummary(),
        sessions: getSessionInfos(),
        activeSessionId: getActiveSessionId(),
        features: this._features,
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

  private async _openFile(
    filePath: string,
    line?: number,
    preserveFocus = false,
  ): Promise<void> {
    const workspaceFolder = this._workspaceFolder;
    if (!workspaceFolder) return;

    const absolute = path.resolve(workspaceFolder, filePath);
    const uri = vscode.Uri.file(absolute);

    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const options: vscode.TextDocumentShowOptions = { preserveFocus };
      if (line && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        options.selection = new vscode.Range(pos, pos);
      }
      await vscode.window.showTextDocument(doc, options);
    } catch {
      // File may not exist yet — that's fine, it will be created on apply
    }
  }

  // --- Breakdown ---

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

  private async _handleSelectStep(index: number | null): Promise<void> {
    if (index === null) return;

    const step = this._steps[index];
    if (!step) return;

    // Open the file and scroll to the line without stealing focus
    await this._openFile(step.filePath, step.lineHint, true);
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

  // --- Prompt event loop ---

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
    const workspaceFolder = this._workspaceFolder;
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
          if (evt.type === "usage") {
            this._log.appendLine(
              `[assistant:usage] source=${evt.source} in=${evt.inputTokens} cr=${evt.cacheReadInputTokens} cc=${evt.cacheCreationInputTokens} out=${evt.outputTokens}`,
            );
          }
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

  /** Attach file context to the current session (SHIFT+CMD+I) */
  public startFileSession(ctx: {
    filePath: string;
    cursorLine: number;
    selection?: string;
  }): void {
    const isSameFile = this._pendingFileContext?.filePath === ctx.filePath;
    this._pendingFileContext = ctx;
    this._post({
      type: "set-file-context",
      filePath: ctx.filePath,
      cursorLine: ctx.cursorLine,
      selection: ctx.selection ?? null,
    });
    this._log.appendLine(
      isSameFile
        ? `[assistant-view] Continuing file session: ${ctx.filePath}`
        : `[assistant-view] File context set: ${ctx.filePath}`,
    );
  }

  public get isVisible(): boolean {
    return !!this._view?.visible;
  }

  public focusInput(): void {
    this._post({ type: "focus" });
  }

  public reportInlineUsage(usage: {
    inputTokens: number;
    outputTokens: number;
    contextOutputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  }): void {
    this._post({
      type: "usage",
      source: "inline",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      contextOutputTokens: usage.contextOutputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
    });
  }

  private async _handleSendWithContext(
    ctx: PendingFileContext,
    text: string,
  ): Promise<void> {
    if (!this._workspaceFolder) {
      return;
    }

    const query = await buildFileContextQuery(ctx, this._workspaceFolder, text);

    this._log.appendLine(`[assistant-view:prompt] ${query}`);
    await this._handlePrompt(query, [ctx.filePath]);
  }

  private async _handleSendWithStep(
    text: string,
    stepIndex: number,
  ): Promise<void> {
    const step = this._steps[stepIndex];
    if (!step) {
      this._handlePrompt(text);
      return;
    }

    const stepContext = `[Regarding breakdown step ${stepIndex + 1}: "${step.title}" in \`${step.filePath}${step.lineHint ? `:${step.lineHint}` : ""}\`]\n\n${text}`;
    await this._handlePrompt(stepContext);
  }

  /** Called from outside to save webview entries into the active session */
  public saveEntries(entries: any[]): void {
    const sessionId = getActiveSessionId();
    if (sessionId) {
      updateSessionEntries(sessionId, entries);
    }
  }
}
