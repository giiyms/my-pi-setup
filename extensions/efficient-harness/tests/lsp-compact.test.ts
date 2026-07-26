import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCompactionPrompt } from "../lib/compaction.ts";
import { detectLanguage, formatDiagnostics } from "../lib/lsp-client.ts";

describe("lsp helpers", () => {
  it("detects languages", () => {
    assert.equal(detectLanguage("a.ts"), "typescript");
    assert.equal(detectLanguage("a.py"), "python");
    assert.equal(detectLanguage("a.rs"), "rust");
  });

  it("formats empty diagnostics", () => {
    const s = formatDiagnostics({
      path: "/tmp/a.ts",
      engine: "test",
      diagnostics: [],
    });
    assert.match(s, /no diagnostics/);
  });
});

describe("compaction prompt", () => {
  it("includes required sections guide", () => {
    const p = buildCompactionPrompt({
      conversationText: "hello",
      previousSummary: "old",
    });
    assert.match(p, /## Goal/);
    assert.match(p, /## Decisions/);
    assert.match(p, /Previous summary/);
    assert.match(p, /hello/);
  });
});
