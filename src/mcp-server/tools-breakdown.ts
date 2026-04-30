import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendIpcRequest } from "./ipc-client";

export function registerBreakdownTools(server: McpServer) {
  server.registerTool(
    "write_breakdown",
    {
      description: `Set the breakdown steps for the user. Each step describes a focused piece of work
in a specific file. The user will see these in the sidebar and can click each one to see
its details.

Use this when the user wants to implement something and you want to break it into steps.
Describe WHAT needs to be done and WHERE, but do not write the full solution — give enough
context for the user to attempt it themselves. The breakdown is also shared with the inline
editing agent (Cmd+I) so it has context about the overall approach.

Calling this tool always replaces the entire breakdown.`,
      inputSchema: {
        items: z
          .array(
            z.object({
              title: z
                .string()
                .describe("Short title (e.g. 'Add message type')"),
              description: z
                .string()
                .describe(
                  "A markdown bullet list of considerations and hints. Use '- ' bullets. When referencing code (types, function signatures, patterns to follow), use fenced code blocks rather than inline code — they are easier to copy and read. Guide without giving the full solution.",
                ),
              filePath: z
                .string()
                .describe("Relative path to the file to work on"),
              lineHint: z
                .number()
                .optional()
                .describe("Approximate line number to start at"),
            }),
          )
          .describe("Ordered list of steps"),
      },
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
}
