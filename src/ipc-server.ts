import * as net from "net";
import * as fs from "fs";
import * as vscode from "vscode";
import { diffLines } from "diff";

export type EditedRange = { startLine: number; endLine: number };

export type EditListener = (
  filePath: string,
  editCount: number,
  editedRanges: EditedRange[],
) => void;

export interface SuggestionData {
  description: string;
  filePath: string;
  proposedContent: string;
}

export type SuggestionsListener = (suggestions: SuggestionData[]) => void;

export interface IpcServer {
  socketPath: string;
  onEdit: (listener: EditListener) => { dispose: () => void };
  onSuggestions: (listener: SuggestionsListener) => { dispose: () => void };
  dispose: () => void;
}

interface EditRequest {
  id: string;
  type: "edit_file";
  file_path: string;
  edits: Array<{ old_string: string; new_string: string }>;
}

interface WriteRequest {
  id: string;
  type: "write_file";
  file_path: string;
  content: string;
}

interface IpcResponse {
  id: string;
  success: boolean;
  message?: string;
  error?: string;
  editedRanges?: EditedRange[];
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

/**
 * Diff the before/after text line-by-line and return:
 * - editedRanges: all added/modified line ranges in the new text
 * - focusRange: the largest added/modified range (best place to scroll to)
 */
function computeDiffRanges(before: string, after: string): EditedRange[] {
  const changes = diffLines(before, after);
  const editedRanges: EditedRange[] = [];
  let line = 0;

  for (const change of changes) {
    const lineCount = change.count ?? 0;
    if (change.added) {
      editedRanges.push({ startLine: line, endLine: line + lineCount - 1 });
      line += lineCount;
    } else if (change.removed) {
      // Removals don't advance the line counter in the new text
    } else {
      line += lineCount;
    }
  }

  return editedRanges;
}

function handleConnectionData(
  chunk: Buffer,
  buffer: string,
  log: vscode.OutputChannel,
  editListeners: Set<EditListener>,
  suggestionsListeners: Set<SuggestionsListener>,
  conn: net.Socket,
): string {
  buffer += chunk.toString();

  let newlineIdx: number;
  while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);

    if (!line) continue;

    let req: { id: string; type: string; [key: string]: unknown };
    try {
      req = JSON.parse(line);
    } catch {
      log.appendLine(`[ipc] Invalid JSON: ${line.slice(0, 200)}`);
      continue;
    }

    const handleResult =
      (filePath: string, editCount: number) => (res: IpcResponse) => {
        conn.write(JSON.stringify(res) + "\n");
        if (res.success) {
          for (const listener of editListeners) {
            listener(filePath, editCount, res.editedRanges ?? []);
          }
        }
      };

    const handleError = (id: string) => (err: unknown) => {
      const res: IpcResponse = {
        id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
      conn.write(JSON.stringify(res) + "\n");
    };

    if (req.type === "edit_file") {
      const editReq = req as unknown as EditRequest;
      log.append("[ipc-server]: HANDLE EDIT REQUEST");
      handleEditRequest(editReq)
        .then(handleResult(editReq.file_path, editReq.edits.length))
        .catch(handleError(editReq.id));
    } else if (req.type === "write_file") {
      const writeReq = req as unknown as WriteRequest;
      handleWriteRequest(writeReq, log)
        .then(handleResult(writeReq.file_path, 1))
        .catch(handleError(writeReq.id));
    } else if (req.type === "move_file") {
      const moveReq = req as unknown as {
        id: string;
        source: string;
        destination: string;
      };
      handleMoveRequest(moveReq, log)
        .then((res) => conn.write(JSON.stringify(res) + "\n"))
        .catch(handleError(moveReq.id));
    } else if (req.type === "delete_file") {
      const deleteReq = req as unknown as { id: string; file_path: string };
      handleDeleteRequest(deleteReq, log)
        .then((res) => conn.write(JSON.stringify(res) + "\n"))
        .catch(handleError(deleteReq.id));
    } else if (req.type === "update_suggestions") {
      const suggestions = (req as any).suggestions ?? [];
      for (const listener of suggestionsListeners) {
        listener(suggestions);
      }
      conn.write(
        JSON.stringify({
          id: req.id,
          success: true,
          message: `Updated ${suggestions.length} suggestion(s)`,
        }) + "\n",
      );
    } else {
      conn.write(
        JSON.stringify({
          id: req.id,
          success: false,
          error: `Unknown request type: ${(req as any).type}`,
        }) + "\n",
      );
    }
  }

