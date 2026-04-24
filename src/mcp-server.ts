#!/usr/bin/env node
/**
 * Long-lived MCP server (Streamable HTTP transport).
 * Exposes edit/write/move/delete tools that proxy to the VS Code extension
 * via a Unix domain socket (IPC).
 *
 * Started once by the extension at activation; the Claude CLI connects
 * to it via URL instead of spawning a new process each time.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as net from "net";
import * as http from "http";
import * as childProcess from "child_process";

// ---------------------------------------------------------------------------
// IPC client — connects to the extension's Unix socket
// ---------------------------------------------------------------------------

const SOCKET_PATH = process.env.CODESPARK_SOCKET;
if (!SOCKET_PATH) {
  process.stderr.write("CODESPARK_SOCKET env var not set\n");
  process.exit(1);
}

const MCP_PORT = process.env.CODESPARK_MCP_PORT;
if (!MCP_PORT) {
  process.stderr.write("CODESPARK_MCP_PORT env var not set\n");
  process.exit(1);
}

let ipcSocket: net.Socket | null = null;
let requestId = 0;
const pending = new Map<
  string,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();

function connectIpc(): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET_PATH!, () => {
      ipcSocket = sock;
      resolve();
    });

    let buffer = "";

    sock.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const p = pending.get(msg.id);
          if (p) {
            pending.delete(msg.id);
            p.resolve(msg);
          }
        } catch {
          // ignore malformed response
        }
      }
    });

    sock.on("error", (err) => {
      reject(err);
    });

    sock.on("close", () => {
      ipcSocket = null;
    });
  });
}

function sendIpcRequest(
  type: string,
  payload: Record<string, unknown>,
): Promise<any> {
  if (!ipcSocket) {
    return Promise.reject(new Error("IPC socket not connected"));
  }
  const id = `req_${++requestId}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ipcSocket!.write(JSON.stringify({ id, type, ...payload }) + "\n");
  });
}

// ---------------------------------------------------------------------------
// Tool definitions — shared across all request-scoped servers
// ---------------------------------------------------------------------------

function registerTools(server: McpServer) {
  // @ts-ignore — MCP SDK's deep type instantiation exceeds TS limit
  server.tool(
    "edit_file",
    `Apply text edits to a file. Accepts multiple edits in a single call.

Each edit replaces \`old_string\` with \`new_string\`. All edit ranges are computed
against the original document text before any replacements are applied, so edits
do not affect each other's positions — you do not need to account for offset shifts.

The editor will automatically scroll to the largest change.

If any edit fails (e.g. old_string not found or is ambiguous), the entire batch
is rejected and no changes are made.

Example: to update an import AND change code, pass both edits in one call:
  edits: [
    { "old_string": "import { A }", "new_string": "import { A, B }" },
    { "old_string": "doSomething(A)", "new_string": "doSomething(A, B)" },
  ]`,
    {
      file_path: z.string().describe("Absolute path to the file to edit"),
      edits: z
        .array(
          z.object({
            old_string: z.string().describe("The exact text to find in the file"),
            new_string: z.string().describe("The replacement text"),
          }),
        )
        .describe("Array of edits to apply atomically"),
    },
    async ({ file_path, edits }) => {
      try {
        const res = await sendIpcRequest("edit_file", { file_path, edits });
        if (res.success) {
          return { content: [{ type: "text" as const, text: res.message }] };
        } else {
          const input = JSON.stringify({ file_path, edits }, null, 2);
          return {
            content: [{ type: "text" as const, text: `Error: ${res.error}\n\nInput:\n${input}` }],
            isError: true,
          };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const input = JSON.stringify({ file_path, edits }, null, 2);
        return {
          content: [{ type: "text" as const, text: `IPC error: ${msg}\n\nInput:\n${input}` }],
          isError: true,
        };
      }
    },
  );

  // @ts-ignore — MCP SDK's deep type instantiation exceeds TS limit
  server.tool(
    "write_file",
    `Write content to a file. Creates the file (and any missing parent directories) if it
does not exist, or replaces the entire content of an existing file.

Use this for new or empty files where edit_file cannot work (there is no old_string to match).
For files that already have content, prefer edit_file instead.`,
    {
      file_path: z.string().describe("Absolute path to the file to write"),
      content: z.string().describe("The full file content to write"),
    },
    async ({ file_path, content }) => {
      try {
        const res = await sendIpcRequest("write_file", { file_path, content });
        if (res.success) {
          return { content: [{ type: "text" as const, text: res.message }] };
        } else {
          return {
            content: [{ type: "text" as const, text: `Error: ${res.error}` }],
            isError: true,
          };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `IPC error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Breakdown
  // -------------------------------------------------------------------------

  // @ts-ignore
  server.tool(
    "write_breakdown",
    `Set the breakdown steps for the user. Each step describes a focused piece of work
in a specific file. The user will see these in the sidebar and can click each one to see
its details.

Use this when the user wants to implement something and you want to break it into steps.
Describe WHAT needs to be done and WHERE, but do not write the full solution — give enough
context for the user to attempt it themselves. The breakdown is also shared with the inline
editing agent (Cmd+I) so it has context about the overall approach.

Calling this tool replaces any existing breakdown. Prefer update_breakdown_step when only
one or a few steps need changes.`,
    {
      items: z
        .array(
          z.object({
            title: z.string().describe("Short title (e.g. 'Add message type')"),
            description: z.string().describe("A markdown bullet list of considerations and hints. Use '- ' bullets. When referencing code (types, function signatures, patterns to follow), use fenced code blocks rather than inline code — they are easier to copy and read. Guide without giving the full solution."),
            filePath: z.string().describe("Relative path to the file to work on"),
            lineHint: z.number().optional().describe("Approximate line number to start at"),
          }),
        )
        .describe("Ordered list of steps"),
    },
    async ({ items }) => {
      try {
        const res = await sendIpcRequest("write_breakdown", { items });
        if (res.success) {
          return { content: [{ type: "text" as const, text: res.message }] };
        } else {
          return {
            content: [{ type: "text" as const, text: `Error: ${res.error}` }],
            isError: true,
          };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `IPC error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // @ts-ignore
  server.tool(
    "update_breakdown_step",
    `Update a single step in the existing breakdown by its index (0-based). Only the fields
you provide will be updated — omit fields to keep their current values. Use this for small
adjustments instead of rewriting the entire breakdown with write_breakdown.`,
    {
      index: z.number().describe("0-based index of the step to update"),
      title: z.string().optional().describe("New title for the step"),
      description: z.string().optional().describe("New description for the step"),
      filePath: z.string().optional().describe("New file path for the step"),
      lineHint: z.number().optional().describe("New line hint for the step"),
    },
    async ({ index, title, description, filePath, lineHint }) => {
      try {
        const res = await sendIpcRequest("update_breakdown_step", {
          index,
          ...(title !== undefined && { title }),
          ...(description !== undefined && { description }),
          ...(filePath !== undefined && { filePath }),
          ...(lineHint !== undefined && { lineHint }),
        });
        if (res.success) {
          return { content: [{ type: "text" as const, text: res.message }] };
        } else {
          return {
            content: [{ type: "text" as const, text: `Error: ${res.error}` }],
            isError: true,
          };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `IPC error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Read-only git tools
  // -------------------------------------------------------------------------

  const gitCwd = process.env.CODESPARK_WORKSPACE || process.cwd();

  function runGit(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      childProcess.execFile("git", args, { cwd: gitCwd, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  async function matchingRemote(ref: string): Promise<string | null> {
    const stripped = ref.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length) : ref;
    const slash = stripped.indexOf("/");
    if (slash <= 0) return null;
    const candidate = stripped.slice(0, slash);
    try {
      const remotes = (await runGit(["remote"])).split("\n").map((r) => r.trim()).filter(Boolean);
      return remotes.includes(candidate) ? candidate : null;
    } catch {
      return null;
    }
  }

  // @ts-ignore
  server.tool(
    "git_status",
    `Show the current branch, staged, modified, and untracked files.`,
    {},
    async () => {
      try {
        const output = await runGit(["status", "--short", "--branch"]);
        return { content: [{ type: "text" as const, text: output }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // @ts-ignore
  server.tool(
    "git_log",
    `View commit history. Optionally filter by file path or ref (branch/tag/hash).`,
    {
      max_count: z.number().optional().default(20).describe("Maximum number of commits to show"),
      file: z.string().optional().describe("Filter commits that touch this file path"),
      ref: z.string().optional().describe("Branch, tag, or commit hash to start from"),
    },
    async ({ max_count, file, ref }) => {
      try {
        const args = ["log", `--max-count=${max_count}`, "--oneline", "--decorate"];
        if (ref) args.push(ref);
        if (file) args.push("--", file);
        const output = await runGit(args);
        return { content: [{ type: "text" as const, text: output }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // @ts-ignore
  server.tool(
    "git_diff",
    `Show diffs. With no arguments shows unstaged changes. Use staged=true for staged changes,
or provide a ref (e.g. "main", "HEAD~3") to diff against.`,
    {
      staged: z.boolean().optional().default(false).describe("Show staged (cached) changes"),
      ref: z.string().optional().describe("Diff against this ref (branch, tag, or commit)"),
      file: z.string().optional().describe("Limit diff to this file path"),
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
        return { content: [{ type: "text" as const, text: output || "(no diff)" }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // @ts-ignore
  server.tool(
    "git_blame",
    `Annotate a file with authorship and last-change info for each line.`,
    {
      file: z.string().describe("File path to annotate"),
    },
    async ({ file }) => {
      try {
        const output = await runGit(["blame", "--date=short", file]);
        return { content: [{ type: "text" as const, text: output }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Startup — stateless HTTP server (new transport per request)
// ---------------------------------------------------------------------------

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function connectIpcWithRetry(maxRetries = 5, delayMs = 200): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await connectIpc();
      return;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      process.stderr.write(`IPC connect attempt ${attempt}/${maxRetries} failed, retrying in ${delayMs}ms...\n`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  await connectIpcWithRetry();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname !== "/mcp") {
      res.writeHead(404).end("Not found");
      return;
    }

    if (req.method === "POST") {
      const mcpServer = new McpServer({ name: "codespark", version: "1.0.0" });
      registerTools(mcpServer);

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);

      const parsedBody = await parseBody(req);
      await transport.handleRequest(req, res, parsedBody);

      res.on("close", () => {
        transport.close();
        mcpServer.close();
      });
    } else if (req.method === "GET" || req.method === "DELETE") {
      res.writeHead(405).end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      }));
    } else {
      res.writeHead(405).end();
    }
  });

  const port = parseInt(MCP_PORT!, 10);
  httpServer.listen(port, "127.0.0.1", () => {
    process.stderr.write(`MCP server listening on http://127.0.0.1:${port}/mcp\n`);
  });
}

main().catch((err) => {
  process.stderr.write(`MCP server failed to start: ${err}\n`);
  process.exit(1);
});
