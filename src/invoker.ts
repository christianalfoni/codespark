import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { InstructionFileDecorationProvider } from "./instructionDecorations";
import {
  prepareInlineAgent,
  executeInlineAgent,
  abortInlineAgent,
} from "./claude-code-inline";
import { ResolvedContext, LLMResult } from "./types";
import { createInlinePrompt } from "./promptInput";
import { recordQuery } from "./stats";
import { evaluateFocusArea } from "./editor";
import { IpcServer } from "./ipc-server";
import { startFileScan, startEmptyFilePlaceholder } from "./editor-effects";

/* ── Main command ─────────────────────────────────────────────── */

export function createInvokeCommand(
  log: vscode.OutputChannel,
  decorationProvider: InstructionFileDecorationProvider,
  statusBarItem: vscode.StatusBarItem,
  updateActiveInstructions: () => void,
  mcpConfigPath: string,
  ipcServer: IpcServer,
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
    const isWholeFile =
      focusArea.focusStartLine === 0 &&
      focusArea.focusEndLine === editor.document.lineCount - 1;

    // Dim everything outside the focus area while the prompt is open.
    // If cursor is on line 1 (whole file context), don't dim anything.
    let invokeDim: vscode.TextEditorDecorationType | undefined;
    if (!isWholeFile) {
      invokeDim = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        opacity: "0.5",
      });

      // Determine which lines stay bright
      let brightStart: number;
      let brightEnd: number;
      if (!editor.selection.isEmpty) {
        // Selection → keep the entire selection bright
        brightStart = editor.selection.start.line;
        brightEnd = editor.selection.end.line;
      } else if (
        focusArea.enclosingBlock &&
        cursorLineNum === focusArea.enclosingBlock.start
      ) {
        // On start line of a block → keep the whole block bright
        brightStart = focusArea.focusStartLine;
        brightEnd = focusArea.focusEndLine;
      } else {
        // Inside a block or no block → keep just the cursor line bright
        brightStart = cursorLineNum;
        brightEnd = cursorLineNum;
      }

      const dimRanges: vscode.Range[] = [];
      for (let l = 0; l < editor.document.lineCount; l++) {
        if (l < brightStart || l > brightEnd) {
          dimRanges.push(new vscode.Range(l, 0, l, 0));
        }
      }
      editor.setDecorations(invokeDim, dimRanges);
    }

    const filePath = vscode.workspace.asRelativePath(editor.document.uri);
    const basename = path.basename(editor.document.uri.fsPath);
    const isInstructionFile = basename === "CLAUDE.md";

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

    const referenceFiles = isInstructionFile
      ? []
      : (
          await Promise.all(
            instructions.referencedFiles.map(async (absPath) => {
              try {
                const content = await fs.promises.readFile(absPath, "utf-8");
                const relPath = vscode.workspace.asRelativePath(absPath);
                return { path: relPath, content };
              } catch {
                return null;
              }
            }),
          )
        ).filter((r): r is { path: string; content: string } => r !== null);

    // Pre-spawn the CLI while the user types (session has file content + prefill)
    const agentPromise = prepareInlineAgent(
      {
        fileContent,
        filePath,
        referenceFiles,
        instructionContent,
        isInstructionFile,
      },
      log,
      mcpConfigPath,
    );

    // Remember where the user was so we can restore on cancel.
    const originalSelection = new vscode.Selection(
      editor.selection.anchor,
      editor.selection.active,
    );
    const originalVisibleRange = editor.visibleRanges[0];
    const hadSelection = !editor.selection.isEmpty;
    const insertLine = editor.selection.start.line;
    // Only treat the line as "reusable" when there's no selection — if the
    // user selected something starting on an empty line, we still want the
    // prompt to appear above it, not on it.
    const currentLineEmpty =
      !hadSelection && editor.document.lineAt(insertLine).isEmptyOrWhitespace;

    // Insert a blank line to host the ghost-text prompt. Uses a proper undo
    // stop so we can cleanly reverse it with `undo` when the prompt closes.
    let insertedBlank = false;
    if (!currentLineEmpty) {
      try {
        insertedBlank = await editor.edit(
          (b) => b.insert(new vscode.Position(insertLine, 0), "\n"),
          { undoStopBefore: true, undoStopAfter: false },
        );
      } catch {
        insertedBlank = false;
      }
    }

    // Collapse the selection onto the prompt line so the only active visual
    // is the prompt decoration.
    if (currentLineEmpty || insertedBlank) {
      const pos = new vscode.Position(insertLine, 0);
      editor.selection = new vscode.Selection(pos, pos);
    }

    const promptLine =
      currentLineEmpty || insertedBlank
        ? insertLine
        : Math.max(0, cursorLineNum - 1);

    // Open the inline prompt — keystrokes are captured directly via the
    // `type` command override, no webview relay needed.
    const { prompt: inlinePrompt, instruction } = createInlinePrompt(
      editor,
      promptLine,
    );

    const instructionText = await instruction;

    if (!instructionText) {
      inlinePrompt.dispose();
      if (insertedBlank) {
        await vscode.commands.executeCommand("undo");
      }
      editor.selection = originalSelection;
      if (originalVisibleRange) {
        editor.revealRange(originalVisibleRange);
      }
      agentPromise.then((agent) => abortInlineAgent(agent)).catch(() => {});
      invokeDim?.dispose();
      decorationProvider.deactivate();
      return;
    }

    // Submitted — keep the prompt line alive and swap it into a dimmed status
    // indicator that reflects what the agent is currently doing.
    inlinePrompt.showStatus("Thinking...");

    log.appendLine(`[context] Cursor at line ${cursorLineNum + 1}`);
    log.appendLine(
      `[context] Focus area: lines ${focusArea.focusStartLine + 1}-${focusArea.focusEndLine + 1}`,
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

    // Start scanning immediately after prompt submission
    invokeDim?.dispose();
    const isEmpty = editor.document.getText().trim().length === 0;
    let pulse: { dispose: () => void } = isEmpty
      ? startEmptyFilePlaceholder(editor)
      : startFileScan(editor);

    statusBarItem.text = "$(loading~spin) CodeSpark · thinking...";

    const agent = await agentPromise;

    const contextSnippet =
      focusArea.focusStartLine === 0 &&
      focusArea.focusEndLine === editor.document.lineCount - 1
        ? "The whole file"
        : focusArea.lines.join("\n");

    const ctx: ResolvedContext = {
      fileContent,
      filePath,
      selection,
      cursorLine: cursorLineNum + 1,
      cursorOnEmptyLine,
      contextSnippet,
      instruction: instructionText,
      instructionContent,
      referenceFiles,
      isInstructionFile,
    };

    const activeEditor = editor;
    const currentFileAbs = activeEditor.document.uri.fsPath;

    // The blank line must be removed before the agent edits the current file
    // so MCP's content-matching sees a clean document. Status decoration and
    // selection restore, however, should survive individual tool failures —
    // only finalize those when the whole session ends.
    let blankRemoved = false;
    async function removeBlankLine() {
      if (blankRemoved || !insertedBlank) return;
      blankRemoved = true;
      try {
        await activeEditor.edit(
          (b) => b.delete(new vscode.Range(insertLine, 0, insertLine + 1, 0)),
          { undoStopBefore: false, undoStopAfter: false },
        );
      } catch {
        /* ignore */
      }
    }

    let teardownDone = false;
    async function teardownPromptLine() {
      if (teardownDone) return;
      teardownDone = true;
      inlinePrompt.dispose();
      await removeBlankLine();
      activeEditor.selection = originalSelection;
      if (originalVisibleRange) {
        activeEditor.revealRange(originalVisibleRange);
      }
    }

    const beforeEditSub = ipcServer.onBeforeEdit(async (filePath) => {
      if (filePath === currentFileAbs) {
        inlinePrompt.dispose();
        await removeBlankLine();
      }
    });

    try {
      const result = await executeInlineAgent(
        agent,
        ctx,
        log,
        ipcServer,
        () => {
          statusBarItem.text = "$(loading~spin) CodeSpark · agent working...";
        },
        (text) => {
          inlinePrompt.showStatus(text);
        },
      );

      pulse.dispose();
      beforeEditSub.dispose();
      await teardownPromptLine();

      recordQuery({
        provider: result.provider,
        model: result.model,
        latencyMs: result.latencyMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        success: true,
        timestamp: Date.now(),
      });

      decorationProvider.deactivate();
      statusBarItem.text = `$(sparkle) CodeSpark · edited`;

      // Keep non-edited lines dimmed; fade in only the changed lines
      if (result.editedLines.length > 0 && editor) {
        const editedLineSet = new Set<number>();
        for (const range of result.editedLines) {
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

        // Restore full opacity when the file is saved
        const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
          if (doc.uri.fsPath === editor.document.uri.fsPath) {
            cleanup();
          }
        });

        // Restore full opacity and cursor position on undo
        const changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
          if (
            e.document.uri.fsPath === editor.document.uri.fsPath &&
            e.reason === vscode.TextDocumentChangeReason.Undo
          ) {
            cleanup();
            if (result.preEditSelection) {
              const anchor = new vscode.Position(
                result.preEditSelection.anchor.line,
                result.preEditSelection.anchor.character,
              );
              const active = new vscode.Position(
                result.preEditSelection.active.line,
                result.preEditSelection.active.character,
              );
              editor.selection = new vscode.Selection(anchor, active);
            }
            if (result.preEditVisibleRange) {
              editor.revealRange(
                new vscode.Range(
                  result.preEditVisibleRange.startLine,
                  0,
                  result.preEditVisibleRange.endLine,
                  0,
                ),
                vscode.TextEditorRevealType.InCenter,
              );
            }
          }
        });
      }
    } catch (err: unknown) {
      pulse.dispose();
      beforeEditSub.dispose();
      await teardownPromptLine();
      decorationProvider.deactivate();
      recordQuery({
        provider: "",
        model: "",
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        success: false,
        timestamp: Date.now(),
      });
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`CodeSpark: ${msg}`);
      updateActiveInstructions();
    }
  };
}
