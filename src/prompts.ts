import { ResolvedContext } from "./types";
import { getResearchSummary } from "./research-agent";

export const SYSTEM_PROMPT = "";
export const SYSTEM_PROMPT_CLAUDE_MD = "";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildSystemPrompt(
  ctx: Pick<ResolvedContext, "isInstructionFile" | "instructionContent">,
): string {
  if (ctx.isInstructionFile) {
    return SYSTEM_PROMPT_CLAUDE_MD;
  }

  let prompt = SYSTEM_PROMPT;

  if (ctx.instructionContent) {
    prompt += `\n\n# CLAUDE.md\n\n${ctx.instructionContent}`;
  }

  const summary = getResearchSummary();
  if (summary) {
    prompt += `\n\n# Research Summary\n\n${summary}`;
  }

  return prompt;
}
