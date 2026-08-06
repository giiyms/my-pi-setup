#!/usr/bin/env node
/**
 * Pi TUI performance patch v4 — GitHub #7194 / #5023 style fix
 *
 * Root cause: offscreen same-height updates (bash elapsed timer @1s, Loader spinner)
 * set firstChanged < viewportTop → fullRender() → jump/lag/scrollback thrash.
 *
 * v4:
 * 1. TUI: same-height changes entirely above viewport → update cache only, NO terminal write
 *    (height changes still use original fullRender with CSI 3J — do NOT soft-clear)
 * 2. TUI: same-height changes that also touch viewport → paint from viewportTop (no full clear)
 * 3. Container.freeze() for finalized history (CPU)
 * 4. Footer cache + stream coalesce (CPU)
 * 5. Loader interval 80→200ms (fewer idle paints)
 * 6. bash tool elapsed invalidate still runs; TUI absorbs offscreen no-ops
 *
 * v2 mistake (reverted): soft-clear without 3J + markdown head/tail layout split.
 *
 * Usage: node ~/.pi/agent/patches/apply-tui-perf.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const MARKER = "/* pi-tui-perf-patch v4 */";
const require = createRequire(import.meta.url);
const BACKUP_DIR = path.join(os.homedir(), ".pi/agent/patches/backups");

function resolvePiPaths() {
	const candidates = [
		"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent",
		"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
		path.join(os.homedir(), ".npm-global/lib/node_modules/@earendil-works/pi-coding-agent"),
	];
	for (const root of candidates) {
		const tuiJs = path.join(root, "node_modules/@earendil-works/pi-tui/dist/tui.js");
		if (fs.existsSync(tuiJs)) {
			return {
				root,
				tuiJs,
				loaderJs: path.join(root, "node_modules/@earendil-works/pi-tui/dist/components/loader.js"),
				markdownJs: path.join(root, "node_modules/@earendil-works/pi-tui/dist/components/markdown.js"),
				assistantJs: path.join(root, "dist/modes/interactive/components/assistant-message.js"),
				footerJs: path.join(root, "dist/modes/interactive/components/footer.js"),
				interactiveJs: path.join(root, "dist/modes/interactive/interactive-mode.js"),
				bashJs: path.join(root, "dist/core/tools/bash.js"),
			};
		}
	}
	const pkg = require.resolve("@earendil-works/pi-coding-agent/package.json");
	const root = path.dirname(pkg);
	return {
		root,
		tuiJs: require.resolve("@earendil-works/pi-tui/dist/tui.js"),
		loaderJs: require.resolve("@earendil-works/pi-tui/dist/components/loader.js"),
		markdownJs: require.resolve("@earendil-works/pi-tui/dist/components/markdown.js"),
		assistantJs: path.join(root, "dist/modes/interactive/components/assistant-message.js"),
		footerJs: path.join(root, "dist/modes/interactive/components/footer.js"),
		interactiveJs: path.join(root, "dist/modes/interactive/interactive-mode.js"),
		bashJs: path.join(root, "dist/core/tools/bash.js"),
	};
}

function mustInclude(src, needle, label) {
	if (!src.includes(needle)) throw new Error(`Missing snippet (${label}): ${needle.slice(0, 120)}`);
}

function hasAnyPatch(src) {
	return /pi-tui-perf-patch/.test(src);
}

function prepareBaselines(paths) {
	fs.mkdirSync(BACKUP_DIR, { recursive: true });
	const map = [
		[paths.tuiJs, "tui.js.orig"],
		[paths.loaderJs, "loader.js.orig"],
		[paths.markdownJs, "markdown.js.orig"],
		[paths.assistantJs, "assistant-message.js.orig"],
		[paths.footerJs, "footer.js.orig"],
		[paths.interactiveJs, "interactive-mode.js.orig"],
		[paths.bashJs, "bash.js.orig"],
	];
	for (const [file, bak] of map) {
		if (!file || !fs.existsSync(file)) continue;
		const cur = fs.readFileSync(file, "utf8");
		const backupPath = path.join(BACKUP_DIR, bak);
		if (hasAnyPatch(cur)) {
			if (fs.existsSync(backupPath) && !hasAnyPatch(fs.readFileSync(backupPath, "utf8"))) {
				fs.copyFileSync(backupPath, file);
				console.log(`↺ restored: ${path.basename(file)}`);
			} else {
				throw new Error(`Patched ${path.basename(file)} but no pristine backup`);
			}
		} else if (!fs.existsSync(backupPath) || hasAnyPatch(fs.readFileSync(backupPath, "utf8"))) {
			fs.copyFileSync(file, backupPath);
			console.log(`💾 baseline: ${bak}`);
		}
	}
}

