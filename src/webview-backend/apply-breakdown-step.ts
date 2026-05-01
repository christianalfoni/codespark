import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { BreakdownStepInput, IpcServer } from "../ipc-server";
import { InstructionFileDecorationProvider } from "../instructionDecorations";
import {
  PreparedInlineEdit,
  prepareInlineEdit,
  executeInlineEdit,
} from "../claude-code-inline";
import { startFileScan } from "../editor-effects";
import { Usage } from "../types";

export class ApplyBreakdownStep {
  constructor(
    private _log: vscode.OutputChannel,
    private _mcpConfigPath: string | undefined,
    private _ipcServer: IpcServer,
    private _decorationProvider: InstructionFileDecorationProvider,
    private _post: (msg: unknown) => void,
    private _reportUsage: (u: Usage) => void,
  ) {}
  async apply(
    workspaceFolder: string,
    step: BreakdownStepInput,
    index: number,
  ): Promise<void> {
    if (!this._mcpConfigPath) return;

    this._post({ type: "step-status", index, status: "applying" });

    // Open the file in the editor so the user can see the edits.
    // If the file is already the active editor, don't jump — the user may have scrolled.
    const absolute = path.resolve(workspaceFolder, step.filePath);
    const alreadyActive =
      vscode.window.activeTextEditor?.document.uri.fsPath === absolute;
    if (!alreadyActive) {
      try {
        await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
        if (!fs.existsSync(absolute)) {
          await fs.promises.writeFile(absolute, "", "utf-8");
        }
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(absolute),
        );
        const options: vscode.TextDocumentShowOptions = {};
        if (step.lineHint && step.lineHint > 0) {
          const pos = new vscode.Position(step.lineHint - 1, 0);
          options.selection = new vscode.Range(pos, pos);
        }
        await vscode.window.showTextDocument(doc, options);
      } catch {
        // Non-fatal — edits can still apply
      }
    }

    // Start scanning immediately — prepare runs concurrently
    const activeEditor = vscode.window.activeTextEditor;
    const isEmpty = activeEditor
      ? activeEditor.document.getText().trim().length === 0
      : true;
    let pulse: { dispose: () => void } | null =
      activeEditor && !isEmpty ? startFileScan(activeEditor) : null;

    const prepared = await this._prepareFreshEdit(step);

    try {
      const result = await executeInlineEdit(
        prepared,
        step.description,
        this._log,
        this._ipcServer,
      );

      pulse?.dispose();
      pulse = null;

      this._reportUsage({
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        contextOutputTokens: result.contextOutputTokens,
        cacheReadInputTokens: result.cacheReadInputTokens,
        cacheCreationInputTokens: result.cacheCreationInputTokens,
      });

      if (result.hasEdits) {
        this._post({ type: "step-status", index, status: "done" });

        const currentEditor = vscode.window.activeTextEditor;

        if (currentEditor) {
          dimNonEditedLines(currentEditor, result.editedLines);
        }
      } else {
        this._post({
          type: "step-status",
          index,
          status: "error",
          text: result.textResponse ?? "No edits applied",
        });
      }
    } catch (err: unknown) {
      pulse?.dispose();
      const msg = err instanceof Error ? err.message : String(err);
      this._log.appendLine(`[assistant-view] Apply step error: ${msg}`);
      this._post({ type: "step-status", index, status: "error", text: msg });
    }
  }

  private async _prepareFreshEdit(
    step: BreakdownStepInput,
  ): Promise<PreparedInlineEdit> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath!;
    const absolute = path.resolve(workspaceFolder, step.filePath);
    const fileContent = await fs.promises.readFile(absolute, "utf-8");
    return this._prepareEdit(step.filePath, fileContent);
  }

  private async _prepareEdit(
    filePath: string,
    fileContent: string,
  ): Promise<PreparedInlineEdit> {
    // Gather instruction content from CLAUDE.md files
    const editor = vscode.window.activeTextEditor;
    let instructionContent: string | undefined;
    if (editor) {
      const instructions = this._decorationProvider.activate(
        editor.document.uri,
      );
      const parts: string[] = [];
      if (instructions.root) parts.push(instructions.root.content);
      for (const loc of instructions.local) parts.push(loc.content);
      instructionContent =
        parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;
      this._decorationProvider.deactivate();
    }

    // Gather reference files
    const referenceFiles: { path: string; content: string }[] = [];
    if (editor) {
      const instructions = this._decorationProvider.activate(
        editor.document.uri,
      );
      for (const absPath of instructions.referencedFiles) {
        try {
          const content = await fs.promises.readFile(absPath, "utf-8");
          const relPath = vscode.workspace.asRelativePath(absPath);
          referenceFiles.push({ path: relPath, content });
        } catch {
          // skip unreadable reference files
        }
      }
      this._decorationProvider.deactivate();
    }

    return prepareInlineEdit(
      { fileContent, filePath, instructionContent, referenceFiles },
      this._log,
      this._mcpConfigPath!,
    );
  }
}

function dimNonEditedLines(
  editor: vscode.TextEditor,
  editedLines: { startLine: number; endLine: number }[],
) {
  // Dim non-edited lines to highlight what changed

  if (editedLines.length > 0) {
    const editedLineSet = new Set<number>();
    for (const range of editedLines) {
      for (let l = range.startLine; l <= range.endLine; l++) {
        editedLineSet.add(l);
      }
    }

    const dimType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      opacity: "0.3",
    });

    const dimRanges: vscode.Range[] = [];
    for (let l = 0; l < editor.document.lineCount; l++) {
      if (!editedLineSet.has(l)) {
        dimRanges.push(new vscode.Range(l, 0, l, 0));
      }
    }
    editor.setDecorations(dimType, dimRanges);

    function cleanup() {
      dimType.dispose();
      saveListener.dispose();
      changeListener.dispose();
    }

    const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.fsPath === editor.document.uri.fsPath) {
        cleanup();
      }
    });

    const changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
      if (
        e.document.uri.fsPath === editor.document.uri.fsPath &&
        e.reason === vscode.TextDocumentChangeReason.Undo
      ) {
        cleanup();
      }
    });
  }
}
