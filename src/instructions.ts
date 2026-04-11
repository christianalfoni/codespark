import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

const INSTRUCTION_FILENAMES = ["CLAUDE.md"];

/**
 * Process markdown links in CLAUDE.md content:
 * - Directory links are expanded into inline file listings
 * - File links are collected as referenced files (to be pre-read into context)
 *   and removed from the content
 */
function processLinks(
  content: string,
  instructionDir: string,
): { content: string; referencedFiles: string[] } {
  const referencedFiles: string[] = [];
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const processed = content.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, label: string, linkPath: string) => {
      // Skip URLs
      if (/^https?:\/\//.test(linkPath)) {
        return _match;
      }
      const resolved = path.resolve(instructionDir, linkPath);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
      } catch {
        return _match;
      }

      // Rewrite link to workspace-relative path
      const wsRelative = workspaceRoot ? path.relative(workspaceRoot, resolved) : linkPath;

      if (stat.isDirectory()) {
        const tree = buildDirTree(resolved);
        if (tree.length === 0) {
          return _match;
        }
        referencedFiles.push(resolved);
        return `[${label}](${wsRelative}) (Available files:\n${tree.join("\n")}\n)`;
      }

      if (stat.isFile()) {
        referencedFiles.push(resolved);
        return `[${label}](${wsRelative})`;
      }

      return _match;
    },
  );

  return { content: processed, referencedFiles };
}

function buildDirTree(absDir: string, indent: string = "  "): string[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: string[] = [];
  const sorted = dirents
    .filter((e) => e.name !== "node_modules" && e.name !== ".git")
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of sorted) {
    if (entry.isDirectory()) {
      results.push(`${indent}${entry.name}/`);
      results.push(...buildDirTree(path.join(absDir, entry.name), indent + "  "));
    } else {
      results.push(`${indent}${entry.name}`);
    }
  }
  return results;
}

export interface ResolvedInstructions {
  root: { uri: vscode.Uri; content: string } | undefined;
  /** All intermediate instruction files between the file's directory and the root (closest first) */
  local: { uri: vscode.Uri; content: string }[];
  /** Absolute paths to files referenced by markdown links in CLAUDE.md files */
  referencedFiles: string[];
}

/**
 * Find instructions for the given file:
 * - root: CLAUDE.md at workspace root (if it exists)
 * - local: the closest CLAUDE.md traversing up from the file's directory
 *          (excluded if it's the same as root)
 */
export function findInstructionsForFile(fileUri: vscode.Uri): ResolvedInstructions {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
  if (!workspaceFolder) {
    return { root: undefined, local: [], referencedFiles: [] };
  }

  const rootPath = workspaceFolder.uri.fsPath;
  const allReferencedFiles: string[] = [];

  // Always try to load root instruction file (CLAUDE.md)
  let root: ResolvedInstructions["root"];
  let rootCandidate: string | undefined;
  for (const filename of INSTRUCTION_FILENAMES) {
    const candidate = path.join(rootPath, filename);
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, "utf-8");
        const { content, referencedFiles } = processLinks(raw, path.dirname(candidate));
        root = { uri: vscode.Uri.file(candidate), content };
        rootCandidate = candidate;
        allReferencedFiles.push(...referencedFiles);
      } catch {
        // ignore
      }
      break;
    }
  }

  // Traverse up from file's directory to root, collecting all intermediate instruction files
  const local: ResolvedInstructions["local"] = [];
  let dir = path.dirname(fileUri.fsPath);

  while (dir.startsWith(rootPath)) {
    for (const filename of INSTRUCTION_FILENAMES) {
      const candidate = path.join(dir, filename);
      if (fs.existsSync(candidate)) {
        if (candidate !== rootCandidate) {
          try {
            const raw = fs.readFileSync(candidate, "utf-8");
            const { content, referencedFiles } = processLinks(raw, path.dirname(candidate));
            local.push({ uri: vscode.Uri.file(candidate), content });
            allReferencedFiles.push(...referencedFiles);
          } catch {
            // ignore
          }
        }
        break; // only one instruction file per directory
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return { root, local, referencedFiles: allReferencedFiles };
}

/**
 * Find all CLAUDE.md files in the workspace.
 */
export function findAllInstructionFiles(): vscode.Uri[] {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return [];
  }

  const results: vscode.Uri[] = [];
  const root = workspaceFolder.uri.fsPath;

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (INSTRUCTION_FILENAMES.includes(entry.name)) {
        results.push(vscode.Uri.file(full));
      }
    }
  }

  walk(root);
  return results;
}