function patchTui(src) {
	if (src.includes(MARKER)) return { src, changed: false };

	// --- freeze on Container ---
	mustInclude(src, "export class Container {\n    children = [];", "Container");
	src = src.replace(
		`export class Container {
    children = [];
    addChild(component) {
        this.children.push(component);
    }
    removeChild(component) {
        const index = this.children.indexOf(component);
        if (index !== -1) {
            this.children.splice(index, 1);
        }
    }
    clear() {
        this.children = [];
    }
    invalidate() {
        for (const child of this.children) {
            child.invalidate?.();
        }
    }
    render(width) {
        const lines = [];
        for (const child of this.children) {
            const childLines = child.render(width);
            for (const line of childLines) {
                lines.push(line);
            }
        }
        return lines;
    }
}`,
		`export class Container {
    children = [];
    ${MARKER}
    _frozen = false;
    _frozenLines;
    _frozenWidth;
    addChild(component) {
        this.children.push(component);
        this._frozenLines = undefined;
        this._frozenWidth = undefined;
    }
    removeChild(component) {
        const index = this.children.indexOf(component);
        if (index !== -1) {
            this.children.splice(index, 1);
            this._frozenLines = undefined;
            this._frozenWidth = undefined;
        }
    }
    clear() {
        this.children = [];
        this._frozenLines = undefined;
        this._frozenWidth = undefined;
    }
    freeze() {
        this._frozen = true;
        this._frozenLines = undefined;
        this._frozenWidth = undefined;
        for (const child of this.children) {
            child.freeze?.();
        }
    }
    unfreeze() {
        this._frozen = false;
        this._frozenLines = undefined;
        this._frozenWidth = undefined;
        for (const child of this.children) {
            child.unfreeze?.();
        }
    }
    invalidate() {
        this._frozenLines = undefined;
        this._frozenWidth = undefined;
        for (const child of this.children) {
            child.invalidate?.();
        }
    }
    render(width) {
        if (this._frozen && this._frozenLines && this._frozenWidth === width) {
            return this._frozenLines;
        }
        const lines = [];
        for (const child of this.children) {
            const childLines = child.render(width);
            for (const line of childLines) {
                lines.push(line);
            }
        }
        if (this._frozen) {
            this._frozenLines = lines;
            this._frozenWidth = width;
        }
        return lines;
    }
}`,
	);

	// --- #7194: offscreen same-height → cache only; never soft-clear ---
	mustInclude(src, "if (firstChanged < prevViewportTop) {\n            logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);\n            fullRender(true);\n            return;\n        }", "viewport storm");

	src = src.replace(
		`// Differential rendering can only touch what was actually visible.
        // If the first changed line is above the previous viewport, we need a full redraw.
        if (firstChanged < prevViewportTop) {
            logRedraw(\`firstChanged < viewportTop (\${firstChanged} < \${prevViewportTop})\`);
            fullRender(true);
            return;
        }`,
		`// Differential rendering can only touch what was actually visible.
        // ${MARKER} / #7194:
        // - Same-height edits entirely above the viewport (spinner, elapsed timer):
        //   update previousLines only — do NOT fullRender (that causes jump/lag).
        // - Same-height edits that also touch the viewport: paint from viewportTop.
        // - Height/layout shifts above the viewport: original fullRender(true) with 3J.
        if (firstChanged < prevViewportTop) {
            const heightDelta = newLines.length - this.previousLines.length;
            if (heightDelta === 0) {
                let fc = -1;
                let lc = -1;
                for (let i = prevViewportTop; i < maxLines; i++) {
                    const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
                    const newLine = i < newLines.length ? newLines[i] : "";
                    if (oldLine !== newLine) {
                        if (fc === -1)
                            fc = i;
                        lc = i;
                    }
                }
                if (fc === -1) {
                    // Offscreen-only, geometry-stable (bash elapsed / spinner). No terminal I/O.
                    this.positionHardwareCursor(cursorPos, newLines.length);
                    this.previousLines = newLines;
                    this.previousKittyImageIds = this.collectKittyImageIds(newLines);
                    this.previousWidth = width;
                    this.previousHeight = height;
                    this.previousViewportTop = prevViewportTop;
                    return;
                }
                // Viewport still needs a paint, but history geometry is stable — no full clear.
                firstChanged = fc;
                lastChanged = lc;
            }
            else {
                logRedraw(\`firstChanged < viewportTop (\${firstChanged} < \${prevViewportTop}, dH=\${heightDelta})\`);
                fullRender(true);
                return;
            }
        }`,
	);

	// Guards
	if (!src.includes('\\x1b[2J\\x1b[H\\x1b[3J')) {
		throw new Error("lost original full-clear sequence");
	}
	if (src.includes("wipeScrollback")) {
		throw new Error("unsafe soft-clear flag present");
	}
	if (!src.includes(MARKER)) throw new Error("tui marker missing");
	return { src, changed: true };
}

