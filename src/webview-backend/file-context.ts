import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { PendingFileContext } from "../types";

export async function cursorSnippet(
  workspaceFolder: string,
  filePath: string,
  cursorLine: number,
): Promise<string> {
  try {
    const absolute = path.resolve(workspaceFolder, filePath);
    const content = await fs.promises.readFile(absolute, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, cursorLine - 6);
    const end = Math.min(lines.length, cursorLine + 5);
    return `\`\`\`\n${lines.slice(start, end).join("\n")}\n\`\`\``;
  } catch {
    return "";
  }
}

export async function buildFileContextQuery(
  ctx: PendingFileContext,
  workspaceFolder: string,
  userText: string,
) {
  let snippet: string;
  if (ctx.selection) {
    snippet = `\`\`\`\n${ctx.selection}\n\`\`\``;
  } else {
    snippet = await cursorSnippet(
      workspaceFolder,
      ctx.filePath,
      ctx.cursorLine,
    );
  }

  const location =
    ctx.cursorLine > 1
      ? `\`${ctx.filePath}\` (line ${ctx.cursorLine})`
      : `\`${ctx.filePath}\``;

  return `[Viewing ${location}]\n\n${snippet}\n\n${userText}`;
}
