/**
 * Minimal LSP client for single-file diagnostics.
 * Prefer CLI backends when simpler; fall back to JSON-RPC stdio.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type Diagnostic = {
  severity: "error" | "warning" | "info" | "hint";
  line: number; // 1-based
  character: number; // 1-based
  endLine?: number;
  endCharacter?: number;
  source?: string;
  code?: string | number;
  message: string;
};

export type DiagnosticsResult = {
  path: string;
  engine: string;
  diagnostics: Diagnostic[];
  error?: string;
};

const SEV: Record<number, Diagnostic["severity"]> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

async function which(cmd: string): Promise<string | null> {
  const r = await run(
    process.platform === "win32" ? "where" : "which",
    [cmd],
    process.cwd(),
    3000,
  );
  if (r.code !== 0) return null;
  const line = r.stdout.trim().split("\n")[0]?.trim();
  return line || null;
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 20_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(t);
      resolvePromise({ code: 127, stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Map path extension → preferred engines */
export function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    case ".rs":
      return "rust";
    case ".c":
    case ".h":
    case ".cc":
    case ".cpp":
    case ".cxx":
    case ".hpp":
      return "cpp";
    case ".go":
      return "go";
    case ".swift":
      return "swift";
    default:
      return "unknown";
  }
}

// ── CLI backends ─────────────────────────────────────────────

async function pyrightCli(
  abs: string,
  cwd: string,
): Promise<DiagnosticsResult | null> {
  const bin = (await which("pyright")) ?? null;
  if (!bin) return null;
  const r = await run(bin, ["--outputjson", abs], cwd, 45_000);
  // pyright exits non-zero when errors exist
  try {
    const json = JSON.parse(r.stdout || "{}") as {
      generalDiagnostics?: Array<{
        file?: string;
        severity?: string;
        message?: string;
        rule?: string;
        range?: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
      }>;
    };
    const diags: Diagnostic[] = [];
    for (const d of json.generalDiagnostics ?? []) {
      if (d.file && resolve(d.file) !== abs && !d.file.endsWith(basename(abs)))
        continue;
      const sev = (d.severity ?? "error").toLowerCase();
      diags.push({
        severity:
          sev === "error" ||
          sev === "warning" ||
          sev === "information" ||
          sev === "hint"
            ? sev === "information"
              ? "info"
              : (sev as Diagnostic["severity"])
            : "error",
        line: (d.range?.start.line ?? 0) + 1,
        character: (d.range?.start.character ?? 0) + 1,
        endLine: (d.range?.end.line ?? 0) + 1,
        endCharacter: (d.range?.end.character ?? 0) + 1,
        source: "pyright",
        code: d.rule,
        message: d.message ?? "",
      });
    }
    return { path: abs, engine: "pyright-cli", diagnostics: diags };
  } catch {
    if (r.stderr || r.stdout) {
      return {
        path: abs,
        engine: "pyright-cli",
        diagnostics: [],
        error: (r.stderr || r.stdout).slice(0, 2000),
      };
    }
    return null;
  }
}

// ── Minimal JSON-RPC LSP ─────────────────────────────────────

class LspProcess {
  private child: ChildProcessWithoutNullStreams;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private diagnostics = new Map<string, Diagnostic[]>();
  private diagWaiters: Array<() => void> = [];

  constructor(cmd: string, args: string[], cwd: string) {
    this.child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on("data", () => {
      /* ignore noise */
    });
    this.child.on("error", (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
  }

  private onData(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buf.subarray(0, headerEnd).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + len) return;
      const body = this.buf
        .subarray(bodyStart, bodyStart + len)
        .toString("utf8");
      this.buf = this.buf.subarray(bodyStart + len);
      try {
        this.handleMessage(JSON.parse(body));
      } catch {
        /* ignore */
      }
    }
  }

