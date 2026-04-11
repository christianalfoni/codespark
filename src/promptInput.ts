import * as vscode from "vscode";

export interface PromptResult {
  instruction: string;
}

export function promptForInstruction(): { result: Promise<PromptResult | undefined> } {
  const input = vscode.window.createInputBox();
  input.title = "CodeSpark";
  input.placeholder = "e.g. Replace with Box";

  let resolved = false;

  const result = new Promise<PromptResult | undefined>((resolve) => {
    input.onDidAccept(() => {
      const value = input.value.trim();
      resolved = true;
      input.dispose();

      if (!value) {
        resolve(undefined);
        return;
      }

      resolve({ instruction: value });
    });

    input.onDidHide(() => {
      if (!resolved) {
        input.dispose();
        resolve(undefined);
      }
    });
  });

  input.show();

  return { result };
}
