import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Tracks files the inline agent has read in the current session. Used to
 * enforce "must Read before write_file" semantics — mirrors the native Write
 * tool's contract, which the model is trained on.
 *
 * Scoped to the inline agent only (research agent can't call write_file).
 * Only one inline session is active at a time, so a single module-level
 * Set is sufficient — cleared at the start of every inline invocation.
 */

export function clearReads(): void {
  _reads.clear();
}

export function markRead(filePath: string): void {
  const canonical = canonicalize(filePath);
  if (canonical) _reads.add(canonical);
}

export function hasRead(filePath: string): boolean {
  const canonical = canonicalize(filePath);
  if (!canonical) return false;
  return _reads.has(canonical);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

const _reads = new Set<string>();

function canonicalize(filePath: string): string | null {
  if (!filePath) return null;
  const abs = path.resolve(filePath);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
}
