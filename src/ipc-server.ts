import * as net from "net";
import * as fs from "fs";
import * as vscode from "vscode";
import { diffLines } from "diff";
import { hasRead } from "./readTracker";

// ---------------------------------------------------------------------------
// Exported Types
// ---------------------------------------------------------------------------

export type EditedRange = { startLine: number; endLine: number };

export type EditListener = (
  filePath: string,
  editCount: number,
  editedRanges: EditedRange[],
) => void;

export type BeforeEditListener = (filePath: string) => Promise<void>;

export interface BreakdownStepInput {
  title: string;
  description: string;
  filePath: string;
  lineHint?: number;
}

export type BreakdownListener = (steps: BreakdownStepInput[]) => void;

export interface IpcServer {
  socketPath: string;
  ready: Promise<void>;
  onEdit: (listener: EditListener) => { dispose: () => void };
  onBeforeEdit: (listener: BeforeEditListener) => { dispose: () => void };
  onBreakdown: (listener: BreakdownListener) => { dispose: () => void };
  dispose: () => void;
}

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Exported Functions
// ---------------------------------------------------------------------------

export function startIpcServer(log: vscode.OutputChannel): IpcServer {
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\codespark-${process.pid}`
      : `/tmp/codespark-${process.pid}.sock`;
  const editListeners = new Set<EditListener>();
  const beforeEditListeners = new Set<BeforeEditListener>();
  const breakdownListeners = new Set<BreakdownListener>();

  // Clean up stale socket from prior crash
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // ignore — file didn't exist
  }

  let readyResolve: () => void;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  const server = net.createServer((conn) => {
    log.appendLine("[ipc] Client connected");

    let buffer = "";

    conn.on("data", (chunk) => {
      buffer = handleConnectionData(
        chunk,
        buffer,
        log,
        editListeners,
        beforeEditListeners,
        breakdownListeners,
        conn,
      );
    });

    conn.on("error", (err) => {
      log.appendLine(`[ipc] Connection error: ${err.message}`);
    });
  });

  server.listen(socketPath, () => {
    log.appendLine(`[ipc] Server listening on ${socketPath}`);
    readyResolve();
  });

  server.on("error", (err) => {
    log.appendLine(`[ipc] Server error: ${err.message}`);
  });

  return {
    socketPath,
    ready,
    onEdit(listener: EditListener) {
      editListeners.add(listener);
      return {
        dispose: () => {
          editListeners.delete(listener);
        },
      };
    },
    onBeforeEdit(listener: BeforeEditListener) {
      beforeEditListeners.add(listener);
      return {
        dispose: () => {
          beforeEditListeners.delete(listener);
        },
      };
    },
    onBreakdown(listener: BreakdownListener) {
      breakdownListeners.add(listener);
      return {
        dispose: () => {
          breakdownListeners.delete(listener);
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function runBeforeEditListeners(
  listeners: Set<BeforeEditListener>,
  filePath: string,
): Promise<void> {
  await Promise.all(Array.from(listeners).map((l) => l(filePath)));
}

function handleConnectionData(
  chunk: Buffer,
  buffer: string,
  log: vscode.OutputChannel,
  editListeners: Set<EditListener>,
  beforeEditListeners: Set<BeforeEditListener>,
  breakdownListeners: Set<BreakdownListener>,
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
      log.appendLine(
        `[ipc] edit_file: ${editReq.edits.length} edit(s) on ${editReq.file_path}`,
      );
      runBeforeEditListeners(beforeEditListeners, editReq.file_path)
        .then(() => handleEditRequest(editReq))
        .then(handleResult(editReq.file_path, editReq.edits.length))
        .catch(handleError(editReq.id));
    } else if (req.type === "write_file") {
      const writeReq = req as unknown as WriteRequest;
      runBeforeEditListeners(beforeEditListeners, writeReq.file_path)
        .then(() => handleWriteRequest(writeReq, log))
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
    } else if (req.type === "update_breakdown") {
      const steps = (req as any).items as BreakdownStepInput[];
      log.appendLine(`[ipc] update_breakdown: ${steps.length} step(s)`);
      for (const listener of breakdownListeners) {
        listener(steps);
      }
      const res = { id: req.id, success: true, message: `Created ${steps.length} step(s)` };
      conn.write(JSON.stringify(res) + "\n");
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

  // Mirror the native Write tool's contract: overwriting an existing file
  // requires a prior Read in this session.
  if (fs.existsSync(req.file_path) && !hasRead(req.file_path)) {
    return {
      id: req.id,
      success: false,
      error: `File exists but has not been read in this session. Use the Read tool to read ${req.file_path} before calling write_file, or use edit_file for partial edits.`,
    };
  }

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
