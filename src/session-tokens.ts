import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenTotals {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
}

export interface TokenCall extends TokenTotals {
  totalIn: number;
}

export interface SessionTokenResult {
  filePath: string;
  calls: TokenCall[];
  /** Accumulated sum across all calls — useful for cost estimation */
  totals: TokenCall;
  /**
   * What CodeSpark's assistant stats bar shows: last call's total_in (the
   * current context window via --resume) plus accumulated output tokens.
   */
  assistantDisplay: { totalIn: number; outputTokens: number };
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

export function findSessionFile(sessionId: string): string {
  for (const project of fs.readdirSync(PROJECTS_DIR)) {
    const candidate = path.join(PROJECTS_DIR, project, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `No session file found for '${sessionId}'.\nSearched in ${PROJECTS_DIR}/*/${sessionId}.jsonl`,
  );
}

export function parseSessionFile(filePath: string): SessionTokenResult {
  const lines = fs.readFileSync(filePath, "utf8").split("\n");

  // Build uuid → type map for deduplication
  const uuidToType = new Map<string, string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.uuid) uuidToType.set(obj.uuid, obj.type ?? "");
    } catch {
      // ignore parse errors
    }
  }

  // Each API call is written ~3× by the CLI as a parent-chain of identical
  // entries. Keep only the root of each cluster (entry whose parentUuid is
  // NOT another assistant entry) — those represent unique API calls.
  const calls: TokenCall[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type !== "assistant") continue;
      const parentType = uuidToType.get(obj.parentUuid ?? "") ?? "unknown";
      if (parentType === "assistant") continue;
      const u = obj.message?.usage;
      if (!u) continue;
      const inputTokens = u.input_tokens ?? 0;
      const cacheReadInputTokens = u.cache_read_input_tokens ?? 0;
      const cacheCreationInputTokens = u.cache_creation_input_tokens ?? 0;
      const outputTokens = u.output_tokens ?? 0;
      calls.push({
        inputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        outputTokens,
        totalIn: inputTokens + cacheReadInputTokens + cacheCreationInputTokens,
      });
    } catch {
      // ignore parse errors
    }
  }

  const inputTokens = calls.reduce((s, c) => s + c.inputTokens, 0);
  const cacheReadInputTokens = calls.reduce((s, c) => s + c.cacheReadInputTokens, 0);
  const cacheCreationInputTokens = calls.reduce((s, c) => s + c.cacheCreationInputTokens, 0);
  const outputTokens = calls.reduce((s, c) => s + c.outputTokens, 0);

  const lastCall = calls[calls.length - 1];

  return {
    filePath,
    calls,
    totals: {
      inputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      outputTokens,
      totalIn: inputTokens + cacheReadInputTokens + cacheCreationInputTokens,
    },
    assistantDisplay: {
      totalIn: lastCall?.totalIn ?? 0,
      outputTokens,
    },
  };
}
