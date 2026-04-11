import * as net from "net";
import * as fs from "fs";
import * as vscode from "vscode";

export type EditListener = (
  filePath: string,
  editCount: number,
  focusRange?: {
    startLine: number;
    startChar: number;
    endLine: number;
    endChar: number;
  },
) => void;

export interface IpcServer {
  socketPath: string;
  onEdit: (listener: EditListener) => { dispose: () => void };
  dispose: () => void;
}

interface EditRequest {
  id: string;
  type: "edit_file";
  file_path: string;
  edits: Array<{ old_string: string; new_string: string; focus?: boolean }>;
}

interface EditResponse {
  id: string;
  success: boolean;
  message?: string;
  error?: string;
  focusRange?: {
    startLine: number;
    startChar: number;
    endLine: number;
    endChar: number;
  };
}

function computeTextEdits(
  text: string,
  doc: vscode.TextDocument,
  edits: Array<{ old_string: string; new_string: string }>,
):
  | { success: true; textEdits: vscode.TextEdit[] }
  | { success: false; error: string } {
  const textEdits: vscode.TextEdit[] = [];

  for (const edit of edits) {
    const idx = text.indexOf(edit.old_string);
    if (idx === -1) {
      return {
        success: false,
        error: `old_string not found: "${edit.old_string.slice(0, 80)}"`,
      };
    }

    if (text.indexOf(edit.old_string, idx + 1) !== -1) {
      return {
        success: false,
        error: `old_string is ambiguous (appears multiple times): "${edit.old_string.slice(0, 80)}"`,
      };
    }

    const startPos = doc.positionAt(idx);
    const endPos = doc.positionAt(idx + edit.old_string.length);
    textEdits.push(
      vscode.TextEdit.replace(
        new vscode.Range(startPos, endPos),
        edit.new_string,
      ),
    );
  }

  return { success: true, textEdits };
}

function calculateFocusRange(
  originalText: string,
  doc: vscode.TextDocument,
  edits: Array<{ old_string: string; new_string: string; focus?: boolean }>,
): EditResponse["focusRange"] | undefined {
  const focusIdx = edits.findIndex((e) => e.focus);
  if (focusIdx === -1) {
    return undefined;
  }

  // Find each edit's position in the original text
  const editOffsets = edits.map((e) => ({
    originalIdx: originalText.indexOf(e.old_string),
    oldLen: e.old_string.length,
    newLen: e.new_string.length,
  }));

  const focusOriginalIdx = editOffsets[focusIdx].originalIdx;
  if (focusOriginalIdx === -1) {
    return undefined;
  }

  // Sum the length changes from edits that appear *before* the focused one
  let shift = 0;
  for (let i = 0; i < edits.length; i++) {
    if (i === focusIdx) continue;
    if (editOffsets[i].originalIdx < focusOriginalIdx) {
      shift += editOffsets[i].newLen - editOffsets[i].oldLen;
    }
  }

  const newStartOffset = focusOriginalIdx + shift;
  const newEndOffset = newStartOffset + edits[focusIdx].new_string.length;

  // doc is live after applyEdit — positionAt works on the updated content
  const startPos = doc.positionAt(newStartOffset);
  const endPos = doc.positionAt(newEndOffset);

  return {
    startLine: startPos.line,
    startChar: startPos.character,
    endLine: endPos.line,
    endChar: endPos.character,
  };
}

function handleConnectionData(
  chunk: Buffer,
  buffer: string,
  log: vscode.OutputChannel,
  editListeners: Set<EditListener>,
  conn: net.Socket,
): string {
  buffer += chunk.toString();

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
              listener(req.file_path, req.edits.length, res.focusRange);
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
        JSON.stringify({
          id: req.id,
          success: false,
          error: `Unknown request type: ${req.type}`,
        }) + "\n",
      );
    }
  }

  return buffer;
}

async function handleEditRequest(
  req: EditRequest,
  log: vscode.OutputChannel,
): Promise<EditResponse> {
  const uri = vscode.Uri.file(req.file_path);

  let doc: vscode.TextDocument;
  try {
    doc =
      vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath) ??
      (await vscode.workspace.openTextDocument(uri));
  } catch {
    return {
      id: req.id,
      success: false,
      error: `Could not open file: ${req.file_path}`,
    };
  }

  const text = doc.getText();

  const editsResult = computeTextEdits(text, doc, req.edits);
  if (!editsResult.success) {
    return {
      id: req.id,
      success: false,
      error: `${editsResult.error} in ${req.file_path}`,
    };
  }

  const textEdits = editsResult.textEdits;

  // Phase 2: apply all edits atomically
  const wsEdit = new vscode.WorkspaceEdit();
  wsEdit.set(uri, textEdits);

  const applied = await vscode.workspace.applyEdit(wsEdit);
  if (!applied) {
    return {
      id: req.id,
      success: false,
      error: "WorkspaceEdit failed to apply",
    };
  }

  log.appendLine(
    `[ipc] Applied ${textEdits.length} edit(s) to ${req.file_path}: ${JSON.stringify(req.edits)}`,
  );
  return {
    id: req.id,
    success: true,
    message: `Applied ${textEdits.length} edit(s)`,
    focusRange: calculateFocusRange(text, doc, req.edits),
  };
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
      buffer = handleConnectionData(chunk, buffer, log, editListeners, conn);
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
      return {
        dispose: () => {
          editListeners.delete(listener);
        },
      };
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
