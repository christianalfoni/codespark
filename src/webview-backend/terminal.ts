import * as vscode from "vscode";

export class TerminalManager {
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

  run(command: string): void {
    const terminal = this._getTerminal();
    terminal.show();
    terminal.sendText(command);
  }
}