function patchLoader(src) {
	if (src.includes(MARKER)) return { src, changed: false };
	mustInclude(src, "const DEFAULT_INTERVAL_MS = 80;", "loader interval");
	// Fewer animation paints (still smooth enough); offscreen ones are no-ops in TUI now.
	src = src.replace(
		"const DEFAULT_INTERVAL_MS = 80;",
		`const DEFAULT_INTERVAL_MS = 200;\n${MARKER}`,
	);
	return { src, changed: true };
}

function patchMarkdown(src) {
	// intentionally untouched
	if (src.includes("headCacheKey") || src.includes("splitMarkdownBlocks")) {
		throw new Error("markdown still has unsafe v2 layout cache");
	}
	return { src, changed: false };
}

function patchAssistant(src) {
	if (src.includes(MARKER)) return { src, changed: false };
	mustInclude(src, "export class AssistantMessageComponent extends Container {", "assistant");

	src = src.replace(
		`export class AssistantMessageComponent extends Container {
    contentContainer;
    hideThinkingBlock;
    markdownTheme;
    hiddenThinkingLabel;
    outputPad;
    lastMessage;
    hasToolCalls = false;
    lastSignature;
    lastParts;`,
		`export class AssistantMessageComponent extends Container {
    contentContainer;
    hideThinkingBlock;
    markdownTheme;
    hiddenThinkingLabel;
    outputPad;
    lastMessage;
    hasToolCalls = false;
    lastSignature;
    lastParts;
    ${MARKER}
    _assistFrozenLines;
    _assistFrozenWidth;`,
	);

	src = src.replace(
		`invalidate() {
        super.invalidate();
        if (this.lastMessage) {
            this.updateContent(this.lastMessage);
        }
    }`,
		`invalidate() {
        this._assistFrozenLines = undefined;
        this._assistFrozenWidth = undefined;
        super.invalidate();
        if (this.lastMessage) {
            this.updateContent(this.lastMessage);
        }
    }
    freeze() {
        this._assistFrozenLines = undefined;
        this._assistFrozenWidth = undefined;
        super.freeze();
    }`,
	);

	src = src.replace(
		`render(width) {
        const lines = super.render(width);
        if (this.hasToolCalls || lines.length === 0) {
            return lines;
        }
        lines[0] = OSC133_ZONE_START + lines[0];
        lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
        return lines;
    }
    updateContent(message) {
        this.lastMessage = message;`,
		`render(width) {
        if (this._frozen && this._assistFrozenLines && this._assistFrozenWidth === width) {
            return this._assistFrozenLines;
        }
        const lines = super.render(width);
        let out = lines;
        if (!(this.hasToolCalls || lines.length === 0)) {
            out = lines.slice();
            out[0] = OSC133_ZONE_START + out[0];
            out[out.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + out[out.length - 1];
        }
        if (this._frozen) {
            this._assistFrozenLines = out;
            this._assistFrozenWidth = width;
        }
        return out;
    }
    updateContent(message) {
        this._assistFrozenLines = undefined;
        this._assistFrozenWidth = undefined;
        this.lastMessage = message;`,
	);

	return { src, changed: true };
}

