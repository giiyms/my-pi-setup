/**
 * Antigravity (agy) backend — exposed as the `gemini` harness.
 *
 * Headless turns via `agy -p` / `--print`. Idle `send()` starts a new process
 * with prior turns prepended for multi-phase council work. Live steer is queued
 * until the current process exits. Interrupt kills the child.
 *
 * Prefer Antigravity over `@google/gemini-cli` — this environment authenticates
 * through agy (Google account / Antigravity), not GEMINI_API_KEY.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Cause, Scope } from "effect";
import { Effect, Fiber, Queue, Ref, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import type {
  QueuedMessage,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
} from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";

const GEMINI_CONTEXT_WINDOW = 1_000_000;
/** Default keeps the harness on the Gemini family (agy settings may default to Claude). */
const DEFAULT_MODEL = "gemini-3.1-pro-high";
const PREVIEW_CHUNK = 256;
const SESSION_DIR = path.join(os.tmpdir(), "pi-subagents-gemini");

let cachedAgyBinary: string | null | undefined;

function executable(file: string) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve Antigravity CLI (`agy`) from PATH or common install locations. */
function resolveAgyBinary() {
  if (cachedAgyBinary !== undefined) return cachedAgyBinary ?? undefined;

  const names =
    process.platform === "win32" ? ["agy.exe", "agy.cmd", "agy"] : ["agy"];

  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (executable(candidate)) {
        cachedAgyBinary = candidate;
        return candidate;
      }
    }
  }

  const home = os.homedir();
  for (const candidate of [
    path.join(home, ".local", "bin", "agy"),
    path.join(home, ".gemini", "antigravity-cli", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ]) {
    if (executable(candidate)) {
      cachedAgyBinary = candidate;
      return candidate;
    }
  }

  cachedAgyBinary = null;
  return undefined;
}

function resolveModel(model?: string) {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_MODEL;
}

function buildArgs(prompt: string, model?: string) {
  return [
    "-p",
    prompt,
    "--dangerously-skip-permissions",
    "--model",
    resolveModel(model),
  ];
}

export const geminiBackend: SubagentBackend = {
  name: "gemini",
  capabilities: {
    steering: false,
    modelSelection: true,
    reasoningEffort: false,
  },
  available: Effect.sync(() => resolveAgyBinary() !== undefined),
  spawn: (task) => makeGeminiSession(task),
};

