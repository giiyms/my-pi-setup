# Pi TUI patch v4 — #7194 offscreen same-height fix

## The bug

When a **running tool card** (bash elapsed timer @ 1s, spinner) has scrolled **above the viewport**, its update still dirties a line with `firstChanged < viewportTop`. Stock Pi then calls `fullRender(true)` which clears the screen/scrollback and repaints — jump, lag, broken touch scroll.

See: GitHub issues **#7194**, **#5023**.

## v4 fix (safe)

```text
if firstChanged < viewportTop:
  if height unchanged:
    if no changes in viewport range:
      previousLines = newLines   # cache only — NO terminal write
      return
    else:
      paint from viewportTop     # differential, no full clear
  else:
    fullRender(true)             # original CSI 3J path — real layout shift
```

Also keeps:

- `Container.freeze()` for finished bubbles (CPU)
- footer signature cache
- stream paint coalesce ~33ms
- Loader interval 80ms → 200ms

## Explicitly NOT done (v2 regressions)

- Soft clear without `CSI 3J` (broke native/touch scrollback)
- Markdown head/tail layout split (height thrash)

## Apply

```bash
node ~/.pi/agent/patches/apply-tui-perf.mjs
```

Restart Pi (`/exit`, then `pi`).

## Debug

```bash
PI_DEBUG_REDRAW=1 pi
# ~/.pi/agent/pi-debug.log
# Elapsed-timer ticks should NOT spam firstChanged < viewportTop
```

## Uninstall

```bash
B=~/.pi/agent/patches/backups
ROOT=/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent
TUI=$ROOT/node_modules/@earendil-works/pi-tui/dist
cp "$B/tui.js.orig" "$TUI/tui.js"
cp "$B/loader.js.orig" "$TUI/components/loader.js"
cp "$B/markdown.js.orig" "$TUI/components/markdown.js"
cp "$B/assistant-message.js.orig" "$ROOT/dist/modes/interactive/components/assistant-message.js"
cp "$B/footer.js.orig" "$ROOT/dist/modes/interactive/components/footer.js"
cp "$B/interactive-mode.js.orig" "$ROOT/dist/modes/interactive/interactive-mode.js"
cp "$B/bash.js.orig" "$ROOT/dist/core/tools/bash.js"
```
