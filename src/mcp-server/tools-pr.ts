import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as childProcess from "child_process";
import { gitCwd, runGit } from "./tools-git";

function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      cmd,
      args,
      { cwd: gitCwd, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message));
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

const DEFAULT_PR_TEMPLATE = `## [User story title — written as consumer value]

### ❌ Current behavior
[ASCII UI mockup, code block, or Mermaid diagram showing the experience BEFORE]

### ✅ New behavior
[ASCII UI mockup, code block, or Mermaid diagram showing the experience AFTER]

### 🤔 Assumptions
- [one line each]

### 🧠 Decisions
- [one line each]

### 🔄 Discussions
- [only if you changed direction mid-session — omit if none]

### 🧪 Testing
- [what was verified, or "Not tested"]

### 📁 References
- [relative/path/to/file.ts](relative/path/to/file.ts)

Rules:
- For VS Code extensions use ASCII UI mockups of panels/dialogs, not internal source code
- Use Mermaid diagrams when a flow or sequence changed (5–7 nodes max)
- Skip mechanical housekeeping: git ops, version bumps, env/tooling setup
- References list only files directly read or edited during the session
- If there are multiple user stories, repeat the full block per story`;

export function registerPrTools(server: McpServer) {
  const prTemplate = process.env.CODESPARK_PR_TEMPLATE || DEFAULT_PR_TEMPLATE;

  server.registerTool(
    "create_pr",
    {
      annotations: { title: "Create PR" },
      description: `Push the current branch and open a GitHub pull request.

Before calling this tool, you must compose the pr_description yourself, using:
  - git_log and git_diff to understand what commits have been made
  - The session breakdown steps (if any were set)
  - The conversation with the user

**PR title** — derived from the first line of the most recent commit message.

**PR description** — use this format:

${prTemplate}

The tool pushes the current branch to origin and creates the PR.`,
      inputSchema: {
        pr_title: z
          .string()
          .describe("PR title — use the first line of the most recent commit message"),
        pr_description: z
          .string()
          .describe("Full PR body in Agent Contribution Report markdown format"),
      },
    },
    async ({ pr_title, pr_description }) => {
      try {
        const branch = (await runGit(["branch", "--show-current"])).trim();

        try {
          await runGit(["push", "--set-upstream", "origin", branch]);
        } catch {
          await runGit(["push"]);
        }

        const prUrl = await runCommand("gh", [
          "pr",
          "create",
          "--title",
          pr_title,
          "--body",
          pr_description,
        ]);

        return {
          content: [{ type: "text" as const, text: `PR created: ${prUrl}` }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
