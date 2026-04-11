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
    "write_file",
    `Write or create a file with the given content. If the file exists, its content
is fully replaced. If it does not exist, it is created (including parent directories).

Use this for creating new files or when you need to replace the entire content of a file.
For partial edits to existing files, prefer edit_file instead.`,
    {
      file_path: z.string().describe("Absolute path to the file to write"),
      content: z.string().describe("The full content to write to the file"),
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

  // @ts-ignore
  server.tool(
    "move_file",
    `Move or rename a file. Both source and destination must be absolute paths.
If the destination's parent directories don't exist, they will be created.`,
    {
      source: z.string().describe("Absolute path of the file to move"),
      destination: z.string().describe("Absolute path to move the file to"),
    },
    async ({ source, destination }) => {
      try {
        const res = await sendIpcRequest("move_file", { source, destination });
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
    "delete_file",
    `Delete a file. The path must be absolute.`,
    {
      file_path: z.string().describe("Absolute path of the file to delete"),
    },
    async ({ file_path }) => {
      try {
        const res = await sendIpcRequest("delete_file", { file_path });
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

async function main() {
  await connectIpc();

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
  httpServer.listen(port, "localhost", () => {
    process.stderr.write(`MCP server listening on http://localhost:${port}/mcp\n`);
  });
}

main().catch((err) => {
  process.stderr.write(`MCP server failed to start: ${err}\n`);
  process.exit(1);
});
