/**
 * TUI Mode Toggle Extension
 *
 * Provides a /tui command to flip the `tuiMode` setting between
 * "regular" and "fullscreen". Fullscreen mode is only read at startup
 * (see docs/keybindings.md — "these actions apply when interactive mode
 * uses --tui-mode fullscreen"), and there is no public extension API to
 * swap the live renderer mid-session (that's private to InteractiveMode,
 * wired only to the built-in /settings dialog). So this writes straight
 * to settings.json via the same SettingsManager the CLI itself uses and
 * tells you to restart — it is not a live toggle.
 *
 * Usage:
 *   /tui          toggle
 *   /tui on       force fullscreen
 *   /tui off      force regular
 *   /tui status   show the current persisted value without changing it
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SettingsManager, type TuiMode } from "@earendil-works/pi-coding-agent";

const ARGS = ["on", "off", "status"] as const;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("tui", {
		description: "Toggle fullscreen TUI mode (takes effect on next pi restart)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = ARGS.map((value) => ({ value, label: value }));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const settings = SettingsManager.create(ctx.cwd);
			const current = settings.getTuiMode();
			const arg = args.trim().toLowerCase();

			if (arg === "status") {
				ctx.ui.notify(`TUI mode is "${current}".`, "info");
				return;
			}

			let next: TuiMode;
			if (arg === "on") {
				next = "fullscreen";
			} else if (arg === "off") {
				next = "regular";
			} else if (arg === "") {
				next = current === "fullscreen" ? "regular" : "fullscreen";
			} else {
				ctx.ui.notify(`Unknown argument "${args}". Use on, off, or status.`, "error");
				return;
			}

			if (next === current) {
				ctx.ui.notify(`TUI mode is already "${current}".`, "info");
				return;
			}

			settings.setTuiMode(next);
			await settings.flush();
			ctx.ui.notify(`TUI mode set to "${next}" — restart pi for it to take effect.`, "info");
		},
	});
}
