import * as childProcess from "child_process";
import * as readline from "readline";
import * as vscode from "vscode";

export interface ClaudeProcess {
  proc: childProcess.ChildProcess;
  rl: readline.Interface;
}

export interface SpawnClaudeOptions {
  cwd: string;
  args: string[]; // tool-specific args (--tools, --model, --resume, etc.)
  systemPrompt: string;
  mcpConfigPath?: string;
  env?: NodeJS.ProcessEnv;
  log: vscode.OutputChannel;
  logPrefix: string; // e.g. "cli-inline" or "claude-code-assistant"
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export function spawnClaude(opts: SpawnClaudeOptions): ClaudeProcess {
  const baseArgs = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
    "--strict-mcp-config",
    ...(opts.mcpConfigPath ? ["--mcp-config", opts.mcpConfigPath] : []),
    "--system-prompt",
    opts.systemPrompt,
    ...opts.args,
  ];

  const proc = childProcess.spawn("claude", baseArgs, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.on("error", (err) =>
    opts.log.appendLine(`[${opts.logPrefix}] Process error: ${err.message}`),
  );
  proc.stderr?.on("data", (chunk: Buffer) =>
    opts.log.appendLine(
      `[${opts.logPrefix}:stderr] ${chunk.toString().trim()}`,
    ),
  );
  proc.on("exit", (code, signal) => {
    opts.log.appendLine(
      `[${opts.logPrefix}] Process exited (code=${code}, signal=${signal}, pid=${proc.pid})`,
    );
    opts.onExit?.(code, signal);
  });

  const rl = readline.createInterface({ input: proc.stdout! });

  return { proc, rl };
}
