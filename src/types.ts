export interface StrReplaceEdit {
  old_str: string;
  new_str: string;
  insert_line?: number;
}

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
  edits: StrReplaceEdit[];
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  provider: string;
  model: string;
}
