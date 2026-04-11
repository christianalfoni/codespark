import * as net from "net";
import * as fs from "fs";
import * as vscode from "vscode";

export type EditListener = (filePath: string, editCount: number) => void;

export interface IpcServer {
  socketPath: string;
  onEdit: (listener: EditListener) => { dispose: () => void };
  dispose: () => void;
}

interface EditRequest {
  id: string;
  type: "edit_file";
  file_path: string;
  edits: Array<{ old_string: string; new_string: string }>;
}

interface EditResponse {
  id: string;
  success: boolean;
  message?: string;
  error?: string;
}

async function handleEditRequest(
  req: EditRequest,
  log: vscode.OutputChannel,
): Promise<EditResponse> {
  const uri = vscode.Uri.file(req.file_path);

  let doc: vscode.TextDocument;
  try {
    doc =
      vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === uri.fsPath,
      ) ?? (await vscode.workspace.openTextDocument(uri));
  } catch {
    return { id: req.id, success: false, error: `Could not open file: ${req.file_path}` };
  }

  const text = doc.getText();

  // Phase 1: validate all edits and compute ranges against the original text
  const textEdits: vscode.TextEdit[] = [];

  for (const edit of req.edits) {
    const idx = text.indexOf(edit.old_string);
    if (idx === -1) {
      return {
        id: req.id,
        success: false,
        error: `old_string not found in ${req.file_path}: "${edit.old_string.slice(0, 80)}"`,
      };
    }

    // Check for ambiguity — old_string appears more than once
    if (text.indexOf(edit.old_string, idx + 1) !== -1) {
      return {
        id: req.id,
        success: false,
        error: `old_string is ambiguous (appears multiple times) in ${req.file_path}: "${edit.old_string.slice(0, 80)}"`,
      };
    }

    const startPos = doc.positionAt(idx);
    const endPos = doc.positionAt(idx + edit.old_string.length);
    textEdits.push(vscode.TextEdit.replace(new vscode.Range(startPos, endPos), edit.new_string));
  }

  // Phase 2: apply all edits atomically
  const wsEdit = new vscode.WorkspaceEdit();
  wsEdit.set(uri, textEdits);

  const applied = await vscode.workspace.applyEdit(wsEdit);
  if (!applied) {
    return { id: req.id, success: false, error: "WorkspaceEdit failed to apply" };
  }

  log.appendLine(`[ipc] Applied ${textEdits.length} edit(s) to ${req.file_path}`);
  return { id: req.id, success: true, message: `Applied ${textEdits.length} edit(s)` };
}

export function startIpcServer(log: vscode.OutputChannel): IpcServer {
  const socketPath = `/tmp/codespark-${process.pid}.sock`;
  const editListeners = new Set<EditListener>();

  // Clean up stale socket from prior crash
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // ignore — file didn't exist
  }

  const server = net.createServer((conn) => {
    log.appendLine("[ipc] Client connected");

    let buffer = "";

    conn.on("data", (chunk) => {
      buffer += chunk.toString();

      // Process complete JSON lines
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        let req: EditRequest;
        try {
          req = JSON.parse(line);
        } catch {
          log.appendLine(`[ipc] Invalid JSON: ${line.slice(0, 200)}`);
          continue;
        }

        if (req.type === "edit_file") {
          handleEditRequest(req, log)
            .then((res) => {
              conn.write(JSON.stringify(res) + "\n");
              if (res.success) {
                for (const listener of editListeners) {
                  listener(req.file_path, req.edits.length);
                }
              }
            })
            .catch((err) => {
              const res: EditResponse = {
                id: req.id,
                success: false,
                error: err instanceof Error ? err.message : String(err),
              };
              conn.write(JSON.stringify(res) + "\n");
            });
        } else {
          conn.write(
            JSON.stringify({ id: req.id, success: false, error: `Unknown request type: ${req.type}` }) + "\n",
          );
        }
      }
    });

    conn.on("error", (err) => {
      log.appendLine(`[ipc] Connection error: ${err.message}`);
    });
  });

  server.listen(socketPath, () => {
    log.appendLine(`[ipc] Server listening on ${socketPath}`);
  });

  server.on("error", (err) => {
    log.appendLine(`[ipc] Server error: ${err.message}`);
  });

  return {
    socketPath,
    onEdit(listener: EditListener) {
      editListeners.add(listener);
      return { dispose: () => { editListeners.delete(listener); } };
    },
    dispose() {
      server.close();
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // ignore
      }
    },
  };
}
