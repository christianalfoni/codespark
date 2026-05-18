import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendIpcRequest } from "./ipc-client";
import { z } from "zod";

export function registerDiagnosticsTools(server: McpServer) {
  server.registerTool(
    "get_diagnostics",
    {
      annotations: { title: "getDiagnostics" },
      description: `Get LSP diagnostics (errors, warnings, hints) for a file reported by the language server.

Use this when the user asks about a type error, lint issue, or any problem on a specific line. Pass the file path and optionally a 1-based line number to filter to that line only. Omit the line to get all diagnostics in the file.`,
      inputSchema: {
        file_path: z.string().describe("Absolute path to the file"),
        line: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based line number to filter diagnostics to (omit for all)"),
      },
    },
    async ({ file_path, line }) => {
      try {
        const res = await sendIpcRequest("get_diagnostics", { file_path, line });
        if (res.success) {
          return { content: [{ type: "text" as const, text: res.content ?? "" }] };
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
