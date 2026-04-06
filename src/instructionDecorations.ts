import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { findInstructionsForFile, ResolvedInstructions } from "./instructions";

export class InstructionFileDecorationProvider
  implements vscode.FileDecorationProvider
{
  private _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private inlinedFileUris = new Set<string>();
  private referencedFileUris = new Set<string>();
  private referencedFolderUris = new Set<string>();
  private parentFolderUris = new Set<string>();

  private refresh(): void {
    this._onDidChange.fire(undefined);
  }

  activate(editorUri: vscode.Uri): ResolvedInstructions {
    this.inlinedFileUris.clear();
    this.referencedFileUris.clear();
    this.referencedFolderUris.clear();
    this.parentFolderUris.clear();

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editorUri);
    if (!workspaceFolder) {
      this.refresh();
      return { root: undefined, local: undefined, referencedFiles: [] };
    }

    const instructions = findInstructionsForFile(editorUri);
    const rootPath = workspaceFolder.uri.fsPath;
    const allDecoratedPaths: string[] = [];

    // Track CLAUDE.md files (inlined into context)
    if (instructions.root) {
      this.inlinedFileUris.add(instructions.root.uri.fsPath);
      allDecoratedPaths.push(instructions.root.uri.fsPath);
    }
    if (instructions.local) {
      this.inlinedFileUris.add(instructions.local.uri.fsPath);
      allDecoratedPaths.push(instructions.local.uri.fsPath);
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
      allDecoratedPaths.push(absPath);
    }

    // Collect boundary dirs: the directory containing each CLAUDE.md
    // We don't badge these folders just because they contain a CLAUDE.md
    const boundaryDirs = new Set<string>();
    if (instructions.root) {
      boundaryDirs.add(path.dirname(instructions.root.uri.fsPath));
    }
    if (instructions.local) {
      boundaryDirs.add(path.dirname(instructions.local.uri.fsPath));
    }

    // Propagate to parent folders, stopping at boundary dirs
    for (const filePath of allDecoratedPaths) {
      let dir = path.dirname(filePath);
      while (dir.startsWith(rootPath) && dir !== rootPath && !boundaryDirs.has(dir)) {
        this.parentFolderUris.add(dir);
        dir = path.dirname(dir);
      }
    }

    this.refresh();
    return instructions;
  }

  deactivate(): void {
    this.inlinedFileUris.clear();
    this.referencedFileUris.clear();
    this.referencedFolderUris.clear();
    this.parentFolderUris.clear();
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

    if (this.parentFolderUris.has(fsPath)) {
      return {
        badge: "✧",
        tooltip: "Contains files in Spark context",
      };
    }

    return undefined;
  }
}
