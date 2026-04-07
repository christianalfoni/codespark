import * as vscode from "vscode";
import { findInstructionsForFile, ResolvedInstructions } from "./instructions";

export function createUpdateActiveInstructions(
  statusBarItem: vscode.StatusBarItem,
) {
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

  return {
    update: updateActiveInstructions,
    get: () => currentInstructions,
  };
}
