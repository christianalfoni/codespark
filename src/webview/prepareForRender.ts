/**
 * Repairs incomplete markdown so it renders cleanly during streaming.
 * Applied at render time only — the raw buffer stays untouched.
 */
export function prepareForRender(buffer: string): string {
  if (!buffer) return buffer;

  // 1. Close any unclosed fence (streaming)
  let result = buffer;
  const fenceState = getFenceState(result);

  if (fenceState) {
    result = result + "\n" + fenceState.closer;
  }

  // 2. Upgrade nested fences that use the same backtick count
  result = upgradeNestedFences(result);

  // 3. If we were inside an open code block, skip inline repairs
  if (fenceState) {
    return result;
  }

  // 4. Strip incomplete links/images at the end
  result = stripIncompleteLinks(result);

  // 5. Auto-close inline constructs
  result = closeInlineCode(result);
  result = closeBoldItalic(result);
  result = closeStrikethrough(result);

  // 6. Repair incomplete table rows
  result = repairTableRow(result);

  return result;
}

// ---------------------------------------------------------------------------
// Fenced code blocks
// ---------------------------------------------------------------------------

const FENCE_LINE_RE = /^(`{3,}|~{3,})(.*)/gm;

/**
 * Nesting-aware fence state detector.
 *
 * Per CommonMark, a fence line with an info string (e.g. ```bash) is always
 * an opener — never a closer. A bare fence (``` with nothing after) closes
 * the innermost matching block. We use a stack to track nesting depth so
 * that inner fences don't prematurely close an outer block.
 */
function getFenceState(
  buffer: string,
): { closer: string } | null {
  const stack: Array<{ char: string; count: number }> = [];

  for (const match of buffer.matchAll(FENCE_LINE_RE)) {
    const fenceChars = match[1];
    const rest = match[2].trim();
    const char = fenceChars[0];
    const count = fenceChars.length;
    const hasInfo = rest.length > 0;

    if (stack.length === 0 || hasInfo) {
      // Any fence opens when the stack is empty;
      // a fence with an info string is always an opener (even when nested)
      stack.push({ char, count });
    } else {
      // Bare fence — close the innermost matching block
      const top = stack[stack.length - 1];
      if (top.char === char && count >= top.count) {
        stack.pop();
      }
    }
  }

  if (stack.length === 0) return null;
  // Close all open fences from innermost to outermost
  const closers = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    closers.push(stack[i].char.repeat(stack[i].count));
  }
  return { closer: closers.join("\n") };
}

/**
 * Detects nested fenced code blocks that share the same backtick/tilde count
 * and upgrades the outer fences so the inner ones render as content.
 *
 * Example: an AI response containing a markdown file with inner code blocks
 * all using ``` will be rewritten so the outermost pair uses ```` (or more).
 */
function upgradeNestedFences(text: string): string {
  const lines = text.split("\n");
  const FENCE_RE = /^(`{3,}|~{3,})(.*)/;

  interface StackEntry {
    lineIndex: number;
    char: string;
    count: number;
    innerMaxCount: number;
  }

  const stack: StackEntry[] = [];
  const upgrades = new Map<number, number>();

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FENCE_RE);
    if (!m) continue;

    const char = m[1][0];
    const count = m[1].length;
    const hasInfo = m[2].trim().length > 0;

    if (stack.length === 0 || hasInfo) {
      stack.push({ lineIndex: i, char, count, innerMaxCount: 0 });
    } else {
      // Bare fence — close innermost matching
      const top = stack[stack.length - 1];
      if (top.char === char && count >= top.count) {
        stack.pop();

        if (top.innerMaxCount >= top.count) {
          const newCount = top.innerMaxCount + 1;
          upgrades.set(top.lineIndex, newCount);
          upgrades.set(i, newCount);
        }

        // Propagate effective count to parent
        if (stack.length > 0) {
          const parent = stack[stack.length - 1];
          const effective = upgrades.get(top.lineIndex) || top.count;
          parent.innerMaxCount = Math.max(parent.innerMaxCount, effective);
        }
      }
    }
  }

  if (upgrades.size === 0) return text;

  for (const [lineIndex, newCount] of upgrades) {
    const m = lines[lineIndex].match(FENCE_RE)!;
    const oldLen = m[1].length;
    lines[lineIndex] = m[1][0].repeat(newCount) + lines[lineIndex].slice(oldLen);
  }

  return lines.join("\n");
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
