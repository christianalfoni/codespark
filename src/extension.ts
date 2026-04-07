import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { findInstructionsForFile, ResolvedInstructions } from "./instructions";
import { InstructionFileDecorationProvider } from "./instructionDecorations";
import {
  callLLMWithSDK,
  warmupSession,
  closeSession,
  resolveModel,
  buildContextMessages,
  ResolvedModel,
} from "./llm-sdk";
import { ResolvedContext } from "./types";
import { promptForInstruction } from "./promptInput";
import { initStats, recordQuery, showStats, resetStats } from "./stats";
import { evaluateFocusArea } from "./editor";

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("CodeSpark");
  context.subscriptions.push(log);

  initStats(context.workspaceState);

  // Prewarm pi modules on startup
  warmupSession(log);

  // File decoration provider for context files
  const decorationProvider = new InstructionFileDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationProvider),
  );

  // Status bar item showing the active CLAUDE.md
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    0,
  );
  statusBarItem.command = "codeSpark.openInstructions";
  context.subscriptions.push(statusBarItem);

  let currentInstructions: ResolvedInstructions = {
    root: undefined,
    local: [],
    referencedFiles: [],
  };

  function updateActiveInstructions() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      currentInstructions = { root: undefined, local: [], referencedFiles: [] };
      statusBarItem.hide();
      return;
    }

    currentInstructions = findInstructionsForFile(editor.document.uri);

    const labels: string[] = [];
    if (currentInstructions.root) {
      labels.push("root");
    }
    for (const loc of currentInstructions.local) {
      labels.push(vscode.workspace.asRelativePath(loc.uri));
    }

    if (labels.length > 0) {
      statusBarItem.text = `$(sparkle) CodeSpark: ${labels.join(" + ")}`;
      statusBarItem.tooltip = `Active instructions: ${labels.join(", ")}`;
      statusBarItem.show();
    } else {
      statusBarItem.text = "$(sparkle) CodeSpark";
      statusBarItem.tooltip = "No CLAUDE.md or AGENT.md found for this file";
      statusBarItem.show();
    }
  }

  // Update on editor change
  updateActiveInstructions();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateActiveInstructions()),
  );

  // Watch for CLAUDE.md and AGENT.md file changes
  const watcher = vscode.workspace.createFileSystemWatcher(
    "**/{CLAUDE,AGENT}.md",
  );
  const onInstructionsChanged = (type: string) => (uri: vscode.Uri) => {
    log.appendLine(
      `[instructions] ${type}: ${vscode.workspace.asRelativePath(uri)}`,
    );
    updateActiveInstructions();
  };
  watcher.onDidCreate(onInstructionsChanged("Created"));
  watcher.onDidChange(onInstructionsChanged("Updated"));
  watcher.onDidDelete(onInstructionsChanged("Deleted"));
  context.subscriptions.push(watcher);

  // Command to open the active CLAUDE.md file (prefers local, falls back to root)
  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.openInstructions", () => {
      const target = currentInstructions.local[0] ?? currentInstructions.root;
      if (target) {
        vscode.window.showTextDocument(target.uri);
      } else {
        vscode.window.showInformationMessage(
          "No CLAUDE.md or AGENT.md found for the current file.",
        );
      }
    }),
  );

  // Main invoke command
  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.invoke", async () => {
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

      // Show gutter indicator immediately while the prompt is open
      const gutterDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        overviewRulerColor: "#DA7756",
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

      // Build instruction content for system prompt (skip when editing CLAUDE.md itself)
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

      // --- Phase 2: Fire expensive work in parallel with the prompt ---
      // These all run while the user types their instruction.
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

      // Add fade effect now that the LLM is working (gutter already visible from prompt phase)
      const pendingDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        opacity: "0.4",
      });
      editor.setDecorations(pendingDecoration, [pendingRange]);

      // Show loading status
      statusBarItem.text = "$(loading~spin) CodeSpark · thinking...";

      // --- Await parallel work (should already be done by now) ---
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
        overviewRulerColor: "#5B8ADD",
        gutterIconPath: path.join(__dirname, "..", "media", "gutter-agent.svg"),
        gutterIconSize: "contain",
      });

      try {
        if (modelResult instanceof Error) {
          throw modelResult;
        }

        const resolved = modelResult as ResolvedModel;

        // Build context messages (doesn't depend on instruction)
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
            statusBarItem.text =
              "$(loading~spin) CodeSpark · agent working...";
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
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.showStats", () => {
      showStats();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.resetStats", () => {
      resetStats();
      vscode.window.showInformationMessage("CodeSpark: Stats reset.");
    }),
  );
}

export function deactivate() {
  closeSession();
}
