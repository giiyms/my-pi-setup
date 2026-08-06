/**
 * Popup /hotkeys — replaces the built-in chat dump with a dismissible TUI panel.
 *
 * interactive-mode is patched to prefer this extension command over the stock
 * markdown dump when `/hotkeys` is registered.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";

type Row =
  | { kind: "header"; label: string }
  | { kind: "item"; keys: string; action: string };

function formatKeys(keys: string[]) {
  if (keys.length === 0) return "—";
  return keys
    .map((key) =>
      key
        .split("/")
        .map((chord) =>
          chord
            .split("+")
            .map((part) => {
              const display =
                process.platform === "darwin" && part.toLowerCase() === "alt"
                  ? "option"
                  : part;
              return display.charAt(0).toUpperCase() + display.slice(1);
            })
            .join("+"),
        )
        .join("/"),
    )
    .join(" / ");
}

function keyLabel(kb: KeybindingsManager, action: string) {
  try {
    return formatKeys(kb.getKeys(action));
  } catch {
    return "—";
  }
}

function buildRows(kb: KeybindingsManager): Row[] {
  const section = (
    label: string,
    items: Array<[string | string[], string]>,
  ): Row[] => [
    { kind: "header", label },
    ...items.map(([keys, action]) => ({
      kind: "item" as const,
      keys: Array.isArray(keys)
        ? keys.map((k) => keyLabel(kb, k)).join(" / ")
        : keys.startsWith("app.") || keys.startsWith("tui.")
          ? keyLabel(kb, keys)
          : keys,
      action,
    })),
  ];

  return [
    ...section("Navigation", [
      [
        [
          "tui.editor.cursorUp",
          "tui.editor.cursorDown",
          "tui.editor.cursorLeft",
          "tui.editor.cursorRight",
        ],
        "Move cursor / browse history",
      ],
      [
        ["tui.editor.cursorWordLeft", "tui.editor.cursorWordRight"],
        "Move by word",
      ],
      ["tui.editor.cursorLineStart", "Start of line"],
      ["tui.editor.cursorLineEnd", "End of line"],
      ["tui.editor.jumpForward", "Jump forward to character"],
      ["tui.editor.jumpBackward", "Jump backward to character"],
      [["tui.editor.pageUp", "tui.editor.pageDown"], "Scroll by page"],
    ]),
    ...section("Editing", [
      ["tui.input.submit", "Send message"],
      [
        "tui.input.newLine",
        process.platform === "win32"
          ? "New line (Ctrl+Enter on Windows Terminal)"
          : "New line",
      ],
      ["tui.editor.deleteWordBackward", "Delete word backwards"],
      ["tui.editor.deleteWordForward", "Delete word forwards"],
      ["tui.editor.deleteToLineStart", "Delete to start of line"],
      ["tui.editor.deleteToLineEnd", "Delete to end of line"],
      ["tui.editor.yank", "Paste most-recently-deleted text"],
      ["tui.editor.yankPop", "Cycle deleted text after pasting"],
      ["tui.editor.undo", "Undo"],
    ]),
    ...section("App", [
      ["tui.input.tab", "Path completion / accept autocomplete"],
      ["app.interrupt", "Cancel autocomplete / abort streaming"],
      ["app.clear", "Clear editor (first) / exit (second)"],
      ["app.exit", "Exit (when editor is empty)"],
      ["app.suspend", "Suspend to background"],
      ["app.thinking.cycle", "Cycle thinking level"],
      [["app.model.cycleForward", "app.model.cycleBackward"], "Cycle models"],
      ["app.model.select", "Open model selector"],
      ["app.tools.expand", "Toggle tool output expansion"],
      ["app.thinking.toggle", "Toggle thinking block visibility"],
      ["app.editor.external", "Edit message in external editor"],
      ["app.message.copy", "Copy last assistant message"],
      ["app.message.followUp", "Queue follow-up message"],
      ["app.message.dequeue", "Restore queued messages"],
      ["app.clipboard.pasteImage", "Paste image or text from clipboard"],
      ["/", "Slash commands"],
      ["!", "Run bash command"],
      ["!!", "Run bash command (excluded from context)"],
    ]),
  ];
}

export default function hotkeysPopup(pi: ExtensionAPI) {
  pi.registerCommand("hotkeys", {
    description: "Show keyboard shortcuts (popup)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("/hotkeys requires TUI mode", "error");
        return;
      }

      await ctx.ui.custom((tui, theme, keybindings, done) => {
        const rows = buildRows(keybindings);
        let offset = 0;
        let cachedWidth: number | undefined;
        let cachedLines: string[] | undefined;

        const color = (s: string) => theme.fg("accent", s);
        const topBorder = new DynamicBorder(color);
        const bottomBorder = new DynamicBorder(color);
        const container = new Container();

        const invalidate = () => {
          cachedWidth = undefined;
          cachedLines = undefined;
          container.invalidate();
        };

        const bodyHeight = () => Math.max(8, Math.min(22, rows.length));

        const rebuild = (width: number) => {
          const height = bodyHeight();
          const maxOffset = Math.max(0, rows.length - height);
          offset = Math.min(offset, maxOffset);

          container.clear();
          container.addChild(topBorder);
          container.addChild(
            new Text(
              theme.fg("accent", theme.bold(" Keyboard Shortcuts")),
              0,
              0,
            ),
          );
          container.addChild(new Text("", 0, 0));

          const visible = rows.slice(offset, offset + height);
          const keyCol = Math.min(
            28,
            Math.max(
              12,
              ...visible
                .filter(
                  (r): r is Extract<Row, { kind: "item" }> => r.kind === "item",
                )
                .map((r) => visibleWidth(r.keys)),
              12,
            ),
          );

          for (const row of visible) {
            if (row.kind === "header") {
              container.addChild(
                new Text(theme.fg("muted", theme.bold(` ${row.label}`)), 0, 0),
              );
              continue;
            }

            const keys = truncateToWidth(row.keys, keyCol);
            const pad = " ".repeat(
              Math.max(1, keyCol - visibleWidth(keys) + 2),
            );
            const action = truncateToWidth(
              row.action,
              Math.max(8, width - keyCol - 4),
            );
            container.addChild(
              new Text(
                ` ${theme.fg("accent", keys)}${pad}${theme.fg("text", action)}`,
                0,
                0,
              ),
            );
          }

          const scroll =
            rows.length > height
              ? theme.fg(
                  "dim",
                  `  ${offset + 1}–${Math.min(offset + height, rows.length)} of ${rows.length}`,
                )
              : "";
          container.addChild(new Text("", 0, 0));
          container.addChild(
            new Text(
              theme.fg("dim", " ↑↓/PgUp/PgDn scroll · Enter/Esc close") +
                scroll,
              0,
              0,
            ),
          );
          container.addChild(bottomBorder);
        };

        return {
          render(width: number) {
            if (cachedWidth === width && cachedLines) return cachedLines;
            rebuild(width);
            cachedWidth = width;
            cachedLines = container.render(width);
            return cachedLines;
          },
          invalidate,
          handleInput(data: string) {
            const height = bodyHeight();
            const maxOffset = Math.max(0, rows.length - height);

            if (
              matchesKey(data, "escape") ||
              matchesKey(data, "enter") ||
              matchesKey(data, "return")
            ) {
              done(undefined);
              return;
            }
            if (matchesKey(data, "up") || data === "k") {
              offset = Math.max(0, offset - 1);
              invalidate();
              tui.requestRender();
              return;
            }
            if (matchesKey(data, "down") || data === "j") {
              offset = Math.min(maxOffset, offset + 1);
              invalidate();
              tui.requestRender();
              return;
            }
            if (matchesKey(data, "pageup")) {
              offset = Math.max(0, offset - height);
              invalidate();
              tui.requestRender();
              return;
            }
            if (matchesKey(data, "pagedown")) {
              offset = Math.min(maxOffset, offset + height);
              invalidate();
              tui.requestRender();
            }
          },
        };
      });
    },
  });
}
