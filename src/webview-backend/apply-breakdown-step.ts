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
import { dimNonEditedLines, startFileScan } from "../editor-effects";
import { Usage } from "../types";
import { gatherInstructionContext } from "../instructionContext";

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

    if (!editor) {
      return prepareInlineEdit(
        {
          fileContent,
          filePath,
          instructionContent: undefined,
          referenceFiles: [],
        },
        this._log,
        this._mcpConfigPath!,
      );
    }

    const { instructionContent, referenceFiles } =
      await gatherInstructionContext(editor, this._decorationProvider);

    return prepareInlineEdit(
      { fileContent, filePath, instructionContent, referenceFiles },
      this._log,
      this._mcpConfigPath!,
    );
  }
}
