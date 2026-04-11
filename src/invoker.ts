import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { InstructionFileDecorationProvider } from "./instructionDecorations";
import { prepareInlineAgent, executeInlineAgent, abortInlineAgent } from "./claude-code-inline";
import { ResolvedContext, LLMResult } from "./types";
import { promptForInstruction } from "./promptInput";
import { recordQuery } from "./stats";
import { evaluateFocusArea } from "./editor";
import { IpcServer } from "./ipc-server";

/* ── File-level decoration helpers ────────────────────────────── */

/**
 * Placeholder for empty files: shows a "Generating..." decoration on line 1
 * with a blinking cursor-style animation via opacity toggling.
 */
function startEmptyFilePlaceholder(
  editor: vscode.TextEditor,
): { dispose: () => void } {
  const placeholderType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    after: {
      contentText: "  Generating...",
      color: "var(--vscode-editorGhostText-foreground, rgba(255,255,255,0.4))",
      fontStyle: "italic",
    },
  });

  editor.setDecorations(placeholderType, [
    new vscode.Range(0, 0, 0, 0),
  ]);

  return {
    dispose() {
      placeholderType.dispose();
    },
  };
}

/**
 * Scanning effect: a bright band sweeps down through visible lines only.
 * Lines near the scan position are more opaque, the rest stay dim.
 */
function startFileScan(
  editor: vscode.TextEditor,
): { dispose: () => void } {
  // Pre-create opacity levels — fewer types = better performance.
  // Level 0 = dimmest (base), last = brightest (scan center).
  const BASE_OPACITY = 0.3;
  const PEAK_OPACITY = 0.85;
  const LEVELS = 6;
  const opacityTypes: vscode.TextEditorDecorationType[] = [];
  for (let i = 0; i < LEVELS; i++) {
    const t = i / (LEVELS - 1); // 0 → 1
    const opacity = BASE_OPACITY + t * (PEAK_OPACITY - BASE_OPACITY);
    opacityTypes.push(
      vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        opacity: `${opacity}`,
      }),
    );
  }

  // The scan band radius — how many lines from center get the gradient
  const BAND_RADIUS = 4;
  const SCAN_SPEED = 2; // lines per tick
  const TICK_MS = 60;

  function getVisibleRange(): { start: number; end: number } {
    const ranges = editor.visibleRanges;
    if (ranges.length === 0) {
      return { start: 0, end: editor.document.lineCount };
    }
    return { start: ranges[0].start.line, end: ranges[ranges.length - 1].end.line };
  }

  let { start: visStart, end: visEnd } = getVisibleRange();
  let scanPos = visStart;

  function applyFrame() {
    // Re-read visible range each frame so scrolling is handled
    ({ start: visStart, end: visEnd } = getVisibleRange());

    const buckets: vscode.Range[][] = Array.from(
      { length: LEVELS },
      () => [],
    );

    for (let line = visStart; line <= visEnd; line++) {
      const dist = Math.abs(line - scanPos);
      let level: number;
      if (dist >= BAND_RADIUS) {
        level = 0; // base dim
      } else {
        // Cosine falloff: 1 at center → 0 at edge
        const t = Math.cos((dist / BAND_RADIUS) * (Math.PI / 2));
        level = Math.round(t * (LEVELS - 1));
      }
      const range = new vscode.Range(line, 0, line, 0);
      buckets[level].push(range);
    }

    for (let i = 0; i < LEVELS; i++) {
      editor.setDecorations(opacityTypes[i], buckets[i]);
    }
  }

  applyFrame();

  const interval = setInterval(() => {
    scanPos += SCAN_SPEED;
    // Wrap around within visible area
    if (scanPos > visEnd + BAND_RADIUS) {
      scanPos = visStart - BAND_RADIUS;
    }
    applyFrame();
  }, TICK_MS);

  return {
    dispose() {
      clearInterval(interval);
      for (const t of opacityTypes) {
        t.dispose();
      }
    },
  };
}

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

    // Fire off focus area evaluation without blocking — result needed after prompt
    const focusAreaPromise = evaluateFocusArea(editor);

    const pendingRange = new vscode.Range(
      new vscode.Position(0, 0),
      editor.document.lineAt(editor.document.lineCount - 1).range.end,
    );

    // Dim the file while the prompt is open
    const invokeDim = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      opacity: "0.5",
    });
    editor.setDecorations(invokeDim, [pendingRange]);

    const filePath = vscode.workspace.asRelativePath(editor.document.uri);
    const basename = path.basename(editor.document.uri.fsPath);
    const isInstructionFile =
      basename === "CLAUDE.md";

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
    const referenceFiles = isInstructionFile
      ? []
      : (await Promise.all(
          instructions.referencedFiles.map(async (absPath) => {
            try {
              const content = await fs.promises.readFile(absPath, "utf-8");
              const relPath = vscode.workspace.asRelativePath(absPath);
              return { path: relPath, content };
            } catch {
              return null;
            }
          }),
        )).filter(
          (r): r is { path: string; content: string } => r !== null,
        );

    // Pre-spawn the CLI while the user types — it boots in ~1s
    const agentPromise = prepareInlineAgent(
      { fileContent, filePath, referenceFiles, instructionContent, isInstructionFile },
      log,
      mcpConfigPath,
    );

    const promptResult = await promptForInstruction();

    if (!promptResult) {
      // User cancelled — abort the pre-spawned CLI
      agentPromise.then((agent) => abortInlineAgent(agent)).catch(() => {});
      invokeDim.dispose();
      decorationProvider.deactivate();
      return;
    }

    const instruction = promptResult.instruction;

    log.appendLine(`[context] Cursor at line ${cursorLineNum + 1}`);
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
    invokeDim.dispose();
    const isEmpty = editor.document.getText().trim().length === 0;
    let pulse: { dispose: () => void } = isEmpty
      ? startEmptyFilePlaceholder(editor)
      : startFileScan(editor);

    statusBarItem.text = "$(loading~spin) CodeSpark · thinking...";

    // Wait for save, focus area, and the pre-spawned agent in parallel
    const tWait = Date.now();
    const [, focusArea, agent] = await Promise.all([
      savePromise,
      focusAreaPromise,
      agentPromise,
    ]);
    const waitMs = Date.now() - tWait;
    if (waitMs > 50) {
      log.appendLine(`[cli-inline:timing] Waited ${waitMs}ms for CLI to be ready`);
    }

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
      instruction,
      instructionContent,
      referenceFiles,
      isInstructionFile,
    };

    try {
      const result = await executeInlineAgent(
        agent,
        ctx,
        log,
        ipcServer,
        () => {
          statusBarItem.text = "$(loading~spin) CodeSpark · agent working...";
        },
      );

      pulse.dispose();

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
    } catch (err: unknown) {
      pulse.dispose();
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
