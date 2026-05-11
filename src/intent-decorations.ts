import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Exported Types
// ---------------------------------------------------------------------------

export interface Disposable {
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Exported Functions
// ---------------------------------------------------------------------------

const KEYWORD_RE = /(?:\/\/|#|--|{?\s*\/\*|<!--)\s*(MODIFY|ADD|REMOVE):/g;

const KEYWORD_COLORS: Record<string, string> = {
  MODIFY: "testing.iconQueued",
  ADD: "testing.iconPassed",
  REMOVE: "testing.iconFailed",
};

export function startIntentDecorations(
  context: vscode.ExtensionContext,
): Disposable {
  const decorationTypes: Record<string, vscode.TextEditorDecorationType> = {};
  for (const [keyword, colorId] of Object.entries(KEYWORD_COLORS)) {
    const type = vscode.window.createTextEditorDecorationType({
      color: new vscode.ThemeColor(colorId),
      fontWeight: "bold",
    });
    context.subscriptions.push(type);
    decorationTypes[keyword] = type;
  }

  function applyToEditor(editor: vscode.TextEditor) {
    const buckets: Record<string, vscode.Range[]> = { MODIFY: [], ADD: [], REMOVE: [] };
    const doc = editor.document;

    for (let i = 0; i < doc.lineCount; i++) {
      const line = doc.lineAt(i);
      KEYWORD_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = KEYWORD_RE.exec(line.text)) !== null) {
        const keyword = match[1];
        const keywordStart = match.index + match[0].indexOf(keyword);
        const keywordEnd = keywordStart + keyword.length;
        buckets[keyword].push(new vscode.Range(i, keywordStart, i, keywordEnd));
      }
    }

    for (const keyword of Object.keys(decorationTypes)) {
      editor.setDecorations(decorationTypes[keyword], buckets[keyword]);
    }
  }

  function applyToAllVisible() {
    for (const editor of vscode.window.visibleTextEditors) {
      applyToEditor(editor);
    }
  }

  applyToAllVisible();

  const subs = [
    vscode.window.onDidChangeVisibleTextEditors(applyToAllVisible),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const editor = vscode.window.visibleTextEditors.find(
        (ed) => ed.document.uri.fsPath === e.document.uri.fsPath,
      );
      if (editor) applyToEditor(editor);
    }),
  ];

  return {
    dispose() {
      for (const s of subs) s.dispose();
    },
  };
}
