/**
 * Clean-room hashline: content-hash anchors for precise, low-token edits.
 *
 * Each line is tagged with a 3-char base64url hash of its exact content.
 * Edits reference hashes instead of retyping old text, so whitespace battles
 * and "string not found" retry loops go away. Stale anchors are rejected.
 */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** FNV-1a 32-bit folded to 18 bits, encoded as 3 base64url chars. */
export function lineHash(line: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < line.length; i++) {
    h ^= line.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const n = (h >>> 0) & 0x3ffff; // 18 bits
  return ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
}

export type Anchor = {
  /** 1-indexed line number */
  line: number;
  hash: string;
};

/** Parse "12:a3f", "a3f", or "12" into parts. Prefer line+hash. */
export function parseAnchor(raw: string): Partial<Anchor> & { raw: string } {
  const s = raw.trim();
  const m = /^(\d+):([A-Za-z0-9_-]{3})$/.exec(s);
  if (m) return { line: Number(m[1]), hash: m[2], raw: s };
  if (/^[A-Za-z0-9_-]{3}$/.test(s)) return { hash: s, raw: s };
  if (/^\d+$/.test(s)) return { line: Number(s), raw: s };
  return { raw: s };
}

export function formatAnchor(line: number, content: string): string {
  return `${line}:${lineHash(content)}`;
}

export type HashlineFile = {
  path: string;
  lines: string[];
  /** line number (1-based) -> hash */
  hashes: string[];
};

export function buildHashline(path: string, content: string): HashlineFile {
  // Preserve final newline semantics: split keeps trailing empty only if file ends with \n
  // and content was empty → one empty line.
  const lines = content.length === 0 ? [] : content.split("\n");
  // If file ends with newline, split yields trailing ""; keep it as a line for fidelity
  // when the original had a trailing newline after last non-empty line. Standard split is fine.
  const hashes = lines.map(lineHash);
  return { path, lines, hashes };
}

export function renderHashline(
  file: HashlineFile,
  options: {
    offset?: number; // 1-indexed start
    limit?: number;
    maxBytes?: number;
    header?: boolean;
  } = {},
): string {
  const { offset = 1, limit, maxBytes = 80 * 1024, header = true } = options;
  const start = Math.max(0, offset - 1);
  const end =
    limit != null
      ? Math.min(file.lines.length, start + limit)
      : file.lines.length;

  const out: string[] = [];
  if (header) {
    out.push(
      `${file.path} (${file.lines.length} lines, hashline) [edit with start/end anchors like 12:a3f]`,
    );
  }

  let bytes = 0;
  for (let i = start; i < end; i++) {
    const lineNo = i + 1;
    const row = `${String(lineNo).padStart(5)}:${file.hashes[i]}|${file.lines[i]}`;
    bytes += Buffer.byteLength(row, "utf8") + 1;
    if (bytes > maxBytes) {
      out.push(
        `\n[truncated: showed lines ${start + 1}-${i} of ${file.lines.length}; re-read with offset/limit]`,
      );
      break;
    }
    out.push(row);
  }

  if (
    end < file.lines.length &&
    (limit == null || start + (limit ?? 0) >= end)
  ) {
    // if we finished the requested window but more file remains
    if (limit != null && start + limit < file.lines.length) {
      out.push(
        `\n… ${file.lines.length - end} more lines (use offset=${end + 1} to continue)`,
      );
    }
  }

  return out.join("\n");
}

export type EditOp =
  | {
      op: "replace";
      /** Inclusive start anchor */
      start: string;
      /** Inclusive end anchor; defaults to start */
      end?: string;
      text: string;
    }
  | {
      op: "insert_after";
      start: string;
      text: string;
    }
  | {
      op: "delete";
      start: string;
      end?: string;
    };

export type EditResult =
  | {
      ok: true;
      content: string;
      opsApplied: number;
      linesBefore: number;
      linesAfter: number;
    }
  | { ok: false; error: string };

