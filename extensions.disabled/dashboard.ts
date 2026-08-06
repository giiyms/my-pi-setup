/**
 * PiJS / pi_agent_rust dashboard.
 *
 * Rust Pi does NOT support custom TUI components from extensions (core owns the
 * UI). setHeader/setFooter only accept plain strings (see PiJS UI shim:
 * setHeader → setTitle, setFooter → setStatus statusKey=footer).
 *
 * This extension rebuilds the useful parts of the old Node ui-customization +
 * model-info + git-info stack using those text APIs only — no `effect`, no
 * package.json deps, no @earendil-works/pi-tui component tree hacks.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GIT_POLL_MS = 3_000;
const GIT_TIMEOUT_MS = 2_500;

// Sync child_process is denied by PiJS policy; use async execFile only.

type Ctx = {
  cwd?: string;
  mode?: string;
  model?: {
    provider?: string;
    id?: string;
    name?: string;
    contextWindow?: number;
    reasoning?: boolean;
  };
  ui?: {
    setFooter?(text: string): void;
    setHeader?(text: string): void;
    setTitle?(title: string): void;
    setStatus?(key: string, text: string | undefined): void;
    setWidget?(key: string, lines: string[] | undefined): void;
    notify?(message: string, level?: string): void;
  };
  sessionManager?: {
    getBranch?(): Array<{
      type?: string;
      message?: {
        role?: string;
        usage?: {
          cost?: { total?: number };
          total?: number;
          input?: number;
          output?: number;
        };
      };
    }>;
  };
  getContextUsage?: () => {
    tokens?: number;
    contextWindow?: number;
    percent?: number;
  } | null;
  hasUI?: boolean;
};

function formatTokens(tokens: number) {
  if (!Number.isFinite(tokens) || tokens <= 0) return "?";
  if (tokens < 1_000) return `${Math.round(tokens)}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (!cwd) return ".";
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) return `~/${relative(home, cwd)}`;
  return cwd;
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeout = GIT_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        encoding: "utf8",
        timeout,
        maxBuffer: 1024 * 1024,
      },
      (err, stdout) => {
        if (err) resolve("");
        else resolve(String(stdout ?? "").trim());
      },
    );
  });
}

function sessionCost(ctx: Ctx) {
  let cost = 0;
  try {
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    for (const entry of branch) {
      if (entry?.type !== "message") continue;
      if (entry.message?.role !== "assistant") continue;
      const total = entry.message.usage?.cost?.total;
      if (typeof total === "number" && Number.isFinite(total)) cost += total;
    }
  } catch {
    // API surface differs across pi builds; never throw from UI hooks.
  }
  return cost;
}

export default function dashboard(pi: ExtensionAPI) {
  let branch: string | null = null;
  let changedFiles = 0;
  let isRepo = false;
  let prLabel: string | null = null;
  let provider = "";
  let modelId = "no-model";
  let thinking = "off";
  let contextPercent: number | null = null;
  let contextWindow = 0;
  let cost = 0;
  let generating = false;
  let cwd = process.cwd();
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let ui: Ctx["ui"] | undefined;

  const paint = () => {
    if (!ui) return;

    const dir = formatDirectory(cwd);
    const git = isRepo
      ? prLabel
        ? `${branch ?? "?"} · ${changedFiles} changed · ${prLabel}`
        : `${branch ?? "?"} · ${changedFiles} changed`
      : "not a git repo";

    const pct =
      contextPercent === null || !Number.isFinite(contextPercent)
        ? "?"
        : `${Math.round(contextPercent)}`;
    const window = formatTokens(contextWindow);
    const model =
      provider && modelId
        ? `${provider}/${modelId} · ${thinking}`
        : modelId || "no-model";
    const gen = generating ? " · gen" : "";

    const footer = `${dir}  │  ${git}  │  ${model}${gen}  │  ${pct}%/${window} · $${cost.toFixed(2)}`;

    try {
      ui.setFooter?.(footer);
      ui.setStatus?.("dashboard", footer);
      ui.setTitle?.("pi");
      ui.setHeader?.("pi");
      // Compact banner via widget (multi-line header components are not supported).
      ui.setWidget?.("pi-banner", [
        "██████╗ ██╗",
        "██╔══██╗██║",
        "██████╔╝██║",
        "██╔═══╝ ██║",
        "██║     ██║",
        "╚═╝     ╚═╝",
      ]);
    } catch {
      // ignore UI hostcall failures in print/rpc modes
    }
  };

  const refreshGit = async (nextCwd: string) => {
    cwd = nextCwd || cwd;
    const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], cwd);
    if (inside !== "true") {
      isRepo = false;
      branch = null;
      changedFiles = 0;
      prLabel = null;
      return;
    }
    isRepo = true;
    branch =
      (await run("git", ["branch", "--show-current"], cwd)) ||
      (await run("git", ["rev-parse", "--short", "HEAD"], cwd)) ||
      null;
    const status = await run("git", ["status", "--porcelain"], cwd);
    changedFiles = status ? status.split("\n").filter(Boolean).length : 0;

    if (branch) {
      const prJson = await run(
        "gh",
        ["pr", "view", branch, "--json", "number,url,state,isDraft"],
        cwd,
        8_000,
      );
      if (prJson) {
        try {
          const pr = JSON.parse(prJson) as {
            number?: number;
            state?: string;
            isDraft?: boolean;
          };
          if (pr.state === "OPEN" && typeof pr.number === "number") {
            prLabel = pr.isDraft
              ? `PR #${pr.number} (draft)`
              : `PR #${pr.number}`;
          } else {
            prLabel = null;
          }
        } catch {
          prLabel = null;
        }
      } else {
        prLabel = null;
      }
    }
  };

  const refreshModel = (ctx: Ctx) => {
    try {
      const model = ctx.model;
      provider = model?.provider ?? provider;
      modelId = model?.id ?? modelId;
      if (model?.reasoning) {
        // thinking level is owned by the session; leave last known if unavailable
      }
      const usage = ctx.getContextUsage?.() ?? null;
      if (usage) {
        contextPercent =
          typeof usage.percent === "number" ? usage.percent : contextPercent;
        contextWindow =
          typeof usage.contextWindow === "number" && usage.contextWindow > 0
            ? usage.contextWindow
            : (model?.contextWindow ?? contextWindow);
      } else if (model?.contextWindow) {
        contextWindow = model.contextWindow;
      }
      cost = sessionCost(ctx);
    } catch {
      // never throw
    }
  };

  const bindUi = (ctx: Ctx) => {
    if (ctx.ui) ui = ctx.ui;
    if (ctx.cwd) cwd = ctx.cwd;
  };

  const startPoll = () => {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      void (async () => {
        try {
          await refreshGit(cwd);
          paint();
        } catch {
          // ignore
        }
      })();
    }, GIT_POLL_MS);
  };

  const stopPoll = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  };

  // session_start has a short host timeout (~500ms). Do not await git/network here.
  pi.on("session_start", (_event, ctx: Ctx) => {
    bindUi(ctx);
    generating = false;
    refreshModel(ctx);
    paint();
    startPoll();
    void refreshGit(ctx.cwd ?? cwd)
      .then(() => paint())
      .catch(() => {});
  });

  pi.on("session_shutdown", () => {
    stopPoll();
    ui = undefined;
  });

  pi.on("model_select", (event: { model?: Ctx["model"] }, ctx: Ctx) => {
    bindUi(ctx);
    if (event?.model) {
      provider = event.model.provider ?? provider;
      modelId = event.model.id ?? modelId;
      contextWindow = event.model.contextWindow ?? contextWindow;
    }
    refreshModel(ctx);
    paint();
  });

  pi.on("thinking_level_select", (event: { level?: string }, ctx: Ctx) => {
    bindUi(ctx);
    if (typeof event?.level === "string") thinking = event.level;
    paint();
  });

  pi.on("agent_start", (_event, ctx: Ctx) => {
    bindUi(ctx);
    generating = true;
    refreshModel(ctx);
    paint();
  });

  pi.on("agent_settled", (_event, ctx: Ctx) => {
    bindUi(ctx);
    generating = false;
    refreshModel(ctx);
    paint();
  });

  pi.on("turn_end", (_event, ctx: Ctx) => {
    bindUi(ctx);
    refreshModel(ctx);
    paint();
  });

  pi.on("message_end", (_event, ctx: Ctx) => {
    bindUi(ctx);
    refreshModel(ctx);
    paint();
  });

  pi.registerCommand("dashboard", {
    description: "Refresh the status footer (cwd · git · model · context)",
    handler: async (_args, ctx: Ctx) => {
      bindUi(ctx);
      await refreshGit(ctx.cwd ?? cwd);
      refreshModel(ctx);
      paint();
      ctx.ui?.notify?.("Dashboard refreshed", "info");
    },
  });
}