function patchFooter(src) {
	if (src.includes(MARKER)) return { src, changed: false };
	mustInclude(src, "export class FooterComponent {", "footer");

	src = src.replace(
		`export class FooterComponent {
    autoCompactEnabled = true;
    session;
    footerData;
    constructor(session, footerData) {
        this.session = session;
        this.footerData = footerData;
    }`,
		`export class FooterComponent {
    autoCompactEnabled = true;
    session;
    footerData;
    ${MARKER}
    _cacheSig;
    _cacheWidth;
    _cacheLines;
    constructor(session, footerData) {
        this.session = session;
        this.footerData = footerData;
    }`,
	);

	src = src.replace(
		`invalidate() {
        // No-op: git branch is cached/invalidated by provider
    }`,
		`invalidate() {
        this._cacheSig = undefined;
        this._cacheWidth = undefined;
        this._cacheLines = undefined;
    }`,
	);

	src = src.replace(
		`render(width) {
        const state = this.session.state;
        // Calculate cumulative usage from ALL session entries (not just post-compaction messages)
        const usageTotals = createUsageTotals();
        let latestCacheHitRate;
        for (const entry of this.session.sessionManager.getEntries()) {`,
		`render(width) {
        const state = this.session.state;
        const entries = this.session.sessionManager.getEntries();
        const branch = this.footerData.getGitBranch();
        const sessionName = this.session.sessionManager.getSessionName();
        const contextUsage = this.session.getContextUsage();
        const extensionStatuses = this.footerData.getExtensionStatuses();
        let extSig = "";
        if (extensionStatuses.size > 0) {
            extSig = Array.from(extensionStatuses.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => k + "=" + v)
                .join("|");
        }
        const last = entries.length ? entries[entries.length - 1] : undefined;
        const lastId = last?.id ?? last?.type ?? entries.length;
        const sig = [
            width,
            entries.length,
            lastId,
            state.model?.id,
            state.model?.provider,
            state.thinkingLevel,
            this.autoCompactEnabled,
            branch,
            sessionName,
            contextUsage?.percent,
            contextUsage?.contextWindow,
            this.footerData.getAvailableProviderCount(),
            extSig,
            this.session.sessionManager.getCwd(),
        ].join("\\x1e");
        if (this._cacheLines && this._cacheSig === sig && this._cacheWidth === width) {
            return this._cacheLines;
        }
        const usageTotals = createUsageTotals();
        let latestCacheHitRate;
        for (const entry of entries) {`,
	);

	src = src.replace(
		`// Calculate context usage from session (handles compaction correctly).
        // After compaction, tokens are unknown until the next LLM response.
        const contextUsage = this.session.getContextUsage();
        const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;`,
		`// Calculate context usage from session (handles compaction correctly).
        // After compaction, tokens are unknown until the next LLM response.
        const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;`,
	);

	src = src.replace(
		`// Add git branch if available
        const branch = this.footerData.getGitBranch();
        if (branch) {
            pwd = \`\${pwd} (\${branch})\`;
        }
        // Add session name if set
        const sessionName = this.session.sessionManager.getSessionName();
        if (sessionName) {
            pwd = \`\${pwd} • \${sessionName}\`;
        }`,
		`// Add git branch if available
        if (branch) {
            pwd = \`\${pwd} (\${branch})\`;
        }
        // Add session name if set
        if (sessionName) {
            pwd = \`\${pwd} • \${sessionName}\`;
        }`,
	);

	src = src.replace(
		`// Add extension statuses on a single line, sorted by key alphabetically
        const extensionStatuses = this.footerData.getExtensionStatuses();
        if (extensionStatuses.size > 0) {
            const sortedStatuses = Array.from(extensionStatuses.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([, text]) => sanitizeStatusText(text));
            const statusLine = sortedStatuses.join(" ");
            // Truncate to terminal width with dim ellipsis for consistency with footer style
            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
        }
        return lines;
    }
}`,
		`// Add extension statuses on a single line, sorted by key alphabetically
        if (extensionStatuses.size > 0) {
            const sortedStatuses = Array.from(extensionStatuses.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([, text]) => sanitizeStatusText(text));
            const statusLine = sortedStatuses.join(" ");
            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
        }
        this._cacheSig = sig;
        this._cacheWidth = width;
        this._cacheLines = lines;
        return lines;
    }
}`,
	);

	return { src, changed: true };
}

