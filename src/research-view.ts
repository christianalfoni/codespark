import * as vscode from "vscode";
import {
  ensureResearchAgent,
  resolveModel,
  resolveResearchModel,
  clearResearchSummary,
  getResearchSummary,
  appendResearchContext,
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
  private _currentAgent?: any;
  private _currentUnsub?: () => void;

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
          this._handlePrompt(msg.text);
          break;
        case "cancel":
          this._cancelCurrent();
          break;
        case "clear":
          this._cancelCurrent();
          break;
        case "ready":
          this._post({ type: "init", hasContext: !!getResearchSummary() });
          break;
        case "open-file":
          this._openFile(msg.path, msg.line);
          break;
        case "run-command":
          this._runInTerminal(msg.command);
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

  private _cancelCurrent(): void {
    if (this._currentAgent) {
      this._currentAgent.abort();
    }
    if (this._currentUnsub) {
      this._currentUnsub();
      this._currentUnsub = undefined;
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

  private _runInTerminal(command: string): void {
    let terminal = vscode.window.activeTerminal;
    if (!terminal) {
      terminal = vscode.window.createTerminal("CodeSpark");
    }
    terminal.show();
    terminal.sendText(command);
  }

  private async _handlePrompt(text: string): Promise<void> {
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

    this._log.appendLine(
      `[research-view] Models resolved, creating agent (head: ${headResolved.piModel?.id}, sub: ${subResolved.piModel?.id})`,
    );
    const ag = ensureResearchAgent(
      headResolved.piModel,
      subResolved.piModel,
      headResolved.apiKey,
      workspaceFolder,
      this._log,
    );
    this._currentAgent = ag;

    const filesRead = new Set<string>();
    let lastAssistantText = "";

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
        this._post({ type: "tool-start", tool: event.toolName });
      }
      if (event.type === "tool_execution_end") {
        this._post({
          type: "tool-end",
          tool: event.toolName,
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

      // Append the user prompt + final response + files to inline context
      if (lastAssistantText.trim()) {
        appendResearchContext(
          text,
          lastAssistantText.trim(),
          [...filesRead],
          this._log,
        );
        this._post({ type: "context-updated" });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log.appendLine(`[research:error] ${msg}`);
      this._post({ type: "error", text: msg });
    } finally {
      unsub();
      this._currentUnsub = undefined;
      this._currentAgent = undefined;
      this._post({ type: "done" });
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
