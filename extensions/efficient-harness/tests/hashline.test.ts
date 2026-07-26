import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyHashlineEdits,
  buildHashline,
  lineHash,
  parseAnchor,
  renderHashline,
} from "../lib/hashline.ts";

describe("lineHash", () => {
  it("is stable and 3 chars", () => {
    const h = lineHash("const x = 1;");
    assert.equal(h.length, 3);
    assert.equal(lineHash("const x = 1;"), h);
    assert.notEqual(lineHash("const x = 2;"), h);
  });

  it("is whitespace-sensitive", () => {
    assert.notEqual(lineHash("  foo"), lineHash("foo"));
  });
});

describe("parseAnchor", () => {
  it("parses line:hash", () => {
    const a = parseAnchor("12:aB3");
    assert.equal(a.line, 12);
    assert.equal(a.hash, "aB3");
  });
});

describe("applyHashlineEdits", () => {
  it("replaces a single line by anchor", () => {
    const src = ["function a() {", "  return 1;", "}"].join("\n");
    const file = buildHashline("t.ts", src);
    const start = `2:${file.hashes[1]}`;
    const r = applyHashlineEdits(src, [
      { op: "replace", start, text: "  return 2;" },
    ]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.content, ["function a() {", "  return 2;", "}"].join("\n"));
    }
  });

  it("rejects stale hash", () => {
    const src = "hello\nworld";
    const r = applyHashlineEdits(src, [
      { op: "replace", start: "1:XXX", text: "nope" },
    ]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Stale|expected hash/i);
  });

  it("insert_after and delete", () => {
    const src = ["a", "b", "c"].join("\n");
    const f = buildHashline("t", src);
    const r1 = applyHashlineEdits(src, [
      { op: "insert_after", start: `1:${f.hashes[0]}`, text: "x" },
    ]);
    assert.equal(r1.ok, true);
    if (!r1.ok) return;
    assert.equal(r1.content, ["a", "x", "b", "c"].join("\n"));

    const f2 = buildHashline("t", r1.content);
    const r2 = applyHashlineEdits(r1.content, [
      { op: "delete", start: `2:${f2.hashes[1]}` },
    ]);
    assert.equal(r2.ok, true);
    if (r2.ok) assert.equal(r2.content, ["a", "b", "c"].join("\n"));
  });

  it("rejects line-only anchors", () => {
    const src = "only";
    const r = applyHashlineEdits(src, [
      { op: "replace", start: "1", text: "x" },
    ]);
    assert.equal(r.ok, false);
  });
});

describe("renderHashline", () => {
  it("includes hashes", () => {
    const f = buildHashline("a.ts", "x\ny");
    const out = renderHashline(f);
    assert.match(out, /1:[A-Za-z0-9_-]{3}\|x/);
    assert.match(out, /2:[A-Za-z0-9_-]{3}\|y/);
  });
});
