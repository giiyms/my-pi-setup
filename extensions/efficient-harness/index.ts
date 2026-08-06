/**
 * efficient-harness — token-efficient tools for Pi agent dir setups.
 *
 * Overrides: read, edit (hashline)
 * Adds: lsp, debug
 * Runtime: bash output compression, smart compaction, optional advisor
 *
 * Search (fd/rg) and multi-agent (subagent_*) come from sibling extensions.
 * Clean-room; no Oh My Pi source.
 */

import { Type } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  buildAdvisorPrompt,
  defaultAdvisorConfig,
  extractAssistantText,
  extractToolSummary,
  formatAdvisorInjection,
  parseAdvisorResponse,
  type AdvisorConfig,
} from "./lib/advisor.ts";
import { buildCompactionPrompt } from "./lib/compaction.ts";
import { compressText } from "./lib/compress.ts";
import {
  debugStatus,
  killSession,
  lldbBatch,
  lldbLaunch,
  nodeInspectStart,
  which as cmdWhich,
} from "./lib/debug-session.ts";
import {
  applyHashlineEdits,
  buildHashline,
  renderHashline,
  type EditOp,
} from "./lib/hashline.ts";
import {
  findProjectRoot,
  formatDiagnostics,
  getDiagnostics,
} from "./lib/lsp-client.ts";
import {
  isProbablyBinary,
  shouldSummarize,
  summarizeSource,
} from "./lib/summarize.ts";

const MAX_WRITE_BYTES = 2 * 1024 * 1024;

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { error: true },
    isError: true as const,
  };
}

async function resolveReadable(cwd: string, path: string): Promise<string> {
  return resolve(cwd, path);
}

/** Last status text per key — skip setStatus when unchanged. */
const lastStatusByKey = new Map<string, string | undefined>();
function setStatusIfChanged(
  ui: { setStatus: (key: string, text: string | undefined) => void },
  key: string,
  text: string | undefined,
) {
  if (lastStatusByKey.has(key) && lastStatusByKey.get(key) === text) return;
  lastStatusByKey.set(key, text);
  ui.setStatus(key, text);
}

