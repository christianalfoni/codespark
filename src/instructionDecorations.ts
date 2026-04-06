import * as vscode from "vscode";
import * as fs from "fs";
import { findInstructionsForFile, ResolvedInstructions } from "./instructions";

export class InstructionFileDecorationProvider
  implements vscode.FileDecorationProvider
{
  private _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private inlinedFileUris = new Set<string>();
  private referencedFileUris = new Set<string>();
  private referencedFolderUris = new Set<string>();
  private refresh(): void {
    this._onDidChange.fire(undefined);
  }

  activate(editorUri: vscode.Uri): ResolvedInstructions {
    this.inlinedFileUris.clear();
    this.referencedFileUris.clear();
    this.referencedFolderUris.clear();

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editorUri);
    if (!workspaceFolder) {
      this.refresh();
      return { root: undefined, local: [], referencedFiles: [] };
    }

    const instructions = findInstructionsForFile(editorUri);

    // Track CLAUDE.md / AGENT.md files (inlined into context)
    if (instructions.root) {
      this.inlinedFileUris.add(instructions.root.uri.fsPath);
    }
    for (const loc of instructions.local) {
      this.inlinedFileUris.add(loc.uri.fsPath);
    }

    // Track referenced files/directories from CLAUDE.md links
    for (const absPath of instructions.referencedFiles) {
      let isDir = false;
      try {
        isDir = fs.statSync(absPath).isDirectory();
      } catch {
        // skip
      }
      if (isDir) {
        this.referencedFolderUris.add(absPath);
      } else {
        this.referencedFileUris.add(absPath);
      }
    }

    this.refresh();
    return instructions;
  }

  deactivate(): void {
    this.inlinedFileUris.clear();
    this.referencedFileUris.clear();
    this.referencedFolderUris.clear();
    this.refresh();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const fsPath = uri.fsPath;

    if (this.inlinedFileUris.has(fsPath)) {
      return {
        badge: "✦",
        tooltip: "Included in Spark context",
      };
    }

    if (this.referencedFileUris.has(fsPath)) {
      return {
        badge: "✧",
        tooltip: "Referenced in Spark context",
      };
    }

    if (this.referencedFolderUris.has(fsPath)) {
      return {
        badge: "✧",
        tooltip: "Referenced in Spark context",
      };
    }

    return undefined;
  }
}
