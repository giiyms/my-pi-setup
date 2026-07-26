import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAdvisorPrompt,
  formatAdvisorInjection,
  parseAdvisorResponse,
} from "../lib/advisor.ts";
import { compressText } from "../lib/compress.ts";
import { shouldSummarize, summarizeSource } from "../lib/summarize.ts";

describe("compressText", () => {
  it("leaves small text alone", () => {
    const r = compressText("hello");
    assert.equal(r.compressed, false);
    assert.equal(r.text, "hello");
  });

  it("compresses huge text", () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const r = compressText(big, { maxChars: 500, headLines: 10, tailLines: 5 });
    assert.equal(r.compressed, true);
    assert.match(r.text, /omitted|compressed/i);
  });
});

describe("summarize", () => {
  it("flags large files", () => {
    assert.equal(shouldSummarize(50, 1000, false), false);
    assert.equal(shouldSummarize(250, 1000, false), true);
    assert.equal(shouldSummarize(250, 1000, true), false);
  });

  it("extracts structural hits", () => {
    const src = ["const a = 1;", "function foo() {}", "class Bar {}", "  x"].join(
      "\n",
    );
    const s = summarizeSource("t.ts", src);
    assert.match(s, /function foo/);
    assert.match(s, /class Bar/);
  });
});

describe("advisor parse", () => {
  it("parses JSON notes", () => {
    const notes = parseAdvisorResponse(
      `{"notes":[{"severity":"concern","text":"Missed null check"}]}`,
    );
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.severity, "concern");
  });

  it("formats injection", () => {
    const t = formatAdvisorInjection([
      { severity: "blocker", text: "Tests failing" },
    ]);
    assert.match(t, /blocker/);
    assert.match(t, /Tests failing/);
  });

  it("builds prompt", () => {
    const p = buildAdvisorPrompt({
      userGoal: "fix bug",
      assistantText: "I edited foo",
      toolSummary: "edit(...)",
    });
    assert.match(p, /STRICT JSON/);
  });
});
