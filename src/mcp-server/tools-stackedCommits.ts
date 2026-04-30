import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as path from "path";
import * as fs from "fs";
import { gitCwd, runGit } from "./tools-git";

export function registerStackedCommitsTools(server: McpServer) {
  // -------------------------------------------------------------------------
  // Stacked commits (experimental — gated on CODESPARK_STACKED_COMMITS env)
  // -------------------------------------------------------------------------

  if (!process.env.CODESPARK_STACKED_COMMITS) {
    return;
  }

  server.registerTool(
    "create_stacked_commits",
    {
      description: `Stage specific files and create a sequence of commits from them.

Use the breakdown steps as a guide to decide which changed files belong to each
commit. Multiple breakdown steps may touch the same file, and a step may involve
files not explicitly listed in its breakdown entry — use your judgement. You do
not need to worry about the contents of each file, only which files belong to
which commit.

Workflow:
  1. Call git_status to see all uncommitted changes.
  2. Decide which files belong to each logical commit, guided by the breakdown.
  3. Call this tool with the ordered list of commits and their file paths.

The tool stages each file list and commits in order. On failure after partial
progress, it rolls back with git reset --soft so no commits are lost permanently.

Preconditions:
  - There must be uncommitted changes.
  - No merge, rebase, or cherry-pick in progress.`,
      inputSchema: {
        commits: z
          .array(
            z.object({
              message: z
                .string()
                .describe("Commit message"),
              files: z
                .array(z.string())
                .min(1)
                .describe("Relative file paths to stage for this commit"),
            }),
          )
          .min(1)
          .describe("Ordered list of commits to create"),
      },
    },
    async ({ commits }) => {
      try {
        const result = await createStackedCommits(commits, runGit, gitCwd);
        return { content: [{ type: "text" as const, text: result }] };
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

// ---------------------------------------------------------------------------
// Stacked-commit helpers
// ---------------------------------------------------------------------------

async function createStackedCommits(
  commits: Array<{ message: string; files: string[] }>,
  runGit: (args: string[]) => Promise<string>,
  gitCwd: string,
): Promise<string> {
  const gitDir = (await runGit(["rev-parse", "--git-dir"])).trim();
  const gitDirAbs = path.resolve(gitCwd, gitDir);
  const inProgressMarkers = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-apply",
    "rebase-merge",
  ];
  for (const marker of inProgressMarkers) {
    if (fs.existsSync(path.join(gitDirAbs, marker))) {
      throw new Error(
        `Cannot create stacked commits while '${marker}' is in progress. Finish or abort it first.`,
      );
    }
  }

  const created: Array<{ sha: string; message: string }> = [];

  try {
    for (const { message, files } of commits) {
      await runGit(["add", ...files]);
      await runGit(["commit", "-m", message]);
      const sha = (await runGit(["rev-parse", "--short", "HEAD"])).trim();
      created.push({ sha, message });
    }

    const remainingStatus = (await runGit(["status", "--porcelain"])).trim();

    let report = `Created ${created.length} commit(s):\n`;
    for (const c of created) {
      report += `  ${c.sha}  ${firstLine(c.message)}\n`;
    }
    if (remainingStatus) {
      report += `\nNote: some changes remain uncommitted. Review with git_status.`;
    }
    return report;
  } catch (err: unknown) {
    if (created.length > 0) {
      try {
        await runGit(["reset", "--soft", `HEAD~${created.length}`]);
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${msg}\n\nRolled back ${created.length} commit(s) with git reset --soft.`,
        );
      } catch (rollbackErr: unknown) {
        const rbMsg =
          rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr);
        const origMsg = err instanceof Error ? err.message : String(err);
        throw new Error(`${origMsg}\n\nRollback also failed: ${rbMsg}`);
      }
    }
    throw err;
  }
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return idx === -1 ? s : s.slice(0, idx);
}
