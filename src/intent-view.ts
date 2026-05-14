import * as path from "path";
import * as vscode from "vscode";
import { IntentScanner, IntentStep } from "./intent-scanner";

export class IntentViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "codeSpark.intents";

  private _view?: vscode.WebviewView;

  constructor(
    private readonly _workspaceFolder: string,
    private readonly _intentScanner: IntentScanner,
  ) {
    _intentScanner.onChange((steps) => this._update(steps));
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage((msg: { type: string; filePath: string; line: number }) => {
      if (msg.type === "open") {
        const absPath = path.isAbsolute(msg.filePath)
          ? msg.filePath
          : path.join(this._workspaceFolder, msg.filePath);
        const uri = vscode.Uri.file(absPath);
        vscode.window.showTextDocument(uri, {
          selection: new vscode.Range(msg.line - 1, 0, msg.line - 1, 0),
        });
      }
    });

    this._update(this._intentScanner.getSteps());
  }

  private _update(steps: IntentStep[]): void {
    if (!this._view) return;

    this._view.badge = {
      value: steps.length,
      tooltip: `${steps.length} intent comment${steps.length === 1 ? "" : "s"}`,
    };

    this._view.webview.html = this._buildHtml(steps);
  }

  private _buildHtml(steps: IntentStep[]): string {
    const items = steps
      .map(
        (s) => `
        <div class="step" data-file="${esc(s.filePath)}" data-line="${s.lineNumber}">
          <span class="step-keyword step-keyword--${s.keyword.toLowerCase()}">${s.keyword[0]}</span>
          <div class="step-info">
            <span class="step-title">${esc(s.description)}</span>
            <span class="step-location">${esc(s.filePath)}:${s.lineNumber}</span>
          </div>
        </div>`,
      )
      .join("");

    const empty = steps.length === 0
      ? `<div class="empty">No intent comments found</div>`
      : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: transparent;
  padding: 4px 0;
}
.step {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 5px 12px;
  cursor: pointer;
}
.step:hover { background: var(--vscode-list-hoverBackground); }
.step-keyword {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  flex-shrink: 0;
  margin-top: 1px;
}
.step-keyword--modify {
  background: color-mix(in srgb, var(--vscode-testing-iconQueued) 20%, transparent);
  color: var(--vscode-testing-iconQueued);
}
.step-keyword--add {
  background: color-mix(in srgb, var(--vscode-testing-iconPassed) 20%, transparent);
  color: var(--vscode-testing-iconPassed);
}
.step-keyword--remove {
  background: color-mix(in srgb, var(--vscode-testing-iconFailed) 20%, transparent);
  color: var(--vscode-testing-iconFailed);
}
.step-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.step-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.step-location {
  font-size: 11px;
  opacity: 0.6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.empty {
  padding: 12px;
  opacity: 0.5;
  font-style: italic;
}
</style>
</head>
<body>
${items}${empty}
<script>
const vscode = acquireVsCodeApi();
document.querySelectorAll('.step').forEach(el => {
  el.addEventListener('click', () => {
    vscode.postMessage({ type: 'open', filePath: el.dataset.file, line: parseInt(el.dataset.line, 10) });
  });
});
</script>
</body>
</html>`;
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
