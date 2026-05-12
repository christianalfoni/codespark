import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Exported Types
// ---------------------------------------------------------------------------

export interface IntentStep {
  keyword: "MODIFY" | "ADD" | "REMOVE";
  description: string;
  filePath: string; // workspace-relative
  lineNumber: number; // 1-based
}

export type IntentChangeListener = (steps: IntentStep[]) => void;

export interface IntentScanner {
  getSteps(): IntentStep[];
  onChange(listener: IntentChangeListener): { dispose(): void };
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Exported Functions
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".go", ".rs", ".java", ".py", ".cs", ".cpp", ".c", ".h",
  ".swift", ".kt", ".rb", ".php", ".sh", ".bash",
  ".vue", ".svelte", ".css", ".scss", ".less",
  ".md", ".yaml", ".yml", ".toml", ".json", ".xml", ".html",
]);

const INTENT_RE = /^\s*(?:\/\/|#|--|{?\s*\/\*|<!--)\s*(MODIFY|ADD|REMOVE):\s*(.+?)(?:\s*(?:\*\/\s*}?|-->))?\s*$/;

export function startIntentScanner(
  workspaceFolder: string,
  log: vscode.OutputChannel,
): IntentScanner {
  let _steps: IntentStep[] = [];
  const _listeners = new Set<IntentChangeListener>();

  function notify() {
    for (const cb of _listeners) {
      cb(_steps);
    }
  }

  function scanFileContent(relativePath: string, content: string): IntentStep[] {
    const results: IntentStep[] = [];
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = INTENT_RE.exec(lines[i]);
      if (match) {
        results.push({
          keyword: match[1] as IntentStep["keyword"],
          description: match[2].trim(),
          filePath: relativePath,
          lineNumber: i + 1,
        });
      }
    }
    return results;
  }

  function scanFile(absolutePath: string): IntentStep[] {
    try {
      const content = fs.readFileSync(absolutePath, "utf8");
      const relative = path.relative(workspaceFolder, absolutePath).replace(/\\/g, "/");
      return scanFileContent(relative, content);
    } catch {
      return [];
    }
  }

  async function initialScan() {
    try {
      const uris = await vscode.workspace.findFiles(
        "**/*",
        "{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/.next/**,**/.nuxt/**}",
      );

      const found: IntentStep[] = [];
      for (const uri of uris) {
        const ext = path.extname(uri.fsPath).toLowerCase();
        if (!TEXT_EXTENSIONS.has(ext)) continue;
        found.push(...scanFile(uri.fsPath));
      }

      found.sort((a, b) =>
        a.filePath !== b.filePath
          ? a.filePath.localeCompare(b.filePath)
          : a.lineNumber - b.lineNumber,
      );

      _steps = found;
      log.appendLine(`[intent-scanner] Initial scan: ${_steps.length} intent(s) found`);
      notify();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.appendLine(`[intent-scanner] Scan error: ${msg}`);
    }
  }

  initialScan();

  const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
    const ext = path.extname(doc.uri.fsPath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) return;

    const relative = path.relative(workspaceFolder, doc.uri.fsPath).replace(/\\/g, "/");
    const fresh = scanFileContent(relative, doc.getText());

    // Replace steps for this file, keep all others
    const others = _steps.filter((s) => s.filePath !== relative);
    _steps = [...others, ...fresh].sort((a, b) =>
      a.filePath !== b.filePath
        ? a.filePath.localeCompare(b.filePath)
        : a.lineNumber - b.lineNumber,
    );

    log.appendLine(
      `[intent-scanner] Saved ${relative}: ${fresh.length} intent(s), total ${_steps.length}`,
    );
    notify();
  });

  const deleteListener = vscode.workspace.onDidDeleteFiles((event) => {
    let changed = false;
    for (const uri of event.files) {
      const relative = path.relative(workspaceFolder, uri.fsPath).replace(/\\/g, "/");
      const before = _steps.length;
      _steps = _steps.filter((s) => !s.filePath.startsWith(relative));
      if (_steps.length !== before) {
        log.appendLine(`[intent-scanner] Deleted ${relative}: removed ${before - _steps.length} intent(s)`);
        changed = true;
      }
    }
    if (changed) notify();
  });

  return {
    getSteps() {
      return _steps;
    },
    onChange(listener) {
      _listeners.add(listener);
      return {
        dispose() {
          _listeners.delete(listener);
        },
      };
    },
    dispose() {
      saveListener.dispose();
      deleteListener.dispose();
      _listeners.clear();
    },
  };
}
