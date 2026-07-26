/**
 * Lightweight structural summaries for large source files.
 * Prefer outlines over full dumps to save input tokens.
 */

export type SummaryOptions = {
  maxOutlineLines?: number;
  maxPreviewLines?: number;
};

const STRUCTURAL =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*|function|class|interface|type|enum|const|let|var|def |fn |pub\s+(?:async\s+)?fn|impl |struct |trait |module |namespace |public\s+|private\s+|protected\s+|@\w+|describe\(|it\(|test\()/;

export function isProbablyBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  let nul = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) nul++;
  }
  return nul > 0;
}

export function shouldSummarize(
  lineCount: number,
  byteLength: number,
  forceFull: boolean | undefined,
): boolean {
  if (forceFull) return false;
  return lineCount > 200 || byteLength > 40_000;
}

/**
 * Build a structural outline + head/tail previews for large files.
 * Small enough to keep tool results lean; model can re-read ranges with hashline.
 */
export function summarizeSource(
  path: string,
  content: string,
  options: SummaryOptions = {},
): string {
  const maxOutline = options.maxOutlineLines ?? 80;
  const maxPreview = options.maxPreviewLines ?? 30;
  const lines = content.length === 0 ? [] : content.split("\n");
  const hits: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (STRUCTURAL.test(line)) {
      const trimmed = line.length > 120 ? `${line.slice(0, 117)}...` : line;
      hits.push(`${String(i + 1).padStart(5)}| ${trimmed}`);
      if (hits.length >= maxOutline) break;
    }
  }

  const head = lines
    .slice(0, maxPreview)
    .map((l, i) => `${String(i + 1).padStart(5)}| ${l}`)
    .join("\n");

  const tailStart = Math.max(maxPreview, lines.length - maxPreview);
  const tail =
    lines.length > maxPreview * 2
      ? lines
          .slice(tailStart)
          .map((l, i) => `${String(tailStart + i + 1).padStart(5)}| ${l}`)
          .join("\n")
      : "";

  const parts = [
    `${path} — SUMMARY (${lines.length} lines, ${Buffer.byteLength(content, "utf8")} bytes)`,
    `Token-efficient outline. For precise edits, re-read with full=true or offset/limit to get hashline anchors.`,
    "",
    "## Structural hits",
    hits.length ? hits.join("\n") : "(no structural patterns matched; use offset/limit hashline read)",
    "",
    `## Head (lines 1–${Math.min(maxPreview, lines.length)})`,
    head || "(empty)",
  ];

  if (tail) {
    parts.push("", `## Tail (lines ${tailStart + 1}–${lines.length})`, tail);
  }

  parts.push(
    "",
    "Next: call read with full=true for hashline, or offset/limit for a window.",
  );
  return parts.join("\n");
}
