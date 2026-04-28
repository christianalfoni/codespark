#!/usr/bin/env npx tsx
/**
 * Token validation script for CodeSpark / Claude Code CLI sessions.
 *
 * Usage:
 *   npx tsx scripts/validate-tokens.ts <session-id>
 *   npx tsx scripts/validate-tokens.ts <path-to-file.jsonl>
 *
 * The session-id is logged by the extension output channel after each query:
 *   [claude-code-assistant] Query complete (N turns, $X.XXXX)
 *
 * Output totals should match exactly what CodeSpark's StatsBar displays,
 * because both use the same parsing logic from src/session-tokens.ts.
 */

import * as fs from "fs";
import * as path from "path";
import { findSessionFile, parseSessionFile, type TokenCall } from "../src/session-tokens";

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function printReport(arg: string): void {
  const filePath = fs.existsSync(arg) ? arg : findSessionFile(path.basename(arg, ".jsonl"));
  const { calls, assistantDisplay, filePath: resolvedPath } = parseSessionFile(filePath);

  console.log(`\nSession file : ${resolvedPath}`);
  console.log(`Unique API calls: ${calls.length}\n`);

  const COL = { n: 3, input: 8, cr: 10, cc: 9, out: 8, total: 10 };
  const header =
    `${"#".padStart(COL.n)}  ${"input".padStart(COL.input)}  ${"cache_read".padStart(COL.cr)}` +
    `  ${"cache_cre".padStart(COL.cc)}  ${"output".padStart(COL.out)}  ${"total_in".padStart(COL.total)}`;
  const sep = "-".repeat(header.length);

  console.log(header);
  console.log(sep);

  calls.forEach((c: TokenCall, i: number) => {
    console.log(
      `${String(i + 1).padStart(COL.n)}  ${fmt(c.inputTokens).padStart(COL.input)}` +
        `  ${fmt(c.cacheReadInputTokens).padStart(COL.cr)}` +
        `  ${fmt(c.cacheCreationInputTokens).padStart(COL.cc)}` +
        `  ${fmt(c.outputTokens).padStart(COL.out)}` +
        `  ${fmt(c.totalIn).padStart(COL.total)}`,
    );
  });

  console.log(sep);

  const last = calls[calls.length - 1];
  console.log(`
What CodeSpark should display
  "${fmt(assistantDisplay.totalIn)} tokens"
  Tooltip → Context: ${fmt(assistantDisplay.totalIn)}
              uncached:     ${fmt(last?.inputTokens ?? 0)}
              cache read:   ${fmt(last?.cacheReadInputTokens ?? 0)}
              cache create: ${fmt(last?.cacheCreationInputTokens ?? 0)}
            Output: ${fmt(assistantDisplay.outputTokens)}
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const arg = process.argv[2];
if (!arg) {
  console.error(
    "Usage: npx tsx scripts/validate-tokens.ts <session-id | path-to-file.jsonl>",
  );
  process.exit(1);
}

try {
  printReport(arg);
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
