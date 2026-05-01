export interface InlineEditResult {
  hasEdits: boolean;
  editedLines: Array<{ startLine: number; endLine: number }>;
  textResponse?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextOutputTokens: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextOutputTokens: number;
}

export interface PendingFileContext {
  filePath: string;
  cursorLine: number;
  selection?: string;
}
