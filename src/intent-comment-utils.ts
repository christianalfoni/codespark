// ---------------------------------------------------------------------------
// Exported Types
// ---------------------------------------------------------------------------

export interface CommentStyle {
  before: string;
  after: string;
}

// ---------------------------------------------------------------------------
// Exported Functions
// ---------------------------------------------------------------------------

/**
 * Determines whether the insertion point (above lineIndex) is inside a JSX
 * expression. Uses a backwards scan counting unclosed JSX open tags.
 *
 * Scans from lineIndex-1 upward — we want the context of the new line being
 * inserted BEFORE lineIndex, so the element on lineIndex itself is excluded.
 *
 * Lookbehind on the open-tag regex excludes TypeScript generics (e.g.
 * Array<string>) which are preceded by an alphanumeric character.
 */
export function isInJsxContext(lines: string[], lineIndex: number): boolean {
  // `<Tag` not preceded by an alphanumeric/underscore (excludes generics)
  const openRe = /(?<![a-zA-Z0-9_])<[A-Za-z]/g;
  const closeRe = /<\/[A-Za-z]|\/>/g;
  const boundaryRe =
    /^(const|let|var|function|class|import|export|type|interface|return|if|for|while|\/\/)/;

  let depth = 0;
  const start = Math.max(0, lineIndex - 50);

  // Start from the line ABOVE the cursor — we're inserting before lineIndex,
  // so elements on that line are "ahead" and don't define the enclosing context.
  for (let i = lineIndex - 1; i >= start; i--) {
    const text = lines[i];
    const trimmed = text.trim();
    if (boundaryRe.test(trimmed)) return false;
    const opens = (text.match(openRe) ?? []).length;
    const closes = (text.match(closeRe) ?? []).length;
    depth += closes - opens;
    if (depth < 0) return true;
  }

  return false;
}

export function getCommentStyle(
  languageId: string,
  lines: string[],
  lineIndex: number,
): CommentStyle {
  switch (languageId) {
    case "javascriptreact":
    case "typescriptreact":
      return isInJsxContext(lines, lineIndex)
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
