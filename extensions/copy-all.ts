/**
 * PiJS-safe /copy-all — no @earendil-works runtime imports.
 * Uses macOS `pbcopy` (or wl-copy/xclip when present).
 * Async only: PiJS denies sync child_process by default.
 */
import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function textFromContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (!("type" in block)) return "";

      if (
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        return block.text;
      }

      if (block.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function execWithInput(cmd: string, args: string[], input: string) {
  return new Promise<boolean>((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
      (err) => resolve(!err),
    );
    child.stdin?.end(input);
  });
}

async function copyText(text: string) {
  if (await execWithInput("pbcopy", [], text)) return true;
  if (await execWithInput("wl-copy", [], text)) return true;
  if (await execWithInput("xclip", ["-selection", "clipboard"], text))
    return true;
  return false;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy-all", {
    description:
      "Copy all previous user and assistant messages in this thread to the clipboard",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle?.();

      const branch = ctx.sessionManager?.getBranch?.() ?? [];
      const sections = branch
        .filter((entry: { type?: string }) => entry.type === "message")
        .map((entry: { message?: { role?: string; content?: unknown } }) => entry.message)
        .filter(
          (message: { role?: string } | undefined) =>
            message && (message.role === "user" || message.role === "assistant"),
        )
        .map((message: { role?: string; content?: unknown }) => ({
          role: message.role,
          content: textFromContent(message.content).trim(),
        }))
        .filter(({ content }: { content: string }) => content)
        .map(
          ({ role, content }: { role?: string; content: string }) =>
            `${String(role).toUpperCase()}:\n${content}`,
        );

      if (sections.length === 0) {
        ctx.ui?.notify?.("No user or assistant messages to copy", "info");
        return;
      }

      const payload = sections.join("\n\n---\n\n");
      if (!(await copyText(payload))) {
        ctx.ui?.notify?.(
          "Clipboard helper not found (pbcopy / wl-copy / xclip)",
          "error",
        );
        return;
      }
      ctx.ui?.notify?.(`Copied ${sections.length} messages to clipboard`, "info");
    },
  });
}