  return buffer;
}

async function handleEditRequest(req: EditRequest): Promise<IpcResponse> {
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

  const before = doc.getText();

  const editsResult = computeTextEdits(before, doc, req.edits);
  if (!editsResult.success) {
    return {
      id: req.id,
      success: false,
      error: `${editsResult.error} in ${req.file_path}`,
    };
  }

  const textEdits = editsResult.textEdits;

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

  const after = doc.getText();
  const editedRanges = computeDiffRanges(before, after);

  return {
    id: req.id,
    success: true,
    message: `Applied ${textEdits.length} edit(s)`,
    editedRanges,
  };
}

async function handleWriteRequest(
  req: WriteRequest,
  log: vscode.OutputChannel,
): Promise<IpcResponse> {
  const uri = vscode.Uri.file(req.file_path);

  const wsEdit = new vscode.WorkspaceEdit();

  let doc: vscode.TextDocument | undefined;
  try {
    doc =
      vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath) ??
      (await vscode.workspace.openTextDocument(uri));
  } catch {
    // File doesn't exist — create it
  }

  const before = doc?.getText() ?? "";

  if (doc) {
    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(before.length),
    );
    wsEdit.replace(uri, fullRange, req.content);
  } else {
    wsEdit.createFile(uri, { overwrite: true });
    wsEdit.insert(uri, new vscode.Position(0, 0), req.content);
  }

  const applied = await vscode.workspace.applyEdit(wsEdit);
  if (!applied) {
    return {
      id: req.id,
      success: false,
      error: "WorkspaceEdit failed to apply",
    };
  }

  const editedRanges = computeDiffRanges(before, req.content);
  const lineCount = req.content.split("\n").length;

  return {
    id: req.id,
    success: true,
    message: `Wrote ${lineCount} lines`,
    editedRanges,
  };
}

async function handleMoveRequest(
  req: { id: string; source: string; destination: string },
  log: vscode.OutputChannel,
): Promise<IpcResponse> {
  const sourceUri = vscode.Uri.file(req.source);
  const destUri = vscode.Uri.file(req.destination);

  const wsEdit = new vscode.WorkspaceEdit();
  wsEdit.renameFile(sourceUri, destUri, { overwrite: false });

  const applied = await vscode.workspace.applyEdit(wsEdit);
  if (!applied) {
    return {
      id: req.id,
      success: false,
      error: `Failed to move ${req.source} to ${req.destination}`,
    };
  }

  log.appendLine(`[ipc] Moved ${req.source} → ${req.destination}`);
  return {
    id: req.id,
    success: true,
    message: `Moved to ${req.destination}`,
  };
}

async function handleDeleteRequest(
  req: { id: string; file_path: string },
  log: vscode.OutputChannel,
): Promise<IpcResponse> {
  const uri = vscode.Uri.file(req.file_path);

  const wsEdit = new vscode.WorkspaceEdit();
  wsEdit.deleteFile(uri, { ignoreIfNotExists: false });

  const applied = await vscode.workspace.applyEdit(wsEdit);
  if (!applied) {
    return {
      id: req.id,
      success: false,
      error: `Failed to delete ${req.file_path}`,
    };
  }

  log.appendLine(`[ipc] Deleted ${req.file_path}`);
  return {
    id: req.id,
    success: true,
    message: `Deleted ${req.file_path}`,
  };
}

export function startIpcServer(log: vscode.OutputChannel): IpcServer {
  const socketPath = `/tmp/codespark-${process.pid}.sock`;
  const editListeners = new Set<EditListener>();
  const suggestionsListeners = new Set<SuggestionsListener>();

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
      buffer = handleConnectionData(chunk, buffer, log, editListeners, suggestionsListeners, conn);
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
    onSuggestions(listener: SuggestionsListener) {
      suggestionsListeners.add(listener);
      return {
        dispose: () => {
          suggestionsListeners.delete(listener);
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