export default function efficientHarness(pi: ExtensionAPI) {
  const advisor = defaultAdvisorConfig();
  let turnCounter = 0;
  let lastUserPrompt = "";
  const checkpoints = new Map<
    string,
    { label: string; note: string; at: number }
  >();

  // ── CLI flags ──────────────────────────────────────────────
  pi.registerFlag("advisor", {
    description: "Enable advisor second-pass on each agent turn",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("no-hashline", {
    description: "Disable hashline read/edit overrides (use Pi builtins)",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("no-bash-compress", {
    description: "Disable automatic bash/tool output compression",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("no-smart-compact", {
    description: "Disable structured smart compaction (use Pi default)",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("auto-lsp", {
    description:
      "After edit/write, append LSP diagnostics for the touched file",
    type: "boolean",
    default: false,
  });

  // ── session lifecycle ──────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("advisor")) advisor.enabled = true;
    if (ctx.hasUI) {
      const bits = [
        "efficient-harness",
        pi.getFlag("no-hashline") ? "hashline=off" : "hashline=on",
        advisor.enabled ? "advisor=on" : "advisor=off",
        pi.getFlag("no-smart-compact") ? "compact=default" : "compact=smart",
      ];
      setStatusIfChanged(ctx.ui, "efficient-harness", bits.join(" · "));
    }
  });

  // ── smart compaction ───────────────────────────────────────
  pi.on("session_before_compact", async (event, ctx) => {
    if (pi.getFlag("no-smart-compact")) return;

    const { preparation, signal } = event;
    const {
      messagesToSummarize,
      turnPrefixMessages,
      tokensBefore,
      firstKeptEntryId,
      previousSummary,
    } = preparation;

    const model = ctx.model;
    if (!model) return;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return;

    const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
    if (allMessages.length === 0) return;

    if (ctx.hasUI) {
      ctx.ui.notify(
        `Smart compact: ${allMessages.length} msgs (~${tokensBefore.toLocaleString()} tok)…`,
        "info",
      );
    }

    try {
      const conversationText = serializeConversation(convertToLlm(allMessages));
      const prompt = buildCompactionPrompt({
        conversationText,
        previousSummary,
        customInstructions: event.customInstructions,
      });

      const response = await complete(
        model,
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          maxTokens: 4096,
          signal,
        },
      );

      const summary = response.content
        .filter(
          (c: {
            type: string;
            text?: string;
          }): c is { type: "text"; text: string } =>
            c.type === "text" && typeof c.text === "string",
        )
        .map((c: { type: "text"; text: string }) => c.text)
        .join("\n")
        .trim();

      if (!summary) return;

      return {
        compaction: {
          summary,
          firstKeptEntryId,
          tokensBefore,
        },
      };
    } catch {
      // fall through to default compaction
      return;
    }
  });

  pi.on("input", async (event) => {
    if (event.source !== "extension") {
      lastUserPrompt = event.text;
    }
    return { action: "continue" as const };
  });

  // ── bash compress + optional auto-LSP after edit/write ─────
  pi.on("tool_result", async (event, ctx) => {
    if (
      pi.getFlag("auto-lsp") &&
      !event.isError &&
      (event.toolName === "edit" || event.toolName === "write")
    ) {
      const input = event.input as { path?: string };
      if (input?.path) {
        try {
          const root = await findProjectRoot(ctx.cwd);
          const diag = await getDiagnostics(input.path, root, {
            maxDiagnostics: 20,
          });
          const errors = diag.diagnostics.filter((d) => d.severity === "error");
          if (errors.length || diag.diagnostics.length) {
            const block = formatDiagnostics(diag);
            const joined = event.content
              .map((c) => (c.type === "text" ? c.text : ""))
              .join("\n");
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${joined}\n\n--- auto-lsp ---\n${block}`,
                },
              ],
              details: { ...(event.details as object), autoLsp: true },
            };
          }
        } catch {
          /* ignore lsp failures */
        }
      }
    }

    if (pi.getFlag("no-bash-compress")) return;
    if (event.isError) return;

    // Compress large text payloads from bash and similar tools
    if (
      event.toolName !== "bash" &&
      event.toolName !== "rg" &&
      event.toolName !== "fd"
    ) {
      const joined = event.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n");
      if (joined.length > 20_000) {
        const { text, compressed } = compressText(joined, { maxChars: 14_000 });
        if (compressed) {
          return {
            content: [{ type: "text" as const, text }],
            details: { ...(event.details as object), compressed: true },
          };
        }
      }
      return;
    }

    const joined = event.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("\n");
    const { text, compressed } = compressText(joined, {
      maxChars: event.toolName === "bash" ? 12_000 : 16_000,
      headLines: 100,
      tailLines: 40,
    });
    if (!compressed) return;
    return {
      content: [{ type: "text" as const, text }],
      details: { ...(event.details as object), compressed: true },
    };
  });

  // ── advisor after turns ────────────────────────────────────
  pi.on("turn_end", async (event, ctx) => {
    if (!advisor.enabled) return;
    turnCounter += 1;
    if (turnCounter % advisor.everyNTurns !== 0) return;

    const message = event.message as
      { role?: string; content?: unknown } | undefined;
    if (!message || message.role !== "assistant") return;

    const assistantText = extractAssistantText(message.content);
    if (assistantText.length < advisor.minAssistantChars) return;

    try {
      await runAdvisor({
        pi,
        ctx,
        advisor,
        userGoal: lastUserPrompt,
        assistantText,
        toolSummary: extractToolSummary(message.content),
      });
    } catch (err) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Advisor failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
    }
  });

  // ── /advisor command ───────────────────────────────────────
  pi.registerCommand("advisor", {
    description: "Advisor: on | off | status | once",
    handler: async (args, ctx) => {
      const a = (args ?? "").trim().toLowerCase();
      if (!a || a === "status") {
        ctx.ui.notify(
          `Advisor ${advisor.enabled ? "ON" : "OFF"} · everyN=${advisor.everyNTurns} · maxNotes=${advisor.maxNotes}`,
          "info",
        );
        return;
      }
      if (a === "on" || a === "enable") {
        advisor.enabled = true;
        setStatusIfChanged(
          ctx.ui,
          "efficient-harness",
          "efficient-harness · hashline · advisor=on",
        );
        ctx.ui.notify(
          "Advisor enabled — reviews each turn and injects notes",
          "info",
        );
        return;
      }
      if (a === "off" || a === "disable") {
        advisor.enabled = false;
        setStatusIfChanged(
          ctx.ui,
          "efficient-harness",
          "efficient-harness · hashline · advisor=off",
        );
        ctx.ui.notify("Advisor disabled", "info");
        return;
      }
      if (a === "once") {
        ctx.ui.notify(
          "Running one-shot advisor on last assistant turn…",
          "info",
        );
        const branch = ctx.sessionManager.getBranch();
        let assistantText = "";
        let toolSummary = "";
        for (let i = branch.length - 1; i >= 0; i--) {
          const e = branch[i] as {
            type?: string;
            message?: { role?: string; content?: unknown };
          };
          if (e?.type === "message" && e.message?.role === "assistant") {
            assistantText = extractAssistantText(e.message.content);
            toolSummary = extractToolSummary(e.message.content);
            break;
          }
        }
        if (!assistantText) {
          ctx.ui.notify("No assistant turn found", "warning");
          return;
        }
        try {
          await runAdvisor({
            pi,
            ctx,
            advisor: { ...advisor, enabled: true },
            userGoal: lastUserPrompt,
            assistantText,
            toolSummary,
          });
        } catch (err) {
          ctx.ui.notify(
            `Advisor failed: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }
        return;
      }
      ctx.ui.notify("Usage: /advisor on|off|status|once", "warning");
    },
  });

  // ── /checkpoint ────────────────────────────────────────────
  pi.registerCommand("checkpoint", {
    description: "Mark a named checkpoint (label) for /rewind",
    handler: async (args, ctx) => {
      const label = (args ?? "").trim() || `cp-${Date.now()}`;
      const leaf = ctx.sessionManager.getLeafId();
      checkpoints.set(label, {
        label,
        note: `leaf=${leaf ?? "none"}`,
        at: Date.now(),
      });
      if (leaf) {
        try {
          pi.setLabel(leaf, `checkpoint:${label}`);
        } catch {
          // labels may fail on some entries
        }
      }
      pi.appendEntry("efficient-checkpoint", { label, leaf, at: Date.now() });
      ctx.ui.notify(`Checkpoint saved: ${label}`, "info");
    },
  });

  pi.registerCommand("harness", {
    description: "Show efficient-harness status and tips",
    handler: async (_args, ctx) => {
      const tools = pi.getActiveTools();
      ctx.ui.notify(
        [
          "efficient-harness",
          `active tools: ${tools.join(", ")}`,
          `advisor: ${advisor.enabled ? "on" : "off"}`,
          `hashline: ${pi.getFlag("no-hashline") ? "off" : "on"}`,
          `bash compress: ${pi.getFlag("no-bash-compress") ? "off" : "on"}`,
          `smart compact: ${pi.getFlag("no-smart-compact") ? "off" : "on"}`,
          `auto-lsp: ${pi.getFlag("auto-lsp") ? "on" : "off"}`,
          "Tips: read full=true for hashline; edit via line:hash; use fd/rg for search;",
          "subagent_spawn for isolated work; lsp path=…; debug action=help; /advisor on.",
        ].join("\n"),
        "info",
      );
    },
  });

  const useHashline = !pi.getFlag("no-hashline");

  // ── override read ──────────────────────────────────────────
  if (useHashline) {
    pi.registerTool({
      name: "read",
      label: "read",
      description:
        "Read a file. Large files return a structural SUMMARY by default (token-efficient). Pass full=true for hashline-annotated content (line:hash|text). Use offset/limit (1-indexed) for windows. Prefer hashline reads before edit.",
      promptSnippet:
        "Read files; large files summarized; full=true for hashline anchors",
      promptGuidelines: [
        "Use read with full=true (or a small offset/limit window) before edit so you get line:hash anchors.",
        "Do not dump entire large files when a summary or range suffices.",
        "Prefer fd/rg tools for discovery and content search over bash find/grep.",
      ],
      parameters: Type.Object({
        path: Type.String({ description: "Path relative to cwd or absolute" }),
        offset: Type.Optional(
          Type.Number({
            description: "1-indexed start line (hashline window)",
          }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Max lines to return" }),
        ),
        full: Type.Optional(
          Type.Boolean({
            description:
              "If true, return hashline content even for large files",
          }),
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const abs = await resolveReadable(ctx.cwd, params.path);
        try {
          await access(abs, constants.R_OK);
        } catch {
          return errorResult(`Cannot read: ${params.path}`);
        }

        const buf = await readFile(abs);
        if (isProbablyBinary(buf)) {
          return textResult(
            `Binary file ${params.path} (${buf.length} bytes). Not shown.`,
            { binary: true, bytes: buf.length },
          );
        }

        const content = buf.toString("utf8");
        const rel = relative(ctx.cwd, abs) || params.path;
        const lineCount = content.length === 0 ? 0 : content.split("\n").length;
        const wantWindow = params.offset != null || params.limit != null;

        if (
          !params.full &&
          !wantWindow &&
          shouldSummarize(lineCount, buf.length, params.full)
        ) {
          return textResult(summarizeSource(rel, content), {
            mode: "summary",
            lines: lineCount,
            bytes: buf.length,
          });
        }

        const file = buildHashline(rel, content);
        const text = renderHashline(file, {
          offset: params.offset,
          limit: params.limit ?? (params.full ? undefined : 400),
          maxBytes: 80 * 1024,
        });
        return textResult(text, {
          mode: "hashline",
          lines: lineCount,
          bytes: buf.length,
        });
      },
    });

    // ── override edit ────────────────────────────────────────
    pi.registerTool({
      name: "edit",
      label: "edit",
      description:
        "Hashline edit: change file by content-hash anchors from read (e.g. start='12:a3f'). Ops: replace, insert_after, delete. Stale hashes are rejected — re-read if the file changed. Do NOT retype old_string lines.",
      promptSnippet: "Hashline edit via line:hash anchors from read",
      promptGuidelines: [
        "Use edit with hashline anchors from read (format line:hash). Prefer replace/insert_after/delete ops.",
        "If edit returns stale anchor, re-read the file and retry once — do not fall back to guessing whitespace.",
      ],
      parameters: Type.Object({
        path: Type.String({ description: "File path" }),
        ops: Type.Optional(
          Type.Array(
            Type.Object({
              op: Type.String({
                description: "replace | insert_after | delete",
              }),
              start: Type.String({ description: "Anchor line:hash" }),
              end: Type.Optional(
                Type.String({ description: "End anchor for ranges" }),
              ),
              text: Type.Optional(
                Type.String({ description: "New text for replace/insert" }),
              ),
            }),
            { description: "List of hashline operations" },
          ),
        ),
        op: Type.Optional(Type.String({ description: "Single op shortcut" })),
        start: Type.Optional(Type.String()),
        end: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const abs = resolve(ctx.cwd, params.path);
        let original: string;
        try {
          original = await readFile(abs, "utf8");
        } catch (e) {
          return errorResult(
            `Cannot read ${params.path}: ${(e as Error).message}`,
          );
        }

        const ops: EditOp[] = [];
        if (params.ops?.length) {
          for (const raw of params.ops) {
            const kind = raw.op as EditOp["op"];
            if (kind === "replace") {
              ops.push({
                op: "replace",
                start: raw.start,
                end: raw.end,
                text: raw.text ?? "",
              });
            } else if (kind === "insert_after") {
              ops.push({
                op: "insert_after",
                start: raw.start,
                text: raw.text ?? "",
              });
            } else if (kind === "delete") {
              ops.push({ op: "delete", start: raw.start, end: raw.end });
            } else {
              return errorResult(`Unknown op: ${raw.op}`);
            }
          }
        } else if (params.op && params.start) {
          const kind = params.op as EditOp["op"];
          if (kind === "replace") {
            ops.push({
              op: "replace",
              start: params.start,
              end: params.end,
              text: params.text ?? "",
            });
          } else if (kind === "insert_after") {
            ops.push({
              op: "insert_after",
              start: params.start,
              text: params.text ?? "",
            });
          } else if (kind === "delete") {
            ops.push({ op: "delete", start: params.start, end: params.end });
          } else {
            return errorResult(`Unknown op: ${params.op}`);
          }
        } else {
          return errorResult(
            "Provide ops:[{op,start,end?,text?}] or op+start(+text). Anchors must be line:hash from a hashline read.",
          );
        }

        const result = applyHashlineEdits(original, ops);
        if (!result.ok) {
          return errorResult(result.error);
        }

        if (Buffer.byteLength(result.content, "utf8") > MAX_WRITE_BYTES) {
          return errorResult("Edit result exceeds 2MB limit");
        }

        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, result.content, "utf8");

        return textResult(
          `Edited ${params.path}: ${result.opsApplied} op(s), lines ${result.linesBefore} → ${result.linesAfter}.`,
          {
            opsApplied: result.opsApplied,
            linesBefore: result.linesBefore,
            linesAfter: result.linesAfter,
          },
        );
      },
    });
  }

  // ── debug ──────────────────────────────────────────────────
  pi.registerTool({
    name: "debug",
    label: "debug",
    description:
      "Debugger helper. Actions: help, status, lldb_run, lldb_cmds, node_inspect, kill. Uses lldb (native) or node --inspect-brk. Prefer this over sprinkling print statements for crashes/hangs.",
    promptSnippet: "lldb / node inspect debugging",
    promptGuidelines: [
      "Use debug for segfaults, wrong values at runtime, or hangs when logs are insufficient.",
      "Always kill node_inspect sessions when finished.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description:
          "help | status | lldb_run | lldb_cmds | node_inspect | kill",
      }),
      program: Type.Optional(
        Type.String({ description: "Binary or script path" }),
      ),
      args: Type.Optional(Type.Array(Type.String())),
      breakpoint: Type.Optional(
        Type.String({ description: "file:line or symbol name" }),
      ),
      commands: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "lldb commands after stop (bt, frame variable, p expr, ...)",
        }),
      ),
      session: Type.Optional(
        Type.String({ description: "Session id for kill" }),
      ),
      port: Type.Optional(
        Type.Number({ description: "Node inspect port (default 9229)" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const action = params.action.toLowerCase();

      if (action === "help") {
        return textResult(
          [
            "debug actions:",
            "  status — list sessions",
            "  lldb_run program=./a.out breakpoint=main|file:line args=[...]",
            "  lldb_cmds program=./a.out breakpoint=file:line commands=['bt','frame variable','p x']",
            "  node_inspect program=./script.js args=[...] port=9229",
            "  kill session=<id>",
            "",
            `lldb available: ${await cmdWhich("lldb")}`,
          ].join("\n"),
        );
      }

      if (action === "status") {
        return textResult(await debugStatus());
      }

      if (action === "kill") {
        if (!params.session) return errorResult("session id required");
        return textResult(await killSession(params.session));
      }

      if (action === "lldb_run") {
        if (!params.program) return errorResult("program required");
        try {
          const { session, output } = await lldbLaunch({
            cwd: ctx.cwd,
            program: resolve(ctx.cwd, params.program),
            args: params.args,
            breakpoint: params.breakpoint,
          });
          const clipped = compressText(output, { maxChars: 14_000 }).text;
          return textResult(`lldb session ${session.id}\n\n${clipped}`, {
            sessionId: session.id,
            backend: "lldb",
          });
        } catch (e) {
          return errorResult((e as Error).message);
        }
      }

      if (action === "lldb_cmds") {
        if (!params.program) return errorResult("program required");
        try {
          const output = await lldbBatch({
            cwd: ctx.cwd,
            program: resolve(ctx.cwd, params.program),
            args: params.args,
            breakpoint: params.breakpoint,
            commands: params.commands?.length
              ? params.commands
              : ["bt", "frame variable"],
          });
          return textResult(compressText(output, { maxChars: 14_000 }).text);
        } catch (e) {
          return errorResult((e as Error).message);
        }
      }

      if (action === "node_inspect") {
        if (!params.program) return errorResult("program (script) required");
        try {
          const { session, output } = await nodeInspectStart({
            cwd: ctx.cwd,
            script: resolve(ctx.cwd, params.program),
            args: params.args,
            port: params.port,
          });
          return textResult(output, {
            sessionId: session.id,
            backend: "node",
            port: session.port,
          });
        } catch (e) {
          return errorResult((e as Error).message);
        }
      }

      return errorResult(`Unknown action: ${params.action}. Use action=help.`);
    },
  });

  // ── lsp ────────────────────────────────────────────────────
  pi.registerTool({
    name: "lsp",
    label: "lsp",
    description:
      "Language diagnostics for a file (typescript-language-server, pyright, rust-analyzer, clangd). Prefer after edits to catch errors without a full build. Caps results (default 40).",
    promptSnippet: "File diagnostics via LSP/CLI",
    promptGuidelines: [
      "After non-trivial edit/write, call lsp on the touched file to catch errors early.",
      "Do not dump full project builds when lsp diagnostics suffice.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File to analyze" }),
      maxDiagnostics: Type.Optional(
        Type.Number({ description: "Cap (default 40)" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = await findProjectRoot(ctx.cwd);
      const r = await getDiagnostics(params.path, root, {
        maxDiagnostics: params.maxDiagnostics,
      });
      return textResult(formatDiagnostics(r), {
        engine: r.engine,
        count: r.diagnostics.length,
        errors: r.diagnostics.filter((d) => d.severity === "error").length,
      });
    },
  });
}

async function runAdvisor(opts: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  advisor: AdvisorConfig;
  userGoal: string;
  assistantText: string;
  toolSummary: string;
}): Promise<void> {
  const { pi, ctx, advisor, userGoal, assistantText, toolSummary } = opts;
  const model = ctx.model;
  if (!model) return;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth?.ok || !auth.apiKey) return;

  const prompt = buildAdvisorPrompt({ userGoal, assistantText, toolSummary });
  const response = await complete(
    model,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal: ctx.signal,
    },
  );

  const raw = response.content
    .filter(
      (c: {
        type: string;
        text?: string;
      }): c is { type: "text"; text: string } =>
        c.type === "text" && typeof c.text === "string",
    )
    .map((c: { type: "text"; text: string }) => c.text)
    .join("\n");

  const notes = parseAdvisorResponse(raw).slice(0, advisor.maxNotes);
  if (!notes.length) {
    if (ctx.hasUI) setStatusIfChanged(ctx.ui, "advisor", "advisor: clean");
    return;
  }

  const injection = formatAdvisorInjection(notes);
  pi.sendMessage(
    {
      customType: "advisor-note",
      content: injection,
      display: true,
      details: { notes },
    },
    { deliverAs: "nextTurn" },
  );

  if (ctx.hasUI) {
    const blockers = notes.filter((n) => n.severity === "blocker").length;
    setStatusIfChanged(
      ctx.ui,
      "advisor",
      blockers
        ? `advisor: ${blockers} blocker(s)`
        : `advisor: ${notes.length} note(s)`,
    );
    ctx.ui.notify(
      notes.map((n) => `(${n.severity}) ${n.text}`).join("\n"),
      blockers ? "warning" : "info",
    );
  }
}