function resolveLine(
  file: HashlineFile,
  anchorRaw: string,
): { line: number } | { error: string } {
  const a = parseAnchor(anchorRaw);
  if (a.line != null && a.hash != null) {
    const idx = a.line - 1;
    if (idx < 0 || idx >= file.lines.length) {
      return {
        error: `Anchor ${anchorRaw}: line ${a.line} out of range (file has ${file.lines.length} lines)`,
      };
    }
    if (file.hashes[idx] !== a.hash) {
      return {
        error: `Stale anchor ${anchorRaw}: expected hash ${a.hash}, file has ${file.hashes[idx]} at line ${a.line}. Re-read the file.`,
      };
    }
    return { line: a.line };
  }
  if (a.hash != null && a.line == null) {
    const matches: number[] = [];
    for (let i = 0; i < file.hashes.length; i++) {
      if (file.hashes[i] === a.hash) matches.push(i + 1);
    }
    if (matches.length === 0) {
      return { error: `Hash ${a.hash} not found. Re-read the file.` };
    }
    if (matches.length > 1) {
      return {
        error: `Hash ${a.hash} is ambiguous (lines ${matches.join(", ")}). Use line:hash form.`,
      };
    }
    return { line: matches[0]! };
  }
  if (a.line != null) {
    // Line-only is rejected for safety — forces hash anchors
    return {
      error: `Anchor ${anchorRaw}: line number alone is not allowed. Use line:hash from a hashline read (e.g. ${a.line}:${file.hashes[a.line - 1] ?? "???"}).`,
    };
  }
  return { error: `Invalid anchor: ${anchorRaw}` };
}

/**
 * Apply ops in order. Each op resolves anchors against the file state at that moment.
 * After each op, hashes are recomputed so subsequent ops can use new anchors if needed —
 * but models should re-read after multi-step structural changes.
 */
export function applyHashlineEdits(content: string, ops: EditOp[]): EditResult {
  if (!ops.length) return { ok: false, error: "No ops provided" };

  let file = buildHashline("<buffer>", content);
  const linesBefore = file.lines.length;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const tag = `op[${i}] ${op.op}`;

    if (op.op === "replace") {
      const s = resolveLine(file, op.start);
      if ("error" in s) return { ok: false, error: `${tag}: ${s.error}` };
      const e = resolveLine(file, op.end ?? op.start);
      if ("error" in e) return { ok: false, error: `${tag}: ${e.error}` };
      if (e.line < s.line) {
        return {
          ok: false,
          error: `${tag}: end (${e.line}) before start (${s.line})`,
        };
      }
      // empty text removes the range (replace with nothing)
      const replacement = op.text === "" ? [] : op.text.split("\n");
      file.lines.splice(s.line - 1, e.line - s.line + 1, ...replacement);
      file.hashes = file.lines.map(lineHash);
    } else if (op.op === "insert_after") {
      const s = resolveLine(file, op.start);
      if ("error" in s) return { ok: false, error: `${tag}: ${s.error}` };
      const insertion = op.text.split("\n");
      file.lines.splice(s.line, 0, ...insertion);
      file.hashes = file.lines.map(lineHash);
    } else if (op.op === "delete") {
      const s = resolveLine(file, op.start);
      if ("error" in s) return { ok: false, error: `${tag}: ${s.error}` };
      const e = resolveLine(file, op.end ?? op.start);
      if ("error" in e) return { ok: false, error: `${tag}: ${e.error}` };
      if (e.line < s.line) {
        return { ok: false, error: `${tag}: end before start` };
      }
      file.lines.splice(s.line - 1, e.line - s.line + 1);
      file.hashes = file.lines.map(lineHash);
    }
  }

  // Reconstruct file content. If original was empty, stay empty.
  // split("\n") on "a\n" → ["a", ""] so join restores trailing newline.
  const next = file.lines.join("\n");
  return {
    ok: true,
    content: next,
    opsApplied: ops.length,
    linesBefore,
    linesAfter: file.lines.length,
  };
}
