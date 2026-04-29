/**
 * Repairs incomplete markdown so it renders cleanly during streaming.
 * Applied at render time only — the raw buffer stays untouched.
 */
export function prepareForRender(buffer: string): string {
  if (!buffer) return buffer;

  // 0. Normalize literal \n escape sequences the LLM sometimes emits as text
  let result = buffer.replace(/\\n/g, "\n");

  // 1. Close any unclosed fence (streaming)
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

interface FenceInfo {
  lineIndex: number;
  char: string;
  count: number;
  hasInfo: boolean;
  info: string;
}

const FENCE_LINE_RE = /^(`{3,}|~{3,})(.*)/;

function parseFenceLines(lines: string[]): FenceInfo[] {
  const fences: FenceInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FENCE_LINE_RE);
    if (!m) continue;
    fences.push({
      lineIndex: i,
      char: m[1][0],
      count: m[1].length,
      hasInfo: m[2].trim().length > 0,
      info: m[2].trim().split(/\s/)[0],
    });
  }
  return fences;
}

/**
 * Check if there's another bare fence of the same char/count after `afterIdx`
 * but before the next fence with an info string (or end of list).
 */
function hasMoreBareFences(
  fences: FenceInfo[],
  afterIdx: number,
  char: string,
  minCount: number,
): boolean {
  for (let i = afterIdx; i < fences.length; i++) {
    if (fences[i].hasInfo) return false;
    if (fences[i].char === char && fences[i].count >= minCount) return true;
  }
  return false;
}

/**
 * Determines whether a bare fence should close the top of stack or be treated
 * as an inner opener. The rule: when the outermost block was opened with a
 * language (e.g. ```markdown) and there are more bare fences ahead before the
 * next info-fence, bare fences pair up as inner blocks — only the last
 * unpaired bare fence closes the outer block.
 */
const MARKDOWN_LANGS = new Set(["markdown", "md"]);

function shouldTreatAsInnerOpener(
  stack: Array<{ char: string; count: number; hasInfo: boolean; info?: string }>,
  fences: FenceInfo[],
  fenceIdx: number,
  f: FenceInfo,
): boolean {
  if (stack.length !== 1) return false;
  const top = stack[0];
  if (!top.hasInfo) return false;
  if (f.char !== top.char || f.count < top.count) return false;
  // Only treat bare fences as inner openers when the outer block is a
  // markdown container language — other languages (python, bash, etc.)
  // don't legitimately contain nested code fences.
  if (!top.info || !MARKDOWN_LANGS.has(top.info.toLowerCase())) return false;
  return hasMoreBareFences(fences, fenceIdx + 1, f.char, top.count);
}

/**
 * Nesting-aware fence state detector.
 *
 * Uses a stack to track nesting. Fences with info strings are always openers.
 * Bare fences close the innermost block, UNLESS the outermost block has a
 * language and there are more bare fences ahead — in that case they pair up
 * as inner blocks.
 */
function getFenceState(
  buffer: string,
): { closer: string } | null {
  const lines = buffer.split("\n");
  const fences = parseFenceLines(lines);
  const stack: Array<{ char: string; count: number; hasInfo: boolean; info?: string }> = [];

  for (let fi = 0; fi < fences.length; fi++) {
    const f = fences[fi];

    if (stack.length === 0 || f.hasInfo) {
      stack.push({ char: f.char, count: f.count, hasInfo: f.hasInfo, info: f.info });
    } else {
      const top = stack[stack.length - 1];
      if (top.char === f.char && f.count >= top.count) {
        if (shouldTreatAsInnerOpener(stack, fences, fi, f)) {
          stack.push({ char: f.char, count: f.count, hasInfo: false });
        } else {
          stack.pop();
        }
      }
    }
  }

  if (stack.length === 0) return null;
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
 * Handles both language-specified inner fences (```bash inside ```markdown)
 * and bare inner fences (``` inside ```markdown). For bare inner fences,
 * they pair up — the last unpaired bare fence closes the outer block.
 */
function upgradeNestedFences(text: string): string {
  const lines = text.split("\n");
  const fences = parseFenceLines(lines);

  interface StackEntry {
    lineIndex: number;
    char: string;
    count: number;
    hasInfo: boolean;
    info?: string;
    innerMaxCount: number;
  }

  const stack: StackEntry[] = [];
  const upgrades = new Map<number, number>();

  for (let fi = 0; fi < fences.length; fi++) {
    const f = fences[fi];

    if (stack.length === 0 || f.hasInfo) {
      stack.push({
        lineIndex: f.lineIndex,
        char: f.char,
        count: f.count,
        hasInfo: f.hasInfo,
        info: f.info,
        innerMaxCount: 0,
      });
    } else {
      const top = stack[stack.length - 1];
      if (top.char === f.char && f.count >= top.count) {
        if (shouldTreatAsInnerOpener(stack, fences, fi, f)) {
          stack.push({
            lineIndex: f.lineIndex,
            char: f.char,
            count: f.count,
            hasInfo: false,
            innerMaxCount: 0,
          });
        } else {
          stack.pop();

          if (top.innerMaxCount >= top.count) {
            const newCount = top.innerMaxCount + 1;
            upgrades.set(top.lineIndex, newCount);
            upgrades.set(f.lineIndex, newCount);
          }

          if (stack.length > 0) {
            const parent = stack[stack.length - 1];
            const effective = upgrades.get(top.lineIndex) || top.count;
            parent.innerMaxCount = Math.max(parent.innerMaxCount, effective);
          }
        }
      }
    }
  }

  if (upgrades.size === 0) return text;

  for (const [lineIndex, newCount] of upgrades) {
    const m = lines[lineIndex].match(FENCE_LINE_RE)!;
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
