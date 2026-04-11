#!/usr/bin/env node
/**
 * Standalone MCP server (stdio transport).
 * Exposes an `edit_file` tool that proxies edits to the VS Code extension
 * via a Unix domain socket (IPC).
 *
 * Started as a child process by the extension; communicates with Claude CLI
 * over stdin/stdout using the MCP protocol.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as net from "net";

// ---------------------------------------------------------------------------
// IPC client — connects to the extension's Unix socket
// ---------------------------------------------------------------------------

const SOCKET_PATH = process.env.CODESPARK_SOCKET;
if (!SOCKET_PATH) {
  process.stderr.write("CODESPARK_SOCKET env var not set\n");
  process.exit(1);
}

let ipcSocket: net.Socket | null = null;
let requestId = 0;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();

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

function sendIpcRequest(type: string, payload: Record<string, unknown>): Promise<any> {
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
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "codespark",
  version: "1.0.0",
});

// @ts-ignore — MCP SDK's deep type instantiation exceeds TS limit
server.tool(
  "edit_file",
  `Apply text edits to a file. Accepts multiple edits in a single call.

Each edit replaces \`old_string\` with \`new_string\`. All edit ranges are computed
against the original document text before any replacements are applied, so edits
do not affect each other's positions — you do not need to account for offset shifts.

If any edit fails (e.g. old_string not found or is ambiguous), the entire batch
is rejected and no changes are made.

Example: to update an import AND change code, pass both edits in one call:
  edits: [
    { "old_string": "import { A }", "new_string": "import { A, B }" },
    { "old_string": "doSomething(A)", "new_string": "doSomething(A, B)" }
  ]`,
  {
    file_path: z.string().describe("Absolute path to the file to edit"),
    edits: z.array(
      z.object({
        old_string: z.string().describe("The exact text to find in the file"),
        new_string: z.string().describe("The replacement text"),
      }),
    ).describe("Array of edits to apply atomically"),
  },
  async ({ file_path, edits }) => {
    try {
      const res = await sendIpcRequest("edit_file", { file_path, edits });
      if (res.success) {
        return { content: [{ type: "text" as const, text: res.message }] };
      } else {
        return { content: [{ type: "text" as const, text: `Error: ${res.error}` }], isError: true };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `IPC error: ${msg}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  await connectIpc();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server failed to start: ${err}\n`);
  process.exit(1);
});
