import * as vscode from "vscode";
import * as path from "path";
import { StrReplaceEdit } from "./types";

const gutterIconPath = path.join(__dirname, "..", "media", "gutter-changed.svg");

const changedDecorationType = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  gutterIconPath,
  gutterIconSize: "contain",
  overviewRulerColor: '#DA7756',
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

let originalContent: string | undefined;
let pendingEditor: vscode.TextEditor | undefined;

export function hasPendingDiff(): boolean {
  return originalContent !== undefined;
}

function clearState(): void {
  if (pendingEditor) {
    pendingEditor.setDecorations(changedDecorationType, []);
  }
  originalContent = undefined;
  pendingEditor = undefined;
  vscode.commands.executeCommand("setContext", "codeSpark.hasPendingDiff", false);
}

export function registerDiffHandlers(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc: vscode.TextDocument) => {
      if (pendingEditor && doc === pendingEditor.document) {
        clearState();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) => {
      if (pendingEditor && e.document === pendingEditor.document && e.reason === vscode.TextDocumentChangeReason.Undo) {
        clearState();
      }
    })
  );
}

/**
 * Compare the current editor buffer against the original content.
 * The agent applies edits via WorkspaceEdit so the buffer is already updated.
 * Returns true if the file changed.
 */
export async function applyDiffFromBuffer(
  editor: vscode.TextEditor,
  savedOriginalContent: string,
  log: vscode.OutputChannel
): Promise<boolean> {
  const newContent = editor.document.getText();

  if (newContent === savedOriginalContent) {
    return false;
  }

  originalContent = savedOriginalContent;
  pendingEditor = editor;

  log.appendLine(`[diff] Buffer changed, setting up diff decorations`);

  // Compute simple line-level diff for decorations
  const oldLines = savedOriginalContent.split("\n");
  const newLines = newContent.split("\n");
  const decorations: vscode.DecorationOptions[] = [];

  for (let i = 0; i < newLines.length; i++) {
    if (i >= oldLines.length || newLines[i] !== oldLines[i]) {
      const line = editor.document.lineAt(Math.min(i, editor.document.lineCount - 1));
      decorations.push({ range: line.range });
    }
  }

  editor.setDecorations(changedDecorationType, decorations);

  await vscode.commands.executeCommand(
    "setContext",
    "codeSpark.hasPendingDiff",
    true
  );

  return true;
}

export async function applyEdits(
  editor: vscode.TextEditor,
  edits: StrReplaceEdit[],
  log: vscode.OutputChannel
): Promise<void> {
  const document = editor.document;
  originalContent = document.getText();
  pendingEditor = editor;

  const text = document.getText();
  const editStart = Date.now();

  const applied = await editor.edit((editBuilder) => {
    for (const edit of edits) {
      if (edit.insert_line !== undefined) {
        // Insert after a specific line (0 = beginning of file)
        const line = edit.insert_line;
        if (line === 0) {
          editBuilder.insert(new vscode.Position(0, 0), edit.new_str + "\n");
        } else {
          const targetLine = document.lineAt(Math.min(line - 1, document.lineCount - 1));
          editBuilder.insert(targetLine.range.end, "\n" + edit.new_str);
        }
        log.appendLine(`[diff] Inserting after line ${line}`);
      } else {
        const idx = text.indexOf(edit.old_str);
        if (idx === -1) {
          log.appendLine(`[diff] EDIT NOT MATCHED: ${JSON.stringify(edit.old_str).slice(0, 200)}`);
          continue;
        }
        const startPos = document.positionAt(idx);
        const endPos = document.positionAt(idx + edit.old_str.length);
        log.appendLine(`[diff] Replacing lines ${startPos.line}-${endPos.line}`);
        editBuilder.replace(new vscode.Range(startPos, endPos), edit.new_str);
      }
    }
  });

  log.appendLine(`[diff] Edit applied: ${applied} (${Date.now() - editStart}ms)`);

  // Decorate changed regions
  const decorations: vscode.DecorationOptions[] = [];
  const newText = document.getText();

  for (const edit of edits) {
    if (edit.new_str) {
      const idx = newText.indexOf(edit.new_str);
      if (idx !== -1) {
        const startPos = document.positionAt(idx);
        const endPos = document.positionAt(idx + edit.new_str.length);
        decorations.push({ range: new vscode.Range(startPos, endPos) });
      }
    }
  }
  editor.setDecorations(changedDecorationType, decorations);

  await vscode.commands.executeCommand(
    "setContext",
    "codeSpark.hasPendingDiff",
    true
  );
}

export async function acceptDiff(): Promise<void> {
  if (!pendingEditor) {
    return;
  }
  clearState();
}

export async function rejectDiff(): Promise<void> {
  if (!pendingEditor || originalContent === undefined) {
    return;
  }
  const editor = pendingEditor;
  const fullRange = new vscode.Range(
    editor.document.positionAt(0),
    editor.document.positionAt(editor.document.getText().length)
  );
  await editor.edit((editBuilder) => {
    editBuilder.replace(fullRange, originalContent!);
  });
  clearState();
}
