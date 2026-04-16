import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Exported Types
// ---------------------------------------------------------------------------

export interface Disposable {
  dispose: () => void;
}

// ---------------------------------------------------------------------------
// Exported Functions
// ---------------------------------------------------------------------------

/**
 * Placeholder for empty files: shows a "Generating..." decoration on line 1
 * with a blinking cursor-style animation via opacity toggling.
 */
export function startEmptyFilePlaceholder(
  editor: vscode.TextEditor,
): Disposable {
  const placeholderType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    after: {
      contentText: "  Generating...",
      color: "var(--vscode-editorGhostText-foreground, rgba(255,255,255,0.4))",
      fontStyle: "italic",
    },
  });

  editor.setDecorations(placeholderType, [new vscode.Range(0, 0, 0, 0)]);

  return {
    dispose() {
      placeholderType.dispose();
    },
  };
}

/**
 * Scanning effect: a bright band sweeps down through visible lines only.
 * Lines near the scan position are more opaque, the rest stay dim.
 */
export function startFileScan(editor: vscode.TextEditor): Disposable {
  // Pre-create opacity levels — fewer types = better performance.
  // Level 0 = dimmest (base), last = brightest (scan center).
  const BASE_OPACITY = 0.3;
  const PEAK_OPACITY = 0.85;
  const LEVELS = 6;
  const opacityTypes: vscode.TextEditorDecorationType[] = [];
  for (let i = 0; i < LEVELS; i++) {
    const t = i / (LEVELS - 1); // 0 → 1
    const opacity = BASE_OPACITY + t * (PEAK_OPACITY - BASE_OPACITY);
    opacityTypes.push(
      vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        opacity: `${opacity}`,
      }),
    );
  }

  // The scan band radius — how many lines from center get the gradient
  const BAND_RADIUS = 4;
  const SCAN_SPEED = 2; // lines per tick
  const TICK_MS = 60;

  function getVisibleRange(): { start: number; end: number } {
    const ranges = editor.visibleRanges;
    if (ranges.length === 0) {
      return { start: 0, end: editor.document.lineCount };
    }
    return {
      start: ranges[0].start.line,
      end: ranges[ranges.length - 1].end.line,
    };
  }

  let { start: visStart, end: visEnd } = getVisibleRange();
  let scanPos = visStart;

  function applyFrame() {
    // Re-read visible range each frame so scrolling is handled
    ({ start: visStart, end: visEnd } = getVisibleRange());

    const buckets: vscode.Range[][] = Array.from({ length: LEVELS }, () => []);

    for (let line = visStart; line <= visEnd; line++) {
      const dist = Math.abs(line - scanPos);
      let level: number;
      if (dist >= BAND_RADIUS) {
        level = 0; // base dim
      } else {
        // Cosine falloff: 1 at center → 0 at edge
        const t = Math.cos((dist / BAND_RADIUS) * (Math.PI / 2));
        level = Math.round(t * (LEVELS - 1));
      }
      const range = new vscode.Range(line, 0, line, 0);
      buckets[level].push(range);
    }

    for (let i = 0; i < LEVELS; i++) {
      editor.setDecorations(opacityTypes[i], buckets[i]);
    }
  }

  applyFrame();

  const interval = setInterval(() => {
    scanPos += SCAN_SPEED;
    // Wrap around within visible area
    if (scanPos > visEnd + BAND_RADIUS) {
      scanPos = visStart - BAND_RADIUS;
    }
    applyFrame();
  }, TICK_MS);

  return {
    dispose() {
      clearInterval(interval);
      for (const t of opacityTypes) {
        t.dispose();
      }
    },
  };
}

/**
 * Find the largest edited range (by line count) and scroll the editor to it.
 */
export function focusLargestChange(
  editor: vscode.TextEditor,
  editedRanges: Array<{ startLine: number; endLine: number }>,
): void {
  let largest = editedRanges[0];
  for (const range of editedRanges) {
    if (
      range.endLine - range.startLine >
      largest.endLine - largest.startLine
    ) {
      largest = range;
    }
  }

  if (largest) {
    vscode.commands.executeCommand("revealLine", {
      lineNumber: largest.startLine,
      at: "center",
    });

    editor.selection = new vscode.Selection(
      new vscode.Position(largest.startLine, 0),
      new vscode.Position(largest.startLine, 0),
    );
  }
}
