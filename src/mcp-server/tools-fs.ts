import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendIpcRequest } from "./ipc-client";
import { z } from "zod";
import * as fs from "fs";

export function registerFsTools(server: McpServer) {
  server.registerTool(
    "read_file",
    {
      description: `Read the full contents of a file. Returns raw text with no line-number prefixes.
    
    Use this to inspect a file before editing it, or to understand its structure.
    For large files, prefer Grep to locate relevant sections first.`,
      inputSchema: {
        file_path: z.string().describe("Absolute path to the file to read"),
      },
    },
    async ({ file_path }) => {
      try {
        const res = await sendIpcRequest("read_file", { file_path });
        if (res.success) {
          return {
            content: [{ type: "text" as const, text: res.content ?? "" }],
          };
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

  server.registerTool(
    "list_directory",
    {
      description: `List the contents of a directory. Returns each entry on its own line, with a trailing /
  for subdirectories and no suffix for files.`,
      inputSchema: {
        dir_path: z.string().describe("Absolute path to the directory to list"),
      },
    },
    async ({ dir_path }) => {
      try {
        const entries = await fs.promises.readdir(dir_path, {
          withFileTypes: true,
        });
        const lines = entries.map((e) =>
          e.isDirectory() ? `${e.name}/` : e.name,
        );
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
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
    "edit_file",
    {
      description: `Apply text edits to a file. Accepts multiple edits in a single call.
  
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
      inputSchema: {
        file_path: z.string().describe("Absolute path to the file to edit"),
        edits: z
          .array(
            z.object({
              old_string: z
                .string()
                .describe("The exact text to find in the file"),
              new_string: z.string().describe("The replacement text"),
            }),
          )
          .describe("Array of edits to apply atomically"),
      },
    },
    async ({ file_path, edits }) => {
      try {
        const res = await sendIpcRequest("edit_file", { file_path, edits });
        if (res.success) {
          return { content: [{ type: "text" as const, text: res.message }] };
        } else {
          const input = JSON.stringify({ file_path, edits }, null, 2);
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${res.error}\n\nInput:\n${input}`,
              },
            ],
            isError: true,
          };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const input = JSON.stringify({ file_path, edits }, null, 2);
        return {
          content: [
            {
              type: "text" as const,
              text: `IPC error: ${msg}\n\nInput:\n${input}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // @ts-ignore — MCP SDK's deep type instantiation exceeds TS limit
  server.registerTool(
    "write_file",
    {
      description: `Write content to a file. Creates the file (and any missing parent directories) if it
  does not exist, or replaces the entire content of an existing file.
  
  Use this for new or empty files where edit_file cannot work (there is no old_string to match).
  For files that already have content, prefer edit_file instead.`,
      inputSchema: {
        file_path: z.string().describe("Absolute path to the file to write"),
        content: z.string().describe("The full file content to write"),
      },
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
}
