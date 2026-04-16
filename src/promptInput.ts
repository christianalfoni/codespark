import * as vscode from "vscode";

export interface InlinePrompt {
  showStatus(text: string): void;
  dispose(): void;
}

export interface InlinePromptResult {
  prompt: InlinePrompt;
  instruction: Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTEXT_KEY = "codeSpark.inlinePromptActive";

// ---------------------------------------------------------------------------
// Inline prompt via `type` command interception
// ---------------------------------------------------------------------------

/**
 * Opens an inline prompt on `targetLine` by intercepting the `type` command
 * and building an internal buffer. Text is rendered via `before`/`after`
 * decorations — nothing is written to the document, so no syntax highlighting,
 * bracket matching, or diagnostics interfere.
 *
 * The real editor cursor sits at column 0 on the blank line, positioned
 * between the `before` decoration (text left of the caret) and the `after`
 * decoration (text right of it). This gives a natural blinking caret with
 * full arrow-key support and zero document mutations.
 */
export function createInlinePrompt(
  editor: vscode.TextEditor,
  targetLine: number,
): InlinePromptResult {
  /** Input phase is over (Enter/Escape). Commands stop but showStatus works. */
  let finished = false;
  /** Fully torn down. showStatus is a no-op, decorations are disposed. */
  let disposed = false;

  let buffer = "";
  let caret = 0;

  let resolve!: (value: string | undefined) => void;
  const instruction = new Promise<string | undefined>((r) => {
    resolve = r;
  });

  // --- Decorations --------------------------------------------------------

  const promptDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: "var(--vscode-input-background)",
  });

  const statusDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: "var(--vscode-input-background)",
  });

  function renderPrompt() {
    const beforeText = `›\u00A0${buffer.slice(0, caret).replace(/ /g, "\u00A0")}`;
    const afterText = buffer.slice(caret).replace(/ /g, "\u00A0");

    editor.setDecorations(promptDeco, [
      {
        range: new vscode.Range(targetLine, 0, targetLine, 0),
        renderOptions: {
          before: {
            contentText: beforeText,
            color: "var(--vscode-input-foreground)",
          },
          after: afterText.length > 0
            ? {
                contentText: afterText,
                color: "var(--vscode-input-foreground)",
              }
            : undefined,
        },
      },
    ]);
    editor.setDecorations(statusDeco, []);
  }

  renderPrompt();

  // --- Resolve helpers ----------------------------------------------------

  function submit() {
    if (finished) return;
    const value = buffer.trim();
    finish(value.length > 0 ? value : undefined);
  }

  function cancel() {
    if (finished) return;
    finish(undefined);
  }

  function finish(value: string | undefined) {
    if (finished) return;
    finished = true;
    cleanupCommands();
    resolve(value);
  }

  // --- `type` command override --------------------------------------------

  const typeDisposable = vscode.commands.registerCommand(
    "type",
    (args: { text: string }) => {
      if (finished) return;
      buffer = buffer.slice(0, caret) + args.text + buffer.slice(caret);
      caret += args.text.length;
      renderPrompt();
    },
  );

  // --- Keybinding command handlers ----------------------------------------

  const submitDisposable = vscode.commands.registerCommand(
    "codeSpark.inlinePrompt.submit",
    submit,
  );

  const cancelDisposable = vscode.commands.registerCommand(
    "codeSpark.inlinePrompt.cancel",
    cancel,
  );

  const backspaceDisposable = vscode.commands.registerCommand(
    "codeSpark.inlinePrompt.backspace",
    () => {
      if (finished || caret === 0) return;
      buffer = buffer.slice(0, caret - 1) + buffer.slice(caret);
      caret--;
      renderPrompt();
    },
  );

  const deleteDisposable = vscode.commands.registerCommand(
    "codeSpark.inlinePrompt.delete",
    () => {
      if (finished || caret >= buffer.length) return;
      buffer = buffer.slice(0, caret) + buffer.slice(caret + 1);
      renderPrompt();
    },
  );

  const leftDisposable = vscode.commands.registerCommand(
    "codeSpark.inlinePrompt.cursorLeft",
    () => {
      if (finished || caret === 0) return;
      caret--;
      renderPrompt();
    },
  );

  const rightDisposable = vscode.commands.registerCommand(
    "codeSpark.inlinePrompt.cursorRight",
    () => {
      if (finished || caret >= buffer.length) return;
      caret++;
      renderPrompt();
    },
  );

  const homeDisposable = vscode.commands.registerCommand(
    "codeSpark.inlinePrompt.cursorHome",
    () => {
      if (finished || caret === 0) return;
      caret = 0;
      renderPrompt();
    },
  );

  const endDisposable = vscode.commands.registerCommand(
    "codeSpark.inlinePrompt.cursorEnd",
    () => {
      if (finished || caret >= buffer.length) return;
      caret = buffer.length;
      renderPrompt();
    },
  );

  // Noop — prevent cursor from leaving the prompt line.
  const upDisposable = vscode.commands.registerCommand(
    "codeSpark.inlinePrompt.cursorUp",
    () => {},
  );
  const downDisposable = vscode.commands.registerCommand(
    "codeSpark.inlinePrompt.cursorDown",
    () => {},
  );

  // --- Cancel on click away -----------------------------------------------

  const selectionDisposable = vscode.window.onDidChangeTextEditorSelection(
    (e) => {
      if (finished) return;
      if (e.textEditor !== editor) return;
      if (e.selections[0].active.line !== targetLine) {
        cancel();
      }
    },
  );

  // --- Set context so keybindings activate --------------------------------

  vscode.commands.executeCommand("setContext", CONTEXT_KEY, true);

  // --- showStatus ---------------------------------------------------------

  function showStatus(text: string) {
    if (disposed) return;
    editor.setDecorations(promptDeco, []);
    editor.setDecorations(statusDeco, [
      {
        range: new vscode.Range(targetLine, 0, targetLine, 0),
        renderOptions: {
          before: {
            contentText: `› ${text}`,
            color: "var(--vscode-disabledForeground)",
            fontStyle: "italic",
          },
        },
      },
    ]);
  }

  // --- Cleanup ------------------------------------------------------------

  function cleanupCommands() {
    vscode.commands.executeCommand("setContext", CONTEXT_KEY, false);
    typeDisposable.dispose();
    submitDisposable.dispose();
    cancelDisposable.dispose();
    backspaceDisposable.dispose();
    deleteDisposable.dispose();
    leftDisposable.dispose();
    rightDisposable.dispose();
    homeDisposable.dispose();
    endDisposable.dispose();
    upDisposable.dispose();
    downDisposable.dispose();
    selectionDisposable.dispose();
  }

  return {
    prompt: {
      showStatus,
      dispose() {
        if (!finished) {
          finished = true;
          cleanupCommands();
        }
        if (!disposed) {
          disposed = true;
          promptDeco.dispose();
          statusDeco.dispose();
        }
      },
    },
    instruction,
  };
}
