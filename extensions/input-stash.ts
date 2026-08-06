/**
 * Ctrl+S toggles editor input stash:
 * - non-empty editor → stash text and clear the editor
 * - empty editor + stash present → restore stash into the editor
 * - empty editor + empty stash → notify
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let stash: string | undefined;

  const toggle = (ctx: {
    ui: {
      getEditorText(): string;
      setEditorText(text: string): void;
      notify(message: string, type?: "info" | "warning" | "error"): void;
      setStatus?(key: string, text: string | undefined): void;
    };
    hasUI?: boolean;
  }) => {
    if (!ctx.hasUI && ctx.hasUI !== undefined) return;
    const current = ctx.ui.getEditorText();
    if (current.trim().length > 0) {
      stash = current;
      ctx.ui.setEditorText("");
      ctx.ui.setStatus?.("input-stash", "stash: saved · ctrl+s restore");
      ctx.ui.notify("Stashed editor input (ctrl+s to restore)", "info");
      return;
    }
    if (stash !== undefined && stash.length > 0) {
      ctx.ui.setEditorText(stash);
      stash = undefined;
      ctx.ui.setStatus?.("input-stash", undefined);
      ctx.ui.notify("Restored stashed input", "info");
      return;
    }
    ctx.ui.notify("Nothing to stash or restore", "warning");
  };

  pi.registerShortcut("ctrl+s", {
    description: "Stash or restore editor input",
    handler: async (ctx) => {
      toggle(ctx);
    },
  });

  pi.registerCommand("stash", {
    description: "Stash editor input (same as ctrl+s; empty restores)",
    handler: async (_args, ctx) => {
      toggle(ctx);
    },
  });
}
