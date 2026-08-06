/**
 * Lightweight debugger sessions for the agent.
 *
 * Supports:
 * - lldb batch/one-shot commands (C/C++/Rust/native on macOS)
 * - node inspect via temporary --inspect-brk wrapper scripts
 *
 * This is intentionally practical, not a full DAP client. Full DAP adapters
 * can be added later without changing the tool surface much.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type DebugBackend = "lldb" | "node";

export type DebugSession = {
  id: string;
  backend: DebugBackend;
  createdAt: number;
  cwd: string;
  /** Human description */
  target: string;
  lastOutput: string;
  alive: boolean;
  /** For node inspector */
  port?: number;
  child?: ChildProcess;
};

const sessions = new Map<string, DebugSession>();

function sid(): string {
  return randomBytes(4).toString("hex");
}

function runCapture(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 15_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ code: 127, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function listSessions(): DebugSession[] {
  return [...sessions.values()].map((s) => ({
    ...s,
    child: undefined,
  }));
}

export function getSession(id: string): DebugSession | undefined {
  return sessions.get(id);
}

export async function which(cmd: string): Promise<boolean> {
  const r = await runCapture(
    process.platform === "win32" ? "where" : "which",
    [cmd],
    process.cwd(),
  );
  return r.code === 0;
}

/** Launch lldb against a binary with optional args and an initial breakpoint. */
export async function lldbLaunch(opts: {
  cwd: string;
  program: string;
  args?: string[];
  breakpoint?: string; // file:line or symbol
}): Promise<{ session: DebugSession; output: string }> {
  if (!(await which("lldb"))) {
    throw new Error("lldb not found on PATH. Install Xcode CLT or lldb.");
  }

  const id = sid();
  const bp = opts.breakpoint
    ? opts.breakpoint.includes(":")
      ? `breakpoint set --file ${opts.breakpoint.split(":")[0]} --line ${opts.breakpoint.split(":")[1]}`
      : `breakpoint set --name ${opts.breakpoint}`
    : "breakpoint set --name main";

  const argList = (opts.args ?? [])
    .map((a) => `"${a.replace(/"/g, '\\"')}"`)
    .join(" ");
  const script = [
    `target create "${opts.program}"`,
    argList ? `settings set target.run-args ${argList}` : "",
    bp,
    "run",
    "bt",
    "frame variable",
    "process status",
  ]
    .filter(Boolean)
    .join("\n");

  const scriptPath = join(tmpdir(), `pi-dbg-${id}.lldb`);
  await writeFile(scriptPath, script, "utf8");
  try {
    const r = await runCapture(
      "lldb",
      ["-b", "-s", scriptPath],
      opts.cwd,
      30_000,
    );
    const output = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
    const session: DebugSession = {
      id,
      backend: "lldb",
      createdAt: Date.now(),
      cwd: opts.cwd,
      target: opts.program,
      lastOutput: output,
      alive: false, // batch session finished; use lldb_cmd for further one-shots
    };
    sessions.set(id, session);
    return { session, output };
  } finally {
    await unlink(scriptPath).catch(() => {});
  }
}

/** One-shot lldb commands against a program (stop at bp, run cmds, quit). */
export async function lldbBatch(opts: {
  cwd: string;
  program: string;
  commands: string[];
  breakpoint?: string;
  args?: string[];
}): Promise<string> {
  if (!(await which("lldb"))) {
    throw new Error("lldb not found on PATH");
  }
  const id = sid();
  const bp = opts.breakpoint
    ? opts.breakpoint.includes(":")
      ? `breakpoint set --file ${opts.breakpoint.split(":")[0]} --line ${opts.breakpoint.split(":")[1]}`
      : `breakpoint set --name ${opts.breakpoint}`
    : null;

  const argList = (opts.args ?? [])
    .map((a) => `"${a.replace(/"/g, '\\"')}"`)
    .join(" ");
  const script = [
    `target create "${opts.program}"`,
    argList ? `settings set target.run-args ${argList}` : "",
    bp ?? "",
    "run",
    ...opts.commands,
    "quit",
  ]
    .filter(Boolean)
    .join("\n");

  const scriptPath = join(tmpdir(), `pi-dbg-${id}.lldb`);
  await writeFile(scriptPath, script, "utf8");
  try {
    const r = await runCapture(
      "lldb",
      ["-b", "-s", scriptPath],
      opts.cwd,
      30_000,
    );
    return [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
  } finally {
    await unlink(scriptPath).catch(() => {});
  }
}

/** Start node with --inspect-brk and return connection info (agent uses inspect_cmd). */
export async function nodeInspectStart(opts: {
  cwd: string;
  script: string;
  args?: string[];
  port?: number;
}): Promise<{ session: DebugSession; output: string }> {
  const port = opts.port ?? 9229;
  const id = sid();
  const child = spawn(
    process.execPath,
    [`--inspect-brk=${port}`, opts.script, ...(opts.args ?? [])],
    { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] },
  );

  let boot = "";
  const output = await new Promise<string>((resolvePromise) => {
    const timer = setTimeout(
      () =>
        resolvePromise(
          boot || "started (timeout waiting for debugger message)",
        ),
      3000,
    );
    const onData = (d: Buffer) => {
      boot += d.toString();
      if (boot.includes("Debugger listening") || boot.includes("ws://")) {
        clearTimeout(timer);
        resolvePromise(boot);
      }
    };
    child.stderr.on("data", onData);
    child.stdout.on("data", onData);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolvePromise(e.message);
    });
  });

  const session: DebugSession = {
    id,
    backend: "node",
    createdAt: Date.now(),
    cwd: opts.cwd,
    target: opts.script,
    lastOutput: output,
    alive: true,
    port,
    child,
  };
  sessions.set(id, session);
  return {
    session,
    output: [
      output.trim(),
      "",
      `Node inspector on port ${port}.`,
      `Use Chrome DevTools or: node inspect 127.0.0.1:${port}`,
      `Session id: ${id}. Call debug action=kill session=${id} when done.`,
      `Tip: for scripted inspection, use debug action=eval with node --inspect-print or add breakpoints in source and re-run.`,
    ].join("\n"),
  };
}

export async function killSession(id: string): Promise<string> {
  const s = sessions.get(id);
  if (!s) return `Unknown session ${id}`;
  if (s.child && s.alive) {
    s.child.kill("SIGTERM");
    s.alive = false;
  }
  sessions.delete(id);
  return `Session ${id} killed.`;
}

export async function debugStatus(): Promise<string> {
  const all = listSessions();
  if (!all.length) return "No active debug sessions.";
  return all
    .map(
      (s) =>
        `- ${s.id} backend=${s.backend} target=${s.target} alive=${s.alive} port=${s.port ?? "-"}`,
    )
    .join("\n");
}
