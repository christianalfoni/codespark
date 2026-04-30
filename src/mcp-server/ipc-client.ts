import * as net from "net";

const SOCKET_PATH = process.env.CODESPARK_SOCKET;
if (!SOCKET_PATH) {
  process.stderr.write("CODESPARK_SOCKET env var not set\n");
  process.exit(1);
}

let ipcSocket: net.Socket | null = null;
let requestId = 0;
const pending = new Map<
  string,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();

export function connectIpc(): Promise<void> {
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

export function sendIpcRequest(
  type: string,
  payload: Record<string, unknown>,
): Promise<any> {
  if (!ipcSocket) {
    return Promise.reject(new Error("IPC socket not connected"));
  }
  const id = `req_${++requestId}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ipcSocket!.write(JSON.stringify({ id, type, ...payload }) + "\n");
  });
}

export async function connectIpcWithRetry(
  maxRetries = 5,
  delayMs = 200,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await connectIpc();
      return;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      process.stderr.write(
        `IPC connect attempt ${attempt}/${maxRetries} failed, retrying in ${delayMs}ms...\n`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
