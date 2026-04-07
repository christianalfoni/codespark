export interface ResolvedContext {
  fileContent: string;
  filePath: string;
  selection: string | undefined;
  cursorLine: number;
  cursorOnEmptyLine: boolean;
  contextSnippet: string;
  instruction: string;
  instructionContent: string | undefined;
  referenceFiles: { path: string; content: string }[];
  isInstructionFile: boolean;
}

export interface LLMResult {
  hasEdits: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  provider: string;
  model: string;
}