function patchInteractive(src) {
	if (src.includes(MARKER)) return { src, changed: false };
	mustInclude(src, 'case "message_update":', "message_update");

	src = src.replace(
		`streamingComponent = undefined;
    streamingMessage = undefined;`,
		`streamingComponent = undefined;
    streamingMessage = undefined;
    ${MARKER}
    _streamRenderTimer = undefined;
    _streamRenderQueued = false;
    _lastStreamRenderAt = 0;
    static STREAM_RENDER_INTERVAL_MS = 33;`,
	);

	src = src.replace(
		`async handleEvent(event) {
        if (!this.isInitialized) {
            await this.init();
        }
        this.footer.invalidate();
        switch (event.type) {`,
		`requestStreamRender() {
        if (this._streamRenderQueued)
            return;
        this._streamRenderQueued = true;
        const elapsed = Date.now() - this._lastStreamRenderAt;
        const delay = Math.max(0, (this.constructor.STREAM_RENDER_INTERVAL_MS ?? 33) - elapsed);
        if (this._streamRenderTimer)
            clearTimeout(this._streamRenderTimer);
        this._streamRenderTimer = setTimeout(() => {
            this._streamRenderTimer = undefined;
            this._streamRenderQueued = false;
            this._lastStreamRenderAt = Date.now();
            this.ui.requestRender();
        }, delay);
    }
    flushStreamRender() {
        if (this._streamRenderTimer) {
            clearTimeout(this._streamRenderTimer);
            this._streamRenderTimer = undefined;
        }
        this._streamRenderQueued = false;
        this._lastStreamRenderAt = Date.now();
        this.ui.requestRender();
    }
    freezeChatChild(component) {
        try {
            component?.freeze?.();
        }
        catch {
            // ignore
        }
    }
    async handleEvent(event) {
        if (!this.isInitialized) {
            await this.init();
        }
        switch (event.type) {`,
	);

	src = src.replace(
		`else if (event.message.role === "user") {
                    this.addMessageToChat(event.message);
                    this.updatePendingMessagesDisplay();
                    this.ui.requestRender();
                }`,
		`else if (event.message.role === "user") {
                    const before = this.chatContainer.children.length;
                    this.addMessageToChat(event.message);
                    for (let i = before; i < this.chatContainer.children.length; i++) {
                        this.freezeChatChild(this.chatContainer.children[i]);
                    }
                    this.updatePendingMessagesDisplay();
                    this.ui.requestRender();
                }`,
	);

	src = src.replace(
		`this.ui.requestRender();
                }
                break;
            case "message_end":`,
		`this.requestStreamRender();
                }
                break;
            case "message_end":`,
	);

	src = src.replace(
		`this.streamingComponent = undefined;
                    this.streamingMessage = undefined;
                    this.footer.invalidate();
                }
                this.ui.requestRender();
                break;
            case "bash_execution_update":`,
		`this.freezeChatChild(this.streamingComponent);
                    this.streamingComponent = undefined;
                    this.streamingMessage = undefined;
                    this.footer.invalidate();
                }
                this.flushStreamRender();
                break;
            case "bash_execution_update":`,
	);

	src = src.replace(
		`case "tool_execution_update": {
                const component = this.pendingTools.get(event.toolCallId);
                if (component) {
                    component.updateResult({ ...event.partialResult, isError: false }, true);
                    this.ui.requestRender();
                }
                break;
            }
            case "tool_execution_end": {
                const component = this.pendingTools.get(event.toolCallId);
                if (component) {
                    component.updateResult({ ...event.result, isError: event.isError });
                    this.pendingTools.delete(event.toolCallId);
                    this.ui.requestRender();
                }
                break;
            }`,
		`case "tool_execution_update": {
                const component = this.pendingTools.get(event.toolCallId);
                if (component) {
                    component.updateResult({ ...event.partialResult, isError: false }, true);
                    this.requestStreamRender();
                }
                break;
            }
            case "tool_execution_end": {
                const component = this.pendingTools.get(event.toolCallId);
                if (component) {
                    component.updateResult({ ...event.result, isError: event.isError });
                    this.pendingTools.delete(event.toolCallId);
                    this.freezeChatChild(component);
                    this.flushStreamRender();
                }
                break;
            }`,
	);

	const mu = src.indexOf('case "message_update":');
	const me = src.indexOf('case "message_end":');
	if (mu < 0 || me < mu || !src.slice(mu, me).includes("requestStreamRender")) {
		throw new Error("message_update throttle missing");
	}
	return { src, changed: true };
}

