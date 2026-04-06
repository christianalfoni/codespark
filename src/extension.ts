import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { findInstructionsForFile, ResolvedInstructions } from "./instructions";
import { InstructionFileDecorationProvider } from "./instructionDecorations";
import { callLLMWithSDK, warmupSession, closeSession } from "./llm-sdk";
import { applyDiffFromBuffer, acceptDiff, rejectDiff, hasPendingDiff, registerDiffHandlers } from "./diff";
import { ResolvedContext } from "./types";
import { promptForInstruction } from "./promptInput";
import { initStats, recordQuery, showStats, resetStats } from "./stats";


export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("CodeSpark");
  context.subscriptions.push(log);

  initStats(context.workspaceState);
  registerDiffHandlers(context);

  // Prewarm pi modules on startup
  warmupSession(log);

  // File decoration provider for context files
  const decorationProvider = new InstructionFileDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationProvider)
  );


  // Status bar item showing the active CLAUDE.md
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    0
  );
  statusBarItem.command = "codeSpark.openInstructions";
  context.subscriptions.push(statusBarItem);

  let currentInstructions: ResolvedInstructions = { root: undefined, local: undefined, referencedFiles: [] };

  function updateActiveInstructions() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      currentInstructions = { root: undefined, local: undefined, referencedFiles: [] };
      statusBarItem.hide();
      return;
    }

    currentInstructions = findInstructionsForFile(editor.document.uri);

    const labels: string[] = [];
    if (currentInstructions.root) {
      labels.push("root");
    }
    if (currentInstructions.local) {
      labels.push(vscode.workspace.asRelativePath(currentInstructions.local.uri));
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
    vscode.window.onDidChangeActiveTextEditor(() => updateActiveInstructions())
  );

  // Watch for CLAUDE.md and AGENT.md file changes
  const watcher = vscode.workspace.createFileSystemWatcher("**/{CLAUDE,AGENT}.md");
  const onInstructionsChanged = (type: string) => (uri: vscode.Uri) => {
    log.appendLine(`[instructions] ${type}: ${vscode.workspace.asRelativePath(uri)}`);
    updateActiveInstructions();
  };
  watcher.onDidCreate(onInstructionsChanged("Created"));
  watcher.onDidChange(onInstructionsChanged("Updated"));
  watcher.onDidDelete(onInstructionsChanged("Deleted"));
  context.subscriptions.push(watcher);

  // Command to open the active CLAUDE.md file (prefers local, falls back to root)
  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.openInstructions", () => {
      const target = currentInstructions.local ?? currentInstructions.root;
      if (target) {
        vscode.window.showTextDocument(target.uri);
      } else {
        vscode.window.showInformationMessage("No CLAUDE.md or AGENT.md found for the current file.");
      }
    })
  );

  // Main invoke command
  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.invoke", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      if (hasPendingDiff()) {
        await rejectDiff();
      }

      const instructions = decorationProvider.activate(editor.document.uri);

      const fileContent = editor.document.getText();
      const selection = editor.selection.isEmpty
        ? undefined
        : editor.document.getText(editor.selection);
      const cursorLineNum = editor.selection.active.line;
      const cursorLine = editor.document.lineAt(cursorLineNum);
      const cursorOnEmptyLine = cursorLine.isEmptyOrWhitespace;

      // Determine focus area based on cursor position
      let contextSnippet: string;
      let focusStartLine: number;
      let focusEndLine: number;
      let enclosingBlock: vscode.FoldingRange | undefined;

      if (cursorLineNum === 0) {
        // First line: whole file
        focusStartLine = 0;
        focusEndLine = editor.document.lineCount - 1;
        contextSnippet = "The whole file";
      } else {
        // Check if cursor is inside a folding block
        const foldingRanges = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
          "vscode.executeFoldingRangeProvider",
          editor.document.uri
        );
        if (foldingRanges) {
          for (const range of foldingRanges) {
            if (range.start <= cursorLineNum && range.end >= cursorLineNum) {
              if (!enclosingBlock || (range.end - range.start) < (enclosingBlock.end - enclosingBlock.start)) {
                enclosingBlock = range;
              }
            }
          }
        }

        if (enclosingBlock) {
          // Inside a block: decoration and snippet cover the block
          focusStartLine = enclosingBlock.start;
          focusEndLine = Math.min(enclosingBlock.end + 1, editor.document.lineCount - 1);
          const lines: string[] = [];
          for (let i = focusStartLine; i <= focusEndLine; i++) {
            lines.push(editor.document.lineAt(i).text);
          }
          contextSnippet = lines.join("\n");
        } else {
          // Any other line: decoration is just the line, snippet is ±5 lines
          focusStartLine = cursorLineNum;
          focusEndLine = cursorLineNum;
          const snippetStart = Math.max(0, cursorLineNum - 5);
          const snippetEnd = Math.min(editor.document.lineCount - 1, cursorLineNum + 5);
          const lines: string[] = [];
          for (let i = snippetStart; i <= snippetEnd; i++) {
            const prefix = i === cursorLineNum ? ">" : " ";
            lines.push(`${prefix} ${editor.document.lineAt(i).text}`);
          }
          contextSnippet = lines.join("\n");
        }
      }

      // Show gutter indicator immediately while the prompt is open
      const gutterDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        overviewRulerColor: '#DA7756',
        gutterIconPath: path.join(__dirname, "..", "media", "gutter-changed.svg"),
        gutterIconSize: "contain",
      });
      const showFullRange = cursorLineNum === 0 || (enclosingBlock && cursorLineNum === enclosingBlock.start);
      const pendingStart = showFullRange ? focusStartLine : cursorLineNum;
      const pendingEnd = showFullRange ? focusEndLine : cursorLineNum;
      const pendingRange = new vscode.Range(
        new vscode.Position(pendingStart, 0),
        editor.document.lineAt(pendingEnd).range.end
      );
      editor.setDecorations(gutterDecoration, [pendingRange]);

      const promptResult = await promptForInstruction();

      if (!promptResult) {
        gutterDecoration.dispose();
        decorationProvider.deactivate();
        return;
      }

      const instruction = promptResult.instruction;

      log.appendLine(`[context] Cursor at line ${cursorLineNum + 1}, focus lines ${focusStartLine + 1}-${focusEndLine + 1}`);
      if (instructions.root) {
        log.appendLine(`[context] Root CLAUDE.md: ${vscode.workspace.asRelativePath(instructions.root.uri)}`);
      }
      if (instructions.local) {
        log.appendLine(`[context] Local CLAUDE.md: ${vscode.workspace.asRelativePath(instructions.local.uri)}`);
      }

      // Add fade effect now that the LLM is working (gutter already visible from prompt phase)
      const pendingDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        opacity: '0.4',
      });
      editor.setDecorations(pendingDecoration, [pendingRange]);

      // Show loading status
      statusBarItem.text = "$(loading~spin) CodeSpark · thinking...";

      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const basename = path.basename(editor.document.uri.fsPath);
      const isInstructionFile = basename === "CLAUDE.md" || basename === "AGENT.md";

      // Build instruction content for system prompt (skip when editing CLAUDE.md itself)
      let instructionContent: string | undefined;
      const referenceFiles: { path: string; content: string }[] = [];
      if (!isInstructionFile) {
        const instructionParts: string[] = [];
        if (instructions.root) {
          instructionParts.push(instructions.root.content);
        }
        if (instructions.local && instructions.local.uri.fsPath !== instructions.root?.uri.fsPath) {
          instructionParts.push(instructions.local.content);
        }
        instructionContent = instructionParts.length > 0 ? instructionParts.join("\n\n---\n\n") : undefined;

        // Read files referenced by CLAUDE.md links
        for (const absPath of instructions.referencedFiles) {
          try {
            const content = fs.readFileSync(absPath, "utf-8");
            const relPath = vscode.workspace.asRelativePath(absPath);
            referenceFiles.push({ path: relPath, content });
          } catch {
            // skip unreadable files
          }
        }
      }

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

      const agentDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        opacity: '0.4',
        overviewRulerColor: '#5B8ADD',
        gutterIconPath: path.join(__dirname, "..", "media", "gutter-agent.svg"),
        gutterIconSize: "contain",
      });

      try {
        await editor.document.save();
        const result = await callLLMWithSDK(ctx, log, () => {
          pendingDecoration.dispose();
          gutterDecoration.dispose();
          editor.setDecorations(agentDecoration, [pendingRange]);
          statusBarItem.text = "$(loading~spin) CodeSpark · agent working...";
        });
        agentDecoration.dispose();
        pendingDecoration.dispose();
        gutterDecoration.dispose();

        const hasEdits = await applyDiffFromBuffer(editor, ctx.fileContent, log);

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
          vscode.window.showInformationMessage("CodeSpark: No edits suggested.");
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
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.acceptDiff", async () => {
      await acceptDiff();
      updateActiveInstructions();
      vscode.window.showInformationMessage("CodeSpark: Diff accepted.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.rejectDiff", async () => {
      await rejectDiff();
      updateActiveInstructions();
      vscode.window.showInformationMessage("CodeSpark: Diff rejected.");
    })
  );

  // Raw test command — bypasses pi-ai entirely
  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.testLm", async () => {
      try {
        log.appendLine("[test] Selecting models...");
        // Try all vendors to find one that actually works
        const allModels = await vscode.lm.selectChatModels();
        log.appendLine(`[test] All available models:`);
        for (const m of allModels) {
          log.appendLine(`[test]   ${m.id} | vendor: ${m.vendor} | family: ${m.family}`);
        }

        // Try copilot vendor first, then any
        const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
        log.appendLine(`[test] Found ${models.length} models`);
        if (models.length === 0) {
          vscode.window.showErrorMessage("No models found");
          return;
        }
        const model = models[0];
        log.appendLine(`[test] Using: ${model.name} (${model.id})`);

        const messages = [
          vscode.LanguageModelChatMessage.User("Say hello in one sentence."),
        ];

        log.appendLine("[test] Calling sendRequest...");
        const response = await model.sendRequest(
          messages,
          { justification: "CodeSpark test request. Click Allow to proceed." },
          new vscode.CancellationTokenSource().token,
        );

        log.appendLine("[test] Got response, consuming text stream...");
        let text = "";
        for await (const fragment of response.text) {
          text += fragment;
          log.appendLine(`[test] fragment: "${fragment}"`);
        }
        log.appendLine(`[test] Done. Full response: "${text}"`);
        log.show();
        vscode.window.showInformationMessage(`LM test: ${text.slice(0, 100)}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.appendLine(`[test] ERROR: ${msg}`);
        log.show();
        vscode.window.showErrorMessage(`LM test failed: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.showStats", () => {
      showStats();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codeSpark.resetStats", () => {
      resetStats();
      vscode.window.showInformationMessage("CodeSpark: Stats reset.");
    })
  );
}

export function deactivate() {
  closeSession();
}
