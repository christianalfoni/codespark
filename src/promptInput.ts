import * as vscode from "vscode";

export interface PromptResult {
  instruction: string;
}

export function promptForInstruction(): Promise<PromptResult | undefined> {
  return new Promise((resolve) => {
    const input = vscode.window.createInputBox();
    input.title = "Edit";
    input.placeholder = "e.g. Replace with Box";

    let resolved = false;

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

    input.show();
  });
}
