import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SUMMARY_CONFIG, parseSummaryConfig } from "./src/config.ts";

test("summary config defaults to disabled Codex Luna at medium reasoning", () => {
  assert.deepEqual(parseSummaryConfig(undefined), DEFAULT_SUMMARY_CONFIG);
  assert.deepEqual(DEFAULT_SUMMARY_CONFIG, {
    enabled: false,
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    reasoning: "medium",
  });
});

test("summary config accepts valid private overrides and rejects partial corruption", () => {
  assert.deepEqual(
    parseSummaryConfig({
      enabled: false,
      provider: " anthropic ",
      model: " claude-sonnet ",
      reasoning: "high",
    }),
    {
      enabled: false,
      provider: "anthropic",
      model: "claude-sonnet",
      reasoning: "high",
    },
  );

  // Older configs without `enabled` stay on so existing users keep recaps.
  assert.deepEqual(
    parseSummaryConfig({
      provider: "anthropic",
      model: "claude-sonnet",
      reasoning: "high",
    }),
    {
      enabled: true,
      provider: "anthropic",
      model: "claude-sonnet",
      reasoning: "high",
    },
  );

  assert.deepEqual(
    parseSummaryConfig({ provider: "", model: 42, reasoning: "turbo" }),
    DEFAULT_SUMMARY_CONFIG,
  );
  assert.deepEqual(
    parseSummaryConfig({
      provider: "anthropic",
      model: 42,
      reasoning: "high",
    }),
    DEFAULT_SUMMARY_CONFIG,
  );
});
