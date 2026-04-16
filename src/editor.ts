import * as vscode from "vscode";

export interface FocusArea {
  lines: string[];
  focusStartLine: number;
  focusEndLine: number;
  enclosingBlock?: vscode.FoldingRange;
}

export async function evaluateFocusArea(
  editor: vscode.TextEditor,
): Promise<FocusArea> {
  const cursorLineNum = editor.selection.active.line;

  if (cursorLineNum === 0) {
    const lines: string[] = [];
    for (let i = 0; i < editor.document.lineCount; i++) {
      lines.push(editor.document.lineAt(i).text);
    }
    return {
      lines,
      focusStartLine: 0,
      focusEndLine: editor.document.lineCount - 1,
      enclosingBlock: undefined,
    };
  }

  let enclosingBlock: vscode.FoldingRange | undefined;
  const foldingRanges = await vscode.commands.executeCommand<
    vscode.FoldingRange[]
  >("vscode.executeFoldingRangeProvider", editor.document.uri);
  if (foldingRanges) {
    for (const range of foldingRanges) {
      if (range.start <= cursorLineNum && range.end >= cursorLineNum) {
        if (
          !enclosingBlock ||
          range.end - range.start < enclosingBlock.end - enclosingBlock.start
        ) {
          enclosingBlock = range;
        }
      }
    }
  }

  if (enclosingBlock) {
    const focusStartLine = enclosingBlock.start;
    const focusEndLine = Math.min(
      enclosingBlock.end + 1,
      editor.document.lineCount - 1,
    );
    const lines: string[] = [];
    for (let i = focusStartLine; i <= focusEndLine; i++) {
      const lineText = editor.document.lineAt(i).text;
      if (i === cursorLineNum) {
        const marker = " // <-- cursor here";
        lines.push(lineText + marker);
      } else {
        lines.push(lineText);
      }
    }
    return {
      lines,
      focusStartLine,
      focusEndLine,
      enclosingBlock,
    };
  } else {
    const focusStartLine = cursorLineNum;
    const focusEndLine = cursorLineNum;
    const snippetStart = Math.max(0, cursorLineNum - 5);
    const snippetEnd = Math.min(
      editor.document.lineCount - 1,
      cursorLineNum + 5,
    );
    const lines: string[] = [];
    for (let i = snippetStart; i <= snippetEnd; i++) {
      const prefix = i === cursorLineNum ? ">" : " ";
      lines.push(`${prefix} ${editor.document.lineAt(i).text}`);
    }
    return {
      lines,
      focusStartLine,
      focusEndLine,
      enclosingBlock: undefined,
    };
  }
}
