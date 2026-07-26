/**
 * Compress noisy tool output so bash/tests don't flood the context window.
 */

export type CompressOptions = {
  maxChars?: number;
  headLines?: number;
  tailLines?: number;
};

export function compressText(
  text: string,
  options: CompressOptions = {},
): { text: string; compressed: boolean } {
  const maxChars = options.maxChars ?? 12_000;
  const headLines = options.headLines ?? 80;
  const tailLines = options.tailLines ?? 40;

  if (text.length <= maxChars) {
    return { text, compressed: false };
  }

  const lines = text.split("\n");
  if (lines.length <= headLines + tailLines + 5) {
    // character-based truncate
    const head = text.slice(0, Math.floor(maxChars * 0.7));
    const tail = text.slice(-Math.floor(maxChars * 0.25));
    return {
      text: `${head}\n\n… [compressed ${text.length - head.length - tail.length} chars] …\n\n${tail}`,
      compressed: true,
    };
  }

  const head = lines.slice(0, headLines).join("\n");
  const tail = lines.slice(-tailLines).join("\n");
  const omitted = lines.length - headLines - tailLines;
  return {
    text: `${head}\n\n… [${omitted} lines omitted for token efficiency] …\n\n${tail}`,
    compressed: true,
  };
}

/** Prefer error-focused view when exit code non-zero and output is large. */
export function compressCommandOutput(
  stdout: string,
  stderr: string,
  exitCode: number | null | undefined,
): { text: string; compressed: boolean } {
  const combined =
    exitCode && exitCode !== 0
      ? [
          stderr.trim() && `--- stderr ---\n${stderr}`,
          stdout.trim() && `--- stdout ---\n${stdout}`,
          `exit=${exitCode}`,
        ]
          .filter(Boolean)
          .join("\n\n")
      : [stdout, stderr].filter(Boolean).join("\n");

  return compressText(combined || "(no output)");
}
