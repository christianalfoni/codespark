import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { InstructionFileDecorationProvider } from "./instructionDecorations";
import {
  callLLMWithSDK,
  resolveModel,
  buildContextMessages,
  ResolvedModel,
} from "./llm-sdk";
import { ResolvedContext } from "./types";
import { promptForInstruction } from "./promptInput";
import { recordQuery } from "./stats";
import { evaluateFocusArea } from "./editor";

export function createInvokeCommand(
  log: vscode.OutputChannel,
  decorationProvider: InstructionFileDecorationProvider,
  statusBarItem: vscode.StatusBarItem,
  updateActiveInstructions: () => void,
) {
  return async () => {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      return;
    }

    const instructions = decorationProvider.activate(editor.document.uri);
    const fileContent = editor.document.getText();
    const selection = editor.selection.isEmpty
      ? undefined
      : editor.document.getText(editor.selection);
    const cursorLineNum = editor.selection.active.line;
    const cursorLine = editor.document.lineAt(cursorLineNum);
    const cursorOnEmptyLine = cursorLine.isEmptyOrWhitespace;

    const focusArea = await evaluateFocusArea(editor);
    const contextSnippet =
      focusArea.focusStartLine === 0 &&
      focusArea.focusEndLine === editor.document.lineCount - 1
        ? "The whole file"
        : focusArea.lines.join("\n");

    const gutterDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: path.join(
        __dirname,
        "..",
        "media",
        "gutter-changed.svg",
      ),
      gutterIconSize: "contain",
    });
    const pendingRange = new vscode.Range(
      new vscode.Position(0, 0),
      editor.document.lineAt(editor.document.lineCount - 1).range.end,
    );
    editor.setDecorations(gutterDecoration, [pendingRange]);

    const filePath = vscode.workspace.asRelativePath(editor.document.uri);
    const basename = path.basename(editor.document.uri.fsPath);
    const isInstructionFile =
      basename === "CLAUDE.md" || basename === "AGENT.md";

    let instructionContent: string | undefined;
    if (!isInstructionFile) {
      const instructionParts: string[] = [];
      if (instructions.root) {
        instructionParts.push(instructions.root.content);
      }
      for (const loc of instructions.local) {
        instructionParts.push(loc.content);
      }
      instructionContent =
        instructionParts.length > 0
          ? instructionParts.join("\n\n---\n\n")
          : undefined;
    }

    const savePromise = editor.document.save();
    const modelPromise = resolveModel(log).catch((err) => err as Error);
    const refFilesPromise = isInstructionFile
      ? Promise.resolve([] as { path: string; content: string }[])
      : Promise.all(
          instructions.referencedFiles.map(async (absPath) => {
            try {
              const content = await fs.promises.readFile(absPath, "utf-8");
              const relPath = vscode.workspace.asRelativePath(absPath);
              return { path: relPath, content };
            } catch {
              return null;
            }
          }),
        ).then((results) =>
          results.filter(
            (r): r is { path: string; content: string } => r !== null,
          ),
        );

    const promptResult = await promptForInstruction();

    if (!promptResult) {
      gutterDecoration.dispose();
      decorationProvider.deactivate();
      return;
    }

    const instruction = promptResult.instruction;

    log.appendLine(
      `[context] Cursor at line ${cursorLineNum + 1}, focus lines ${focusArea.focusStartLine + 1}-${focusArea.focusEndLine + 1}`,
    );
    if (instructions.root) {
      log.appendLine(
        `[context] Root CLAUDE.md: ${vscode.workspace.asRelativePath(instructions.root.uri)}`,
      );
    }
    for (const loc of instructions.local) {
      log.appendLine(
        `[context] Local CLAUDE.md: ${vscode.workspace.asRelativePath(loc.uri)}`,
      );
    }

    const pendingDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      opacity: "0.4",
    });
    editor.setDecorations(pendingDecoration, [pendingRange]);

    statusBarItem.text = "$(loading~spin) CodeSpark · thinking...";

    const [, modelResult, referenceFiles] = await Promise.all([
      savePromise,
      modelPromise,
      refFilesPromise,
    ]);

    const ctx: ResolvedContext = {
      fileContent,
      filePath,
      selection,
      cursorLine: cursorLineNum + 1,
      cursorOnEmptyLine,
      contextSnippet,
      instruction,
      instructionContent,
      referenceFiles: [],
      isInstructionFile,
    };

    const agentDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      opacity: "0.4",
      gutterIconPath: path.join(__dirname, "..", "media", "gutter-agent.svg"),
      gutterIconSize: "contain",
    });

    try {
      if (modelResult instanceof Error) {
        throw modelResult;
      }

      const resolved = modelResult as ResolvedModel;

      const contextMessages = buildContextMessages(
        fileContent,
        filePath,
        referenceFiles,
        resolved.piModel,
      );

      ctx.referenceFiles = referenceFiles;

      const result = await callLLMWithSDK(
        ctx,
        log,
        resolved,
        contextMessages,
        () => {
          pendingDecoration.dispose();
          gutterDecoration.dispose();
          editor.setDecorations(agentDecoration, [pendingRange]);
          statusBarItem.text = "$(loading~spin) CodeSpark · agent working...";
        },
      );
      agentDecoration.dispose();
      pendingDecoration.dispose();
      gutterDecoration.dispose();

      const hasEdits = editor.document.getText() !== ctx.fileContent;

      recordQuery({
        provider: result.provider,
        model: result.model,
        latencyMs: result.latencyMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        editCount: hasEdits ? 1 : 0,
        success: true,
        timestamp: Date.now(),
      });

      if (!hasEdits) {
        decorationProvider.deactivate();
        vscode.window.showInformationMessage(
          "CodeSpark: No edits suggested.",
        );
        updateActiveInstructions();
        return;
      }

      decorationProvider.deactivate();
      statusBarItem.text = `$(sparkle) CodeSpark · edited`;
    } catch (err: unknown) {
      agentDecoration.dispose();
      pendingDecoration.dispose();
      gutterDecoration.dispose();
      decorationProvider.deactivate();
      recordQuery({
        provider: "",
        model: "",
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        editCount: 0,
        success: false,
        timestamp: Date.now(),
      });
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`CodeSpark: ${msg}`);
      updateActiveInstructions();
    }
  };
}
