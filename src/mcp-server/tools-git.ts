import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as childProcess from "child_process";

export const gitCwd = process.env.CODESPARK_WORKSPACE || process.cwd();

export function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      "git",
      args,
      { cwd: gitCwd, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

async function matchingRemote(ref: string): Promise<string | null> {
  const stripped = ref.startsWith("refs/remotes/")
    ? ref.slice("refs/remotes/".length)
    : ref;
  const slash = stripped.indexOf("/");
  if (slash <= 0) return null;
  const candidate = stripped.slice(0, slash);
  try {
    const remotes = (await runGit(["remote"]))
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
    return remotes.includes(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function registerGitTools(server: McpServer) {
  server.registerTool(
    "git_status",
    {
      description: `Show the current branch, staged, modified, and untracked files.`,
    },
    async () => {
      try {
        const output = await runGit(["status", "--short", "--branch"]);
        return { content: [{ type: "text" as const, text: output }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "git_log",
    {
      description: `View commit history. Optionally filter by file path or ref (branch/tag/hash).`,
      inputSchema: {
        max_count: z
          .number()
          .optional()
          .default(20)
          .describe("Maximum number of commits to show"),
        file: z
          .string()
          .optional()
          .describe("Filter commits that touch this file path"),
        ref: z
          .string()
          .optional()
          .describe("Branch, tag, or commit hash to start from"),
      },
    },
    async ({ max_count, file, ref }) => {
      try {
        const args = [
          "log",
          `--max-count=${max_count}`,
          "--oneline",
          "--decorate",
        ];
        if (ref) args.push(ref);
        if (file) args.push("--", file);
        const output = await runGit(args);
        return { content: [{ type: "text" as const, text: output }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "git_diff",
    {
      description: `Show diffs. With no arguments shows unstaged changes. Use staged=true for staged changes,
or provide a ref (e.g. "main", "HEAD~3") to diff against.`,
      inputSchema: {
        staged: z
          .boolean()
          .optional()
          .default(false)
          .describe("Show staged (cached) changes"),
        ref: z
          .string()
          .optional()
          .describe("Diff against this ref (branch, tag, or commit)"),
        file: z.string().optional().describe("Limit diff to this file path"),
      },
    },
    async ({ staged, ref, file }) => {
      try {
        if (ref) {
          const remote = await matchingRemote(ref);
          if (remote) {
            try {
              await runGit(["fetch", "--quiet", remote]);
            } catch {
              // Swallow fetch errors (offline, auth, etc.) and fall through to the diff.
            }
          }
        }
        const args = ["diff"];
        if (staged) args.push("--cached");
        if (ref) args.push(ref);
        if (file) args.push("--", file);
        const output = await runGit(args);
        return {
          content: [{ type: "text" as const, text: output || "(no diff)" }],
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

  server.registerTool(
    "git_blame",
    {
      description: `Annotate a file with authorship and last-change info for each line.`,
      inputSchema: {
        file: z.string().describe("File path to annotate"),
      },
    },
    async ({ file }) => {
      try {
        const output = await runGit(["blame", "--date=short", file]);
        return { content: [{ type: "text" as const, text: output }] };
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