  private handleMessage(msg: {
    id?: number;
    method?: string;
    result?: unknown;
    error?: { message?: string };
    params?: {
      uri?: string;
      diagnostics?: Array<{
        severity?: number;
        message?: string;
        source?: string;
        code?: string | number;
        range?: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
      }>;
    };
  }) {
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "LSP error"));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri) {
      const diags: Diagnostic[] = (msg.params.diagnostics ?? []).map((d) => ({
        severity: SEV[d.severity ?? 1] ?? "error",
        line: (d.range?.start.line ?? 0) + 1,
        character: (d.range?.start.character ?? 0) + 1,
        endLine: (d.range?.end.line ?? 0) + 1,
        endCharacter: (d.range?.end.character ?? 0) + 1,
        source: d.source,
        code: d.code,
        message: d.message ?? "",
      }));
      this.diagnostics.set(msg.params.uri, diags);
      for (const w of this.diagWaiters) w();
      this.diagWaiters = [];
    }
  }

  private send(payload: object) {
    const json = JSON.stringify(payload);
    const msg = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
    this.child.stdin.write(msg);
  }

  request(method: string, params?: object): Promise<unknown> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP timeout: ${method}`));
      }, 20_000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });
  }

  notify(method: string, params?: object) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  waitDiagnostics(uri: string, timeoutMs = 4000): Promise<Diagnostic[]> {
    if (this.diagnostics.has(uri))
      return Promise.resolve(this.diagnostics.get(uri)!);
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve(this.diagnostics.get(uri) ?? []),
        timeoutMs,
      );
      this.diagWaiters.push(() => {
        clearTimeout(timer);
        resolve(this.diagnostics.get(uri) ?? []);
      });
    });
  }

  kill() {
    try {
      this.child.stdin.end();
    } catch {
      /* */
    }
    this.child.kill("SIGTERM");
  }
}

async function lspDiagnostics(
  abs: string,
  cwd: string,
  content: string,
  serverCmd: string,
  serverArgs: string[],
  languageId: string,
  engine: string,
): Promise<DiagnosticsResult> {
  const root = cwd;
  const uri = pathToFileURL(abs).href;
  const rootUri = pathToFileURL(root.endsWith("/") ? root : `${root}/`).href;
  const lsp = new LspProcess(serverCmd, serverArgs, root);
  try {
    await lsp.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: false },
          synchronization: { didSave: true },
        },
      },
      workspaceFolders: [{ uri: rootUri, name: basename(root) }],
    });
    lsp.notify("initialized", {});
    lsp.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    });
    // Some servers only publish after a short settle
    let diags = await lsp.waitDiagnostics(uri, 5000);
    // pull diagnostics if supported
    if (!diags.length) {
      try {
        const pulled = (await lsp.request("textDocument/diagnostic", {
          textDocument: { uri },
        })) as { items?: unknown[]; kind?: string };
        if (pulled && Array.isArray((pulled as { items?: unknown[] }).items)) {
          // Full report shape varies; ignore if empty
        }
      } catch {
        /* not supported */
      }
      diags = await lsp.waitDiagnostics(uri, 2000);
    }
    try {
      await lsp.request("shutdown");
      lsp.notify("exit");
    } catch {
      /* */
    }
    return { path: abs, engine, diagnostics: diags };
  } catch (e) {
    return {
      path: abs,
      engine,
      diagnostics: [],
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    lsp.kill();
  }
}

export async function getDiagnostics(
  filePath: string,
  cwd: string,
  options: { content?: string; maxDiagnostics?: number } = {},
): Promise<DiagnosticsResult> {
  const abs = resolve(cwd, filePath);
  try {
    await access(abs, constants.R_OK);
  } catch {
    return {
      path: abs,
      engine: "none",
      diagnostics: [],
      error: `Cannot read ${filePath}`,
    };
  }

  const content = options.content ?? (await readFile(abs, "utf8"));
  const lang = detectLanguage(abs);
  const max = options.maxDiagnostics ?? 40;

  let result: DiagnosticsResult | null = null;

  if (lang === "python") {
    result = await pyrightCli(abs, cwd);
    if (!result) {
      const bin = await which("pyright-langserver");
      if (bin) {
        result = await lspDiagnostics(
          abs,
          cwd,
          content,
          bin,
          ["--stdio"],
          "python",
          "pyright-lsp",
        );
      }
    }
  } else if (lang === "typescript" || lang === "javascript") {
    const bin = await which("typescript-language-server");
    if (bin) {
      result = await lspDiagnostics(
        abs,
        cwd,
        content,
        bin,
        ["--stdio"],
        lang === "typescript" ? "typescript" : "javascript",
        "typescript-language-server",
      );
    }
  } else if (lang === "rust") {
    const bin = await which("rust-analyzer");
    if (bin) {
      result = await lspDiagnostics(
        abs,
        cwd,
        content,
        bin,
        [],
        "rust",
        "rust-analyzer",
      );
    }
  } else if (lang === "cpp") {
    const bin = await which("clangd");
    if (bin) {
      result = await lspDiagnostics(
        abs,
        cwd,
        content,
        bin,
        [],
        "cpp",
        "clangd",
      );
    }
  } else if (lang === "go") {
    const bin = await which("gopls");
    if (bin) {
      result = await lspDiagnostics(abs, cwd, content, bin, [], "go", "gopls");
    }
  }

  if (!result) {
    return {
      path: abs,
      engine: "none",
      diagnostics: [],
      error: `No diagnostics engine for ${lang} (${extname(abs)}). Install typescript-language-server, pyright, rust-analyzer, or clangd.`,
    };
  }

  // Prefer errors first, cap
  result.diagnostics = [...result.diagnostics]
    .sort((a, b) => {
      const rank = { error: 0, warning: 1, info: 2, hint: 3 };
      return rank[a.severity] - rank[b.severity] || a.line - b.line;
    })
    .slice(0, max);

  return result;
}

export function formatDiagnostics(r: DiagnosticsResult): string {
  if (r.error && !r.diagnostics.length) {
    return `LSP ${r.engine}: ${r.error}`;
  }
  const rel = r.path;
  if (!r.diagnostics.length) {
    return `${rel}: no diagnostics (engine=${r.engine})`;
  }
  const lines = r.diagnostics.map(
    (d) =>
      `${d.severity.toUpperCase()} ${rel}:${d.line}:${d.character} ${d.message}${d.code != null ? ` [${d.code}]` : ""}${d.source ? ` (${d.source})` : ""}`,
  );
  return [
    `${rel} — ${r.diagnostics.length} issue(s) via ${r.engine}`,
    ...lines,
  ].join("\n");
}

/** Best-effort root for workspace (has package.json / Cargo.toml / pyproject). */
export async function findProjectRoot(start: string): Promise<string> {
  let dir = resolve(start);
  for (let i = 0; i < 12; i++) {
    for (const marker of [
      "package.json",
      "Cargo.toml",
      "pyproject.toml",
      "go.mod",
      "tsconfig.json",
    ]) {
      try {
        await access(resolve(dir, marker), constants.R_OK);
        return dir;
      } catch {
        /* */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}
