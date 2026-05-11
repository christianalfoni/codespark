import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Exported Functions
// ---------------------------------------------------------------------------

export function registerIntentCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.toggleIntentComment", () =>
      toggleIntentComment(),
    ),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEYWORDS = ["MODIFY", "ADD", "REMOVE"] as const;
type Keyword = (typeof KEYWORDS)[number];

// Matches an existing intent comment line, capturing prefix, keyword, and the rest
const LINE_INTENT_RE = /^(\s*(?:\/\/|#|--|{?\s*\/\*|<!--)\s*)(MODIFY|ADD|REMOVE)(:.*)$/;

function toggleIntentComment(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const line = editor.document.lineAt(editor.selection.active.line);
  const match = LINE_INTENT_RE.exec(line.text);

  if (match) {
    const [, prefix, keyword, rest] = match;
    const currentIdx = KEYWORDS.indexOf(keyword as Keyword);
    const nextIdx = currentIdx + 1;

    if (nextIdx >= KEYWORDS.length) {
      // Cycled through all — delete the comment line
      editor.edit((b) => b.delete(line.rangeIncludingLineBreak));
    } else {
      // Advance to next keyword, preserve description
      editor.edit((b) =>
        b.replace(line.range, `${prefix}${KEYWORDS[nextIdx]}${rest}`),
      );
    }
  } else {
    // No intent comment on this line — insert MODIFY
    const { before, after } = getCommentStyle(
      editor.document.languageId,
      editor.document,
      editor.selection.active,
    );
    const indent = line.text.match(/^(\s*)/)?.[1] ?? "";
    const isEmptyLine = line.text.trim() === "";
    const pos = new vscode.Position(line.lineNumber, 0);
    editor.insertSnippet(
      new vscode.SnippetString(`${indent}${before}MODIFY: $0${after}${isEmptyLine ? "" : "\n"}`),
      pos,
    );
  }
}

function getCommentStyle(
  languageId: string,
  document: vscode.TextDocument,
  position: vscode.Position,
): { before: string; after: string } {
  switch (languageId) {
    case "javascriptreact":
    case "typescriptreact":
      return isInJsxContext(document, position)
        ? { before: "{/* ", after: " */}" }
        : { before: "// ", after: "" };

    case "python":
    case "ruby":
    case "shellscript":
    case "yaml":
    case "toml":
    case "perl":
    case "r":
      return { before: "# ", after: "" };

    case "sql":
    case "mysql":
    case "lua":
    case "haskell":
      return { before: "-- ", after: "" };

    case "html":
    case "xml":
    case "markdown":
      return { before: "<!-- ", after: " -->" };

    case "css":
    case "scss":
    case "less":
      return { before: "/* ", after: " */" };

    default:
      return { before: "// ", after: "" };
  }
}

/**
 * Heuristic: scan backwards from the cursor for an unclosed JSX element.
 * Counts `<Tag` opens vs `</Tag` and `/>` closes. If opens > closes we're in JSX.
 */
function isInJsxContext(
  document: vscode.TextDocument,
  position: vscode.Position,
): boolean {
  const openRe = /<[A-Za-z]/g;
  const closeRe = /<\/[A-Za-z]|\/>/g;

  let depth = 0;
  const start = Math.max(0, position.line - 50);

  for (let i = position.line; i >= start; i--) {
    const text = document.lineAt(i).text;
    const trimmed = text.trim();
    if (
      /^(const|let|var|function|class|import|export|return|if|for|while|\/\/)/.test(
        trimmed,
      )
    ) {
      return false;
    }
    const opens = (text.match(openRe) ?? []).length;
    const closes = (text.match(closeRe) ?? []).length;
    depth += closes - opens;
    if (depth < 0) return true;
  }

  return false;
}
