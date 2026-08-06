/**
 * Advisor: a second-pass reviewer that watches agent turns and injects notes.
 * Uses the active session model by default (or ADVISOR_MODEL=provider/id).
 */

export type AdvisorSeverity = "aside" | "concern" | "blocker";

export type AdvisorNote = {
  severity: AdvisorSeverity;
  text: string;
};

export type AdvisorConfig = {
  enabled: boolean;
  /** Max notes per turn */
  maxNotes: number;
  /** Skip if last assistant text shorter than this */
  minAssistantChars: number;
  /** Only run every Nth turn (1 = every turn) */
  everyNTurns: number;
};

export const defaultAdvisorConfig = (): AdvisorConfig => ({
  enabled: false,
  maxNotes: 3,
  minAssistantChars: 80,
  everyNTurns: 1,
});

export function buildAdvisorPrompt(input: {
  userGoal: string;
  assistantText: string;
  toolSummary: string;
}): string {
  return [
    "You are a silent advisor reviewing a coding agent's last turn.",
    "Find mistakes, missed acceptance criteria, unsafe changes, or better approaches.",
    "Respond with STRICT JSON only, no markdown fences:",
    `{"notes":[{"severity":"aside|concern|blocker","text":"..."}]}`,
    "Rules:",
    "- Prefer zero notes if the turn looks fine.",
    "- At most 3 notes. Each text ≤ 240 chars.",
    "- severity blocker = must fix before continuing; concern = likely issue; aside = optional tip.",
    "- Do not rewrite code. Do not praise. Be specific.",
    "",
    "## Recent user goal / prompt",
    input.userGoal.slice(0, 2000),
    "",
    "## Assistant output (truncated)",
    input.assistantText.slice(0, 6000),
    "",
    "## Tools used this turn",
    input.toolSummary.slice(0, 3000) || "(none)",
  ].join("\n");
}

export function parseAdvisorResponse(raw: string): AdvisorNote[] {
  const trimmed = raw.trim();
  // strip accidental fences
  const body = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(body) as { notes?: unknown };
    if (!Array.isArray(parsed.notes)) return [];
    const notes: AdvisorNote[] = [];
    for (const n of parsed.notes) {
      if (!n || typeof n !== "object") continue;
      const severity = (n as { severity?: string }).severity;
      const text = (n as { text?: string }).text;
      if (
        (severity === "aside" ||
          severity === "concern" ||
          severity === "blocker") &&
        typeof text === "string" &&
        text.trim()
      ) {
        notes.push({ severity, text: text.trim().slice(0, 400) });
      }
      if (notes.length >= 3) break;
    }
    return notes;
  } catch {
    return [];
  }
}

export function formatAdvisorInjection(notes: AdvisorNote[]): string {
  const lines = [
    "[Advisor notes — address before claiming done; ignore only with a stated reason]",
  ];
  for (const n of notes) {
    lines.push(`- (${n.severity}) ${n.text}`);
  }
  return lines.join("\n");
}

export function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: string }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

export function extractToolSummary(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const lines: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "toolCall"
    ) {
      const name = (block as { name?: string }).name ?? "?";
      const args = (block as { arguments?: unknown }).arguments;
      let argPreview = "";
      try {
        argPreview = JSON.stringify(args ?? {}).slice(0, 180);
      } catch {
        argPreview = "";
      }
      lines.push(`${name}(${argPreview})`);
    }
  }
  return lines.join("\n");
}