function patchBash(src) {
	if (src.includes(MARKER)) return { src, changed: false };
	// Keep 1s elapsed updates — TUI now no-ops them when offscreen.
	// Annotate so we know v4 is aware of this path.
	mustInclude(src, "state.interval = setInterval(() => context.invalidate(), 1000);", "bash elapsed");
	src = src.replace(
		"state.interval = setInterval(() => context.invalidate(), 1000);",
		`// ${MARKER}: elapsed timer; offscreen same-height updates are cache-only in tui.js (#7194)
                state.interval = setInterval(() => context.invalidate(), 1000);`,
	);
	return { src, changed: true };
}

function nodeCheck(file) {
	const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`syntax: ${r.stderr || r.stdout}`);
}

function main() {
	const paths = resolvePiPaths();
	console.log(`Pi root: ${paths.root}`);
	prepareBaselines(paths);

	const jobs = [
		[paths.tuiJs, patchTui],
		[paths.loaderJs, patchLoader],
		[paths.markdownJs, patchMarkdown],
		[paths.assistantJs, patchAssistant],
		[paths.footerJs, patchFooter],
		[paths.interactiveJs, patchInteractive],
		[paths.bashJs, patchBash],
	];

	let failed = false;
	for (const [file, fn] of jobs) {
		if (!file || !fs.existsSync(file)) {
			if (file) console.error(`missing: ${file}`);
			continue;
		}
		try {
			const prev = fs.readFileSync(file, "utf8");
			const { src, changed } = fn(prev);
			if (changed) {
				fs.writeFileSync(file, src);
				console.log(`✓ ${path.basename(file)}`);
			} else {
				console.log(`= ${path.basename(file)}`);
			}
			nodeCheck(file);
		} catch (err) {
			console.error(`✗ ${path.basename(file)}: ${err.message}`);
			failed = true;
		}
	}

	const tui = fs.readFileSync(paths.tuiJs, "utf8");
	if (!tui.includes("Offscreen-only, geometry-stable")) {
		console.error("✗ #7194 cache-only path missing");
		failed = true;
	}
	if (!tui.includes("\\x1b[2J\\x1b[H\\x1b[3J")) {
		console.error("✗ full clear sequence missing");
		failed = true;
	}
	if (tui.includes("wipeScrollback")) {
		console.error("✗ soft-clear present");
		failed = true;
	}
	const md = fs.readFileSync(paths.markdownJs, "utf8");
	if (md.includes("headCacheKey")) {
		console.error("✗ markdown v2 cache present");
		failed = true;
	}

	if (failed) {
		process.exitCode = 1;
		return;
	}

	console.log(`
v4 applied (#7194 offscreen same-height = no paint).

Restart Pi:
  /exit
  pi

Debug full redraws:
  PI_DEBUG_REDRAW=1 pi
  # should NOT log firstChanged < viewportTop for elapsed-timer ticks

Uninstall:
  cp ~/.pi/agent/patches/backups/*.orig to matching paths
`);
}

main();
