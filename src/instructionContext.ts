import * as vscode from "vscode";
import * as fs from "fs";
import { InstructionFileDecorationProvider } from "./instructionDecorations";

export async function gatherInstructionContext(
  editor: vscode.TextEditor,
  provider: InstructionFileDecorationProvider,
): Promise<{
  instructionContent: string | undefined;
  referenceFiles: { path: string; content: string }[];
}> {
  const instructions = provider.activate(editor.document.uri);

  try {
    const parts: string[] = [];
    if (instructions.root) parts.push(instructions.root.content);
    for (const loc of instructions.local) parts.push(loc.content);
    const instructionContent =
      parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;

    // Gather reference files
    const referenceFiles: { path: string; content: string }[] = [];

    for (const absPath of instructions.referencedFiles) {
      try {
        const content = await fs.promises.readFile(absPath, "utf-8");
        const relPath = vscode.workspace.asRelativePath(absPath);
        referenceFiles.push({ path: relPath, content });
      } catch {
        // skip unreadable reference files
      }
    }

    return {
      instructionContent,
      referenceFiles,
    };
  } finally {
    provider.deactivate();
  }
}
