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

/* ── File-level decoration helpers ────────────────────────────── */

/**
 * Scanning effect: a bright band sweeps down through the dimmed file.
 * Lines near the scan position are more opaque, the rest stay dim.
 */
function startFileScan(
  editor: vscode.TextEditor,
): { dispose: () => void } {
  const lineCount = editor.document.lineCount;

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
  let scanPos = 0;

  function applyFrame() {
    // Group lines by their opacity level
    const buckets: vscode.Range[][] = Array.from(
      { length: LEVELS },
      () => [],
    );

    for (let line = 0; line < lineCount; line++) {
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
    // Wrap around with some overshoot so the band fully exits before restarting
    if (scanPos > lineCount + BAND_RADIUS) {
      scanPos = -BAND_RADIUS;
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
      invokeDim.dispose();
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

    // Start scanning immediately after prompt submission
    invokeDim.dispose();
    let pulse: { dispose: () => void } = startFileScan(editor);

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

      if (!result.hasEdits) {
        decorationProvider.deactivate();
        vscode.window.showInformationMessage("CodeSpark: No edits suggested.");
        updateActiveInstructions();
        return;
      }

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
