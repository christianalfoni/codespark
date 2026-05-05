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

export function registerPrTools(server: McpServer) {
  server.registerTool(
    "create_pr",
    {
      annotations: { title: "Create PR" },
      description: `Stage all changes, commit, push, and open a GitHub pull request.

Before calling this tool, you must compose both the commit_message and pr_description
yourself, using:
  - The current diff (git_diff against the base branch or HEAD)
  - The session breakdown steps (if any were set)
  - The conversation with the user

**Commit message** — one concise imperative sentence (≤72 chars). No period.

**PR description** — use this format:

## [User story title — written as consumer value]

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
- If there are multiple user stories, repeat the full block per story

The tool commits everything currently modified or untracked, pushes to origin, and
creates the PR. The first line of commit_message becomes the PR title.`,
      inputSchema: {
        commit_message: z
          .string()
          .describe("Commit message (first line becomes the PR title)"),
        pr_description: z
          .string()
          .describe("Full PR body in Agent Contribution Report markdown format"),
      },
    },
    async ({ commit_message, pr_description }) => {
      try {
        await runGit(["add", "-A"]);

        const staged = (await runGit(["diff", "--cached", "--name-only"])).trim();
        if (!staged) {
          return {
            content: [{ type: "text" as const, text: "Nothing to commit — working tree clean." }],
          };
        }

        await runGit(["commit", "-m", commit_message]);

        const branch = (await runGit(["branch", "--show-current"])).trim();

        try {
          await runGit(["push", "--set-upstream", "origin", branch]);
        } catch {
          await runGit(["push"]);
        }

        const prTitle = commit_message.split("\n")[0].trim();
        const prUrl = await runCommand("gh", [
          "pr",
          "create",
          "--title",
          prTitle,
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
