import * as net from "net";
import * as fs from "fs";
import * as vscode from "vscode";
import { diffLines } from "diff";

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
  /** When set, edit_file is restricted to this exact file path. */
  allowedEditFile: string | null;
  onEdit: (listener: EditListener) => { dispose: () => void };
  onBeforeEdit: (listener: BeforeEditListener) => { dispose: () => void };
  onBreakdown: (listener: BreakdownListener) => { dispose: () => void };
  dispose: () => void;
}

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

interface ReadRequest {
  id: string;
  type: "read_file";
  file_path: string;
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
  content?: string;
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
  let allowedEditFile: string | null = null;

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
        () => allowedEditFile,
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
    get allowedEditFile() {
      return allowedEditFile;
    },
    set allowedEditFile(value: string | null) {
      allowedEditFile = value;
    },
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
  getAllowedEditFile: () => string | null,
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

    if (req.type === "read_file") {
      const readReq = req as unknown as ReadRequest;
      log.appendLine(`[ipc] read_file: ${readReq.file_path}`);
      handleReadRequest(readReq)
        .then((res) => conn.write(JSON.stringify(res) + "\n"))
        .catch(handleError(readReq.id));
    } else if (req.type === "edit_file") {
      const editReq = req as unknown as EditRequest;
      const allowed = getAllowedEditFile();
      if (allowed && editReq.file_path !== allowed) {
        conn.write(
          JSON.stringify({
            id: editReq.id,
            success: false,
            error: `Editing restricted to the current file. Cannot edit ${editReq.file_path}`,
          }) + "\n",
        );
      } else {
        log.appendLine(
          `[ipc] edit_file: ${editReq.edits.length} edit(s) on ${editReq.file_path}`,
        );
        runBeforeEditListeners(beforeEditListeners, editReq.file_path)
          .then(() => handleEditRequest(editReq))
          .then(handleResult(editReq.file_path, editReq.edits.length))
          .catch(handleError(editReq.id));
      }
    } else if (req.type === "write_file") {
      const writeReq = req as unknown as WriteRequest;
      const allowed = getAllowedEditFile();
      if (allowed && writeReq.file_path !== allowed) {
        conn.write(
          JSON.stringify({
            id: writeReq.id,
            success: false,
            error: `Editing restricted to the current file. Cannot write ${writeReq.file_path}`,
          }) + "\n",
        );
      } else {
        log.appendLine(`[ipc] write_file: ${writeReq.file_path}`);
        runBeforeEditListeners(beforeEditListeners, writeReq.file_path)
          .then(() => handleWriteRequest(writeReq))
          .then(handleResult(writeReq.file_path, 1))
          .catch(handleError(writeReq.id));
      }
    } else if (req.type === "write_breakdown") {
      const steps = (req as any).items as BreakdownStepInput[];
      log.appendLine(`[ipc] write_breakdown: ${steps.length} step(s)`);
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

async function handleReadRequest(req: ReadRequest): Promise<IpcResponse> {
  const uri = vscode.Uri.file(req.file_path);
  try {
    const doc =
      vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath) ??
      (await vscode.workspace.openTextDocument(uri));
    return { id: req.id, success: true, content: doc.getText() };
  } catch {
    return { id: req.id, success: false, error: `Could not read file: ${req.file_path}` };
  }
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

async function handleWriteRequest(req: WriteRequest): Promise<IpcResponse> {
  const uri = vscode.Uri.file(req.file_path);

  // Create parent directories + file via VS Code workspace API
  const wsEdit = new vscode.WorkspaceEdit();
  wsEdit.createFile(uri, { ignoreIfExists: true });
  await vscode.workspace.applyEdit(wsEdit);

  const doc = await vscode.workspace.openTextDocument(uri);
  const before = doc.getText();

  // Replace entire content
  const fullRange = new vscode.Range(
    doc.positionAt(0),
    doc.positionAt(before.length),
  );
  const replaceEdit = new vscode.WorkspaceEdit();
  replaceEdit.replace(uri, fullRange, req.content);

  const applied = await vscode.workspace.applyEdit(replaceEdit);
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
    message: `Wrote ${req.file_path}`,
    editedRanges,
  };
}

