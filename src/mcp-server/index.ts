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
import * as http from "http";
import { connectIpcWithRetry } from "./ipc-client";
import { registerFsTools } from "./tools-fs";
import { registerGitTools } from "./tools-git";
import { registerBreakdownTools } from "./tools-breakdown";
import { registerStackedCommitsTools } from "./tools-stackedCommits";

// ---------------------------------------------------------------------------
// IPC client — connects to the extension's Unix socket
// ---------------------------------------------------------------------------

const MCP_PORT = process.env.CODESPARK_MCP_PORT;
if (!MCP_PORT) {
  process.stderr.write("CODESPARK_MCP_PORT env var not set\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Startup — stateless HTTP server (new transport per request)
// ---------------------------------------------------------------------------

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
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

function registerTools(server: McpServer) {
  registerFsTools(server);
  registerGitTools(server);
  registerBreakdownTools(server);
  registerStackedCommitsTools(server);
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

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcpServer.connect(transport);

      const parsedBody = await parseBody(req);
      await transport.handleRequest(req, res, parsedBody);

      res.on("close", () => {
        transport.close();
        mcpServer.close();
      });
    } else if (req.method === "GET" || req.method === "DELETE") {
      res.writeHead(405).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        }),
      );
    } else {
      res.writeHead(405).end();
    }
  });

  const port = parseInt(MCP_PORT!, 10);
  httpServer.listen(port, "127.0.0.1", () => {
    process.stderr.write(
      `MCP server listening on http://127.0.0.1:${port}/mcp\n`,
    );
  });
}

main().catch((err) => {
  process.stderr.write(`MCP server failed to start: ${err}\n`);
  process.exit(1);
});
