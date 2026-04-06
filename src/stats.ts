import * as vscode from "vscode";

export interface QueryRecord {
  provider: string;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  editCount: number;
  success: boolean;
  timestamp: number;
}

export interface Stats {
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalLatencyMs: number;
  totalEdits: number;
}

const STATS_KEY = "codeSpark.stats";

let workspaceState: vscode.Memento;

export function initStats(state: vscode.Memento) {
  workspaceState = state;
}

function getStats(): Stats {
  return workspaceState.get<Stats>(STATS_KEY, {
    totalQueries: 0,
    successfulQueries: 0,
    failedQueries: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalLatencyMs: 0,
    totalEdits: 0,
  });
}

export function recordQuery(record: QueryRecord) {
  const stats = getStats();

  stats.totalQueries++;
  if (record.success) {
    stats.successfulQueries++;
  } else {
    stats.failedQueries++;
  }
  stats.totalInputTokens += record.inputTokens;
  stats.totalOutputTokens += record.outputTokens;
  stats.totalLatencyMs += record.latencyMs;
  stats.totalEdits += record.editCount;

  workspaceState.update(STATS_KEY, stats);
}

export function resetStats() {
  workspaceState.update(STATS_KEY, undefined);
}

// Rough cost estimates per 1M tokens (USD)
const COST_TABLE: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 0.80, output: 4.00 },
  "claude-sonnet-4-5-20250514": { input: 3.00, output: 15.00 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): string {
  const rates = COST_TABLE[model];
  if (!rates) {
    return "N/A";
  }
  const cost = (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
  return `$${cost.toFixed(4)}`;
}

export function showStats() {
  const stats = getStats();

  if (stats.totalQueries === 0) {
    vscode.window.showInformationMessage("CodeSpark: No queries recorded yet.");
    return;
  }

  const avgLatency = Math.round(stats.totalLatencyMs / stats.totalQueries);
  const avgEdits = (stats.totalEdits / stats.successfulQueries).toFixed(1);

  const lines = [
    `Queries: ${stats.totalQueries} (${stats.successfulQueries} ok, ${stats.failedQueries} failed)`,
    `Total edits applied: ${stats.totalEdits} (avg ${avgEdits}/query)`,
    `Avg latency: ${avgLatency}ms`,
    `Tokens: ${stats.totalInputTokens.toLocaleString()} in / ${stats.totalOutputTokens.toLocaleString()} out`,
  ];

  vscode.window.showInformationMessage(`CodeSpark Stats — ${lines.join(" · ")}`);
}