const makeGeminiSession = (
  task: SpawnTask,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const binary = resolveAgyBinary();
    if (!binary) {
      return yield* new SpawnError({
        message:
          "Antigravity CLI (`agy`) not found on PATH. Install Antigravity and ensure `agy` is available (e.g. ~/.local/bin/agy).",
      });
    }

    const sessionId = `gemini-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    try {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    } catch {
      // best-effort
    }
    const sessionFile = path.join(SESSION_DIR, `${sessionId}.jsonl`);

    const resolvedModel = resolveModel(task.model);
    const state = {
      meta: {
        backend: "gemini" as const,
        modelLabel: `agy/${resolvedModel}`,
        contextWindow: GEMINI_CONTEXT_WINDOW,
        sessionFilePath: sessionFile,
        nativeSessionId: sessionId,
      } satisfies SubagentMeta as SubagentMeta,
      closed: false,
      history: [] as { role: "user" | "assistant"; text: string }[],
      pending: [] as string[],
    };

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const inbox = yield* Queue.make<string, Cause.Done>();
    const activeChild = yield* Ref.make<ChildProcess | undefined>(undefined);
    const activeTurn = yield* Ref.make<
      Fiber.Fiber<unknown, unknown> | undefined
    >(undefined);

    const emit = (event: SubagentEvent) => {
      try {
        fs.appendFileSync(sessionFile, `${JSON.stringify(event)}\n`);
      } catch {
        // best-effort transcript
      }
      if (event._tag === "MetaChanged") {
        state.meta = { ...state.meta, ...event.meta };
      }
      Queue.offerUnsafe(events, event);
    };

    const queuedView = (): ReadonlyArray<QueuedMessage> =>
      state.pending.map((text) => ({ text, kind: "follow-up" as const }));

    const runProcess = (userText: string) =>
      Effect.callback<void>((resume) => {
        const transcript = [
          ...state.history.map(
            (turn) =>
              `${turn.role === "user" ? "User" : "Assistant"}:\n${turn.text}`,
          ),
          `User:\n${userText}`,
        ].join("\n\n");

        let stdout = "";
        let stderr = "";
        let settled = false;

        let child: ChildProcess;
        try {
          child = spawn(binary, buildArgs(transcript, task.model), {
            cwd: task.cwd,
            env: { ...process.env, NO_COLOR: process.env.NO_COLOR ?? "1" },
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (err) {
          emit({ _tag: "RunStarted" });
          emit({
            _tag: "RunSettled",
            outcome: {
              _tag: "Failed",
              errorText: err instanceof Error ? err.message : String(err),
            },
          });
          resume(Effect.void);
          return;
        }

        emit({ _tag: "RunStarted" });
        emit({ _tag: "UserMessage", text: userText });
        void Ref.set(activeChild, child).pipe(Effect.runPromise);

        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
          for (let i = 0; i < chunk.length; i += PREVIEW_CHUNK) {
            emit({
              _tag: "AssistantDelta",
              kind: "text",
              delta: chunk.slice(i, i + PREVIEW_CHUNK),
            });
          }
        });
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });

        const settle = (
          outcome:
            | { _tag: "Completed"; finalText: string }
            | { _tag: "Failed"; errorText: string; partialText?: string }
            | { _tag: "Interrupted"; partialText?: string },
        ) => {
          if (settled) return;
          settled = true;
          void Ref.set(activeChild, undefined).pipe(Effect.runPromise);
          if (outcome._tag === "Completed") {
            state.history.push({ role: "user", text: userText });
            state.history.push({ role: "assistant", text: outcome.finalText });
            emit({
              _tag: "AssistantMessage",
              parts: [{ type: "text", text: outcome.finalText }],
            });
          }
          emit({ _tag: "RunSettled", outcome });
          resume(Effect.void);
        };

        child.on("error", (err) => {
          settle({
            _tag: "Failed",
            errorText: err.message,
            partialText: stdout.trim() || undefined,
          });
        });
        child.on("close", (code, signal) => {
          if (signal) {
            settle({
              _tag: "Interrupted",
              partialText: stdout.trim() || undefined,
            });
            return;
          }
          const out = stdout.trimEnd();
          const err = stderr.trim();
          if (code === 0 || (out && !err)) {
            settle({
              _tag: "Completed",
              finalText: out || "(empty agy/antigravity response)",
            });
            return;
          }
          if (out.length > 0 && out.length >= err.length) {
            settle({ _tag: "Completed", finalText: out });
            return;
          }
          settle({
            _tag: "Failed",
            errorText:
              err || `Antigravity (agy) exited with code ${code ?? "?"}`,
            partialText: out || undefined,
          });
        });

        return Effect.sync(() => {
          if (!settled && child && !child.killed) {
            try {
              child.kill("SIGTERM");
            } catch {
              // ignore
            }
          }
        });
      });

    const driver = Effect.gen(function* () {
      while (true) {
        const text = yield* Queue.take(inbox);
        if (state.pending[0] === text) state.pending.shift();
        emit({ _tag: "QueueChanged", queued: queuedView() });

        const fiber = yield* Effect.forkChild(runProcess(text));
        yield* Ref.set(activeTurn, fiber);
        yield* Fiber.await(fiber);
        yield* Ref.set(activeTurn, undefined);
      }
    });
    yield* Effect.forkScoped(driver.pipe(Effect.ignore));

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        state.closed = true;
        state.pending = [];
        const child = yield* Ref.get(activeChild);
        if (child && !child.killed) {
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore
          }
        }
        const fiber = yield* Ref.get(activeTurn);
        if (fiber) yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
        yield* Queue.end(inbox).pipe(Effect.ignore);
        yield* Queue.end(events).pipe(Effect.ignore);
      }).pipe(Effect.asVoid),
    );

    const submit = (text: string) =>
      Effect.gen(function* () {
        if (state.closed) {
          return yield* new SendError({
            message: "Antigravity (gemini) session is closed.",
          });
        }
        state.pending.push(text);
        const busy = (yield* Ref.get(activeTurn)) !== undefined;
        if (busy) emit({ _tag: "QueueChanged", queued: queuedView() });
        yield* Queue.offer(inbox, text);
      });

    emit({ _tag: "MetaChanged", meta: state.meta });
    yield* submit(task.prompt).pipe(Effect.orDie);

    return {
      meta: Effect.sync(() => state.meta),
      events: Stream.fromQueue(events),
      send: submit,
      interrupt: Effect.gen(function* () {
        const cleared = yield* Queue.clear(inbox).pipe(
          Effect.orElseSucceed(() => [] as string[]),
        );
        state.pending = [];
        emit({ _tag: "QueueChanged", queued: [] });
        const child = yield* Ref.get(activeChild);
        if (child && !child.killed) {
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore
          }
        }
        const fiber = yield* Ref.get(activeTurn);
        if (fiber) {
          yield* Fiber.interrupt(fiber);
          return;
        }
        if (cleared.length > 0) {
          emit({
            _tag: "RunSettled",
            outcome: { _tag: "Interrupted" },
          });
        }
      }),
    } satisfies SubagentSession;
  });
