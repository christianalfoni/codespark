export interface InlineEditResult {
  hasEdits: boolean;
  editedLines: Array<{ startLine: number; endLine: number }>;
  textResponse?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}
