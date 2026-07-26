/**
 * Token-aware compaction prompt: keep decisions, paths, and next steps;
 * drop exploratory noise. Used from session_before_compact.
 */

export function buildCompactionPrompt(input: {
  conversationText: string;
  previousSummary?: string;
  customInstructions?: string;
}): string {
  const prev = input.previousSummary
    ? `\n\n## Previous summary (merge/update; drop superseded facts)\n${input.previousSummary.slice(0, 6000)}`
    : "";

  const custom = input.customInstructions?.trim()
    ? `\n\n## Extra instructions from user\n${input.customInstructions.trim()}`
    : "";

  return `You compress a coding-agent session for continuation. Be dense and factual.

Output structured markdown with EXACTLY these sections (omit a section only if empty):

## Goal
One paragraph: what the user wants.

## Decisions
Bullet list of settled choices (architecture, APIs, constraints).

## Files
Bullet list of important paths touched or discussed, with one-line why each matters.

## State
What works now, what's broken, branch/test status if known.

## Open
Unresolved questions and blockers.

## Next
Ordered next steps for the agent (imperative).

Rules:
- Prefer paths and symbols over prose.
- Do NOT restate large code blocks; reference path:line if needed.
- Drop failed dead-ends unless they warn against a bad approach.
- Max ~800 words. Density over narrative.
${prev}${custom}

## Conversation
${input.conversationText.slice(0, 120_000)}
`;
}
