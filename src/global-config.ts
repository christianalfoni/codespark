import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const MARKER_START = "<!-- codespark-start -->";
const MARKER_END = "<!-- codespark-end -->";

const CLAUDE_MD_BLOCK = `\n${MARKER_START}
## CodeSpark

Do not edit, create, or delete any files. Only read, analyze, plan, and discuss. The only exception is when the user explicitly runs the /apply-intents command — in that case, implement all intent comments found in the workspace.
${MARKER_END}\n`;

const APPLY_INTENTS_COMMAND = `---
description: Find and apply all intent comments in the workspace
---

Find all intent comments in this workspace. Intent comments are lines matching \`// MODIFY: description\`, \`// ADD: description\`, \`// REMOVE: description\` (and equivalents for other comment styles: \`#\`, \`--\`, \`{/* */}\`, \`<!-- -->\`).

Here are the intent comments currently in the workspace:

!\`grep -rn "MODIFY:\\|ADD:\\|REMOVE:" . 2>/dev/null | grep -v "/node_modules/" | grep -v "/.git/" | grep -v "/out/" | grep -v "/dist/"\`

For each intent comment found above, in order:
1. Read the file at the specified location to understand the surrounding context
2. Understand what change is needed: MODIFY = change existing code, ADD = insert new code, REMOVE = delete code
3. Implement the change precisely where the comment is located
4. Remove the intent comment after applying the change

After completing all changes, briefly summarize what was done.
`;

export function installGlobalConfig(log: vscode.OutputChannel): void {
  const claudeDir = path.join(os.homedir(), ".claude");
  const commandsDir = path.join(claudeDir, "commands");

  try {
    fs.mkdirSync(commandsDir, { recursive: true });
  } catch (err) {
    log.appendLine(`[global-config] Failed to create ~/.claude/commands: ${err}`);
    return;
  }

  const commandPath = path.join(commandsDir, "apply-intents.md");
  try {
    fs.writeFileSync(commandPath, APPLY_INTENTS_COMMAND, "utf8");
    log.appendLine(`[global-config] Installed ${commandPath}`);
  } catch (err) {
    log.appendLine(`[global-config] Failed to write apply-intents.md: ${err}`);
  }

  const claudeMdPath = path.join(claudeDir, "CLAUDE.md");
  try {
    let existing = "";
    try {
      existing = fs.readFileSync(claudeMdPath, "utf8");
    } catch {
      // File doesn't exist yet — start fresh
    }

    let updated: string;
    if (existing.includes(MARKER_START)) {
      const before = existing.slice(0, existing.indexOf(MARKER_START));
      const after = existing.slice(existing.indexOf(MARKER_END) + MARKER_END.length);
      updated = before + CLAUDE_MD_BLOCK + after;
    } else {
      updated = existing + CLAUDE_MD_BLOCK;
    }

    fs.writeFileSync(claudeMdPath, updated, "utf8");
    log.appendLine(`[global-config] Updated ${claudeMdPath}`);
  } catch (err) {
    log.appendLine(`[global-config] Failed to update CLAUDE.md: ${err}`);
  }
}
