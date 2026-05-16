import * as vscode from "vscode";
import { getCommentStyle as getCommentStylePure } from "./intent-comment-utils";

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
    const nextIdx = (currentIdx + 1) % KEYWORDS.length;
    // rest = ": <description>[suffix]" — split off any closing delimiter so $0 lands at end of description
    const raw = rest.slice(2);
    const { desc, suffix } = splitCommentSuffix(raw);
    editor.insertSnippet(
      new vscode.SnippetString(`${prefix}${KEYWORDS[nextIdx]}: ${desc}$0${suffix}`),
      line.range,
    );
  } else {
    // No intent comment on this line — insert MODIFY
    const lines = Array.from(
      { length: editor.document.lineCount },
      (_, i) => editor.document.lineAt(i).text,
    );
    const { before, after } = getCommentStylePure(
      editor.document.languageId,
      lines,
      editor.selection.active.line,
    );
    const indent = line.text.match(/^(\s*)/)?.[1] ?? "";
    const isEmptyLine = line.text.trim() === "";
    // Replace whitespace-only lines (e.g. auto-indented blank lines) to avoid doubling the indent
    const insertTarget = isEmptyLine
      ? line.range
      : new vscode.Position(line.lineNumber, 0);
    editor.insertSnippet(
      new vscode.SnippetString(`${indent}${before}MODIFY: $0${after}${isEmptyLine ? "" : "\n"}`),
      insertTarget,
    );
  }
}

function splitCommentSuffix(text: string): { desc: string; suffix: string } {
  if (text.endsWith(" */}")) return { desc: text.slice(0, -4), suffix: " */}" };
  if (text.endsWith(" */")) return { desc: text.slice(0, -3), suffix: " */" };
  if (text.endsWith(" -->")) return { desc: text.slice(0, -4), suffix: " -->" };
  return { desc: text, suffix: "" };
}

