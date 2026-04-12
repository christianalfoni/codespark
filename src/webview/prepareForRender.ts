/**
 * Repairs incomplete markdown so it renders cleanly during streaming.
 * Applied at render time only — the raw buffer stays untouched.
 */
export function prepareForRender(buffer: string): string {
  if (!buffer) return buffer;

  // 1. Handle fenced code blocks first
  const fenceState = getFenceState(buffer);

  if (fenceState) {
    // Inside an open code block — only close the fence, skip inline repairs
    return buffer + "\n" + fenceState.closer;
  }

  let result = buffer;

  // 2. Strip incomplete links/images at the end
  result = stripIncompleteLinks(result);

  // 3. Auto-close inline constructs
  result = closeInlineCode(result);
  result = closeBoldItalic(result);
  result = closeStrikethrough(result);

  // 4. Repair incomplete table rows
  result = repairTableRow(result);

  return result;
}

// ---------------------------------------------------------------------------
// Fenced code blocks
// ---------------------------------------------------------------------------

const FENCE_RE = /^(`{3,}|~{3,})/gm;

function getFenceState(
  buffer: string,
): { closer: string } | null {
  let open: string | null = null;

  for (const match of buffer.matchAll(FENCE_RE)) {
    const fence = match[1];
    if (!open) {
      open = fence;
    } else if (fence[0] === open[0] && fence.length >= open.length) {
      open = null;
    }
  }

  if (!open) return null;
  return { closer: open[0].repeat(open.length) };
}

// ---------------------------------------------------------------------------
// Incomplete links / images
// ---------------------------------------------------------------------------

function stripIncompleteLinks(text: string): string {
  // Strip trailing incomplete image or link: ![...](... or [...](... or ![... or [...
  return text
    .replace(/!?\[[^\]]*\]\([^)]*$/, "")
    .replace(/!?\[[^\]]*$/, "");
}

// ---------------------------------------------------------------------------
// Inline code
// ---------------------------------------------------------------------------

function closeInlineCode(text: string): string {
  // Walk through the text tracking backtick spans
  let i = 0;
  let openBackticks: string | null = null;
  let openPos = -1;

  while (i < text.length) {
    if (text[i] === "`") {
      const start = i;
      while (i < text.length && text[i] === "`") i++;
      const run = text.slice(start, i);

      if (!openBackticks) {
        openBackticks = run;
        openPos = start;
      } else if (run.length === openBackticks.length) {
        // Matched — closed
        openBackticks = null;
        openPos = -1;
      }
      // Different length backtick run inside open span — just content
    } else {
      i++;
    }
  }

  if (openBackticks) {
    return text + openBackticks;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Bold / italic
// ---------------------------------------------------------------------------

function closeBoldItalic(text: string): string {
  // Skip content inside inline code spans
  const stripped = stripInlineCode(text);

  const markers: string[] = [];

  // Track ** and * (and __ / _) openers/closers
  let i = 0;
  while (i < stripped.length) {
    // Check for ** or __
    if (
      (stripped[i] === "*" && stripped[i + 1] === "*") ||
      (stripped[i] === "_" && stripped[i + 1] === "_")
    ) {
      const marker = stripped.slice(i, i + 2);
      const lastIdx = markers.lastIndexOf(marker);
      if (lastIdx >= 0) {
        markers.splice(lastIdx, 1);
      } else {
        markers.push(marker);
      }
      i += 2;
    } else if (stripped[i] === "*" || stripped[i] === "_") {
      const marker = stripped[i];
      const lastIdx = markers.lastIndexOf(marker);
      if (lastIdx >= 0) {
        markers.splice(lastIdx, 1);
      } else {
        markers.push(marker);
      }
      i++;
    } else {
      i++;
    }
  }

  // Close in reverse order (innermost first)
  let suffix = "";
  for (let j = markers.length - 1; j >= 0; j--) {
    suffix += markers[j];
  }

  return text + suffix;
}

/** Replace inline code spans with placeholder text of the same length */
function stripInlineCode(text: string): string {
  // Replace ``...`` and `...` with spaces
  return text
    .replace(/``[^`]*``/g, (m) => " ".repeat(m.length))
    .replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
}

// ---------------------------------------------------------------------------
// Strikethrough
// ---------------------------------------------------------------------------

function closeStrikethrough(text: string): string {
  const stripped = stripInlineCode(text);
  let count = 0;
  let i = 0;

  while (i < stripped.length) {
    if (stripped[i] === "~" && stripped[i + 1] === "~") {
      count++;
      i += 2;
    } else {
      i++;
    }
  }

  if (count % 2 !== 0) {
    return text + "~~";
  }
  return text;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function repairTableRow(text: string): string {
  const lastNewline = text.lastIndexOf("\n");
  const lastLine = text.slice(lastNewline + 1);

  // Only act if we're inside a table (line contains | but doesn't end with |)
  if (
    lastLine.includes("|") &&
    !lastLine.trimEnd().endsWith("|")
  ) {
    return text + " |";
  }
  return text;
}
