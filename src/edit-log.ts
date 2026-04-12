import * as vscode from "vscode";
import { diffLines } from "diff";

export interface EditLogEntry {
  timestamp: number;
  filePath: string;
  instruction: string;
  diff: string;
}

const STORE_KEY = "codeSpark.editLog";
let _workspaceState: vscode.Memento | undefined;
let _entries: EditLogEntry[] = [];
let _onChange: (() => void) | undefined;

export function initEditLog(
  workspaceState: vscode.Memento,
  onChange?: () => void,
): void {
  _workspaceState = workspaceState;
  _entries = workspaceState.get<EditLogEntry[]>(STORE_KEY) ?? [];
  _onChange = onChange;
}

function persist(): void {
  _workspaceState?.update(STORE_KEY, _entries);
  _onChange?.();
}

export function computeCompactDiff(before: string, after: string): string {
  const changes = diffLines(before, after);
  const lines: string[] = [];

  for (const change of changes) {
    const text = (change.value ?? "").trimEnd();
    if (change.added) {
      for (const l of text.split("\n")) {
        lines.push(`+ ${l}`);
      }
    } else if (change.removed) {
      for (const l of text.split("\n")) {
        lines.push(`- ${l}`);
      }
    }
  }

  return lines.join("\n");
}

export function appendEditLog(entry: EditLogEntry): void {
  _entries.push(entry);
  persist();
}

export function getEditLog(): EditLogEntry[] {
  return _entries;
}

export function getEditLogCount(): number {
  return _entries.length;
}

export function clearEditLog(): void {
  _entries = [];
  persist();
}
