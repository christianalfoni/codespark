import * as vscode from "vscode";

export interface InlinePromptDecorations {
  update(value: string, caret?: number): void;
  dispose(): void;
}

/**
 * Renders ghost text on `ghostLine` that mirrors the user's prompt as they
 * type. The decoration type is created once and updated via per-range
 * renderOptions so keystrokes don't flicker.
 */
export function createInlinePromptDecorations(
  editor: vscode.TextEditor,
  ghostLine: number,
): InlinePromptDecorations {
  const ghostType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: "var(--vscode-input-background)",
  });

  function render(value: string, caret?: number) {
    const pos = Math.max(0, Math.min(caret ?? value.length, value.length));
    const contentText = `› ${value.slice(0, pos)}▍${value.slice(pos)}`;

    editor.setDecorations(ghostType, [
      {
        range: new vscode.Range(ghostLine, 0, ghostLine, 0),
        renderOptions: {
          after: {
            contentText,
            color: "var(--vscode-input-foreground)",
          },
        },
      },
    ]);
  }

  render("");

  return {
    update: render,
    dispose() {
      ghostType.dispose();
    },
  };
}
