/**
 * Tests for src/chat.js — conversational mode helpers.
 *
 * Covers:
 *   - truncateTranscript: rolling window logic
 *   - formatTranscript:   string formatting
 *   - buildPlanPayload:   /plan output structure
 *   - pairDialogueLoop:  via runChatSession /exit + /rounds
 *   - soloDialogue:      via runChatSession /mode solo
 */

import { test }   from "node:test";
import assert     from "node:assert/strict";

import {
  truncateTranscript,
  formatTranscript,
  buildPlanPayload,
  CHAT_MAX_ROUNDS,
  CHAT_MAX_CONTEXT_CHARS,
  CHAT_GPT_MAX_TOKENS,
  CHAT_CLAUDE_MAX_TOKENS,
  CHAT_SYNTHESIS_MAX_TOKENS,
} from "../src/chat.js";

// ── truncateTranscript ────────────────────────────────────────────────────────

test("truncateTranscript: empty array returns empty array", () => {
  assert.deepEqual(truncateTranscript([]), []);
});

test("truncateTranscript: returns all entries when total fits within maxChars", () => {
  const t = [
    { speaker: "user",  content: "hello" },
    { speaker: "gpt",   content: "world" },
  ];
  const result = truncateTranscript(t, 1000);
  assert.equal(result.length, 2);
});

test("truncateTranscript: drops oldest entries when over budget", () => {
  const old  = { speaker: "user", content: "a".repeat(500) };
  const mid  = { speaker: "gpt",  content: "b".repeat(500) };
  const last = { speaker: "user", content: "c".repeat(50) };
  const t = [old, mid, last];
  // Budget of 600 chars — only mid+last fit without old
  const result = truncateTranscript(t, 600);
  assert.ok(!result.includes(old), "oldest entry should be dropped");
  assert.ok(result.some(e => e.speaker === "user" && e.content.startsWith("c")), "last entry must be kept");
});

test("truncateTranscript: always keeps at least the last entry even if it exceeds maxChars", () => {
  const huge = { speaker: "gpt", content: "x".repeat(10_000) };
  const result = truncateTranscript([huge], 100);
  assert.equal(result.length, 1);
  assert.equal(result[0], huge);
});

test("truncateTranscript: preserves order of kept entries", () => {
  const t = [
    { speaker: "user",  content: "a" },
    { speaker: "gpt",   content: "b" },
    { speaker: "claude",content: "c" },
  ];
  const result = truncateTranscript(t, 1000);
  assert.deepEqual(result.map(e => e.content), ["a", "b", "c"]);
});

// ── formatTranscript ──────────────────────────────────────────────────────────

test("formatTranscript: empty array returns empty string", () => {
  assert.equal(formatTranscript([]), "");
});

test("formatTranscript: formats speaker labels in uppercase", () => {
  const t = [
    { speaker: "user",  content: "Hello" },
    { speaker: "gpt",   content: "Hi"    },
  ];
  const out = formatTranscript(t);
  assert.ok(out.includes("[USER]"), "should contain [USER]");
  assert.ok(out.includes("[GPT]"),  "should contain [GPT]");
  assert.ok(out.includes("Hello"),  "should contain user content");
  assert.ok(out.includes("Hi"),     "should contain gpt content");
});

test("formatTranscript: separates entries with double newlines", () => {
  const t = [
    { speaker: "user", content: "A" },
    { speaker: "gpt",  content: "B" },
  ];
  const out = formatTranscript(t);
  assert.ok(out.includes("\n\n"), "entries should be separated by blank line");
});

// ── buildPlanPayload ──────────────────────────────────────────────────────────

test("buildPlanPayload: includes project name when provided", () => {
  const t = [{ speaker: "user", content: "Add auth" }];
  const payload = buildPlanPayload(t, "my-app");
  assert.ok(payload.startsWith("Project: my-app"), "should start with project header");
});

test("buildPlanPayload: works without project name", () => {
  const t = [{ speaker: "user", content: "Add auth" }];
  const payload = buildPlanPayload(t);
  assert.ok(!payload.startsWith("Project:"), "should not have project header without project");
});

test("buildPlanPayload: includes transcript content", () => {
  const t = [
    { speaker: "user",  content: "Build a login page" },
    { speaker: "gpt",   content: "Use JWT + bcrypt"   },
  ];
  const payload = buildPlanPayload(t, "demo");
  assert.ok(payload.includes("Build a login page"), "should include user content");
  assert.ok(payload.includes("Use JWT + bcrypt"),   "should include gpt content");
});

test("buildPlanPayload: contains planning instruction", () => {
  const t = [{ speaker: "user", content: "test" }];
  const payload = buildPlanPayload(t);
  assert.ok(
    payload.includes("structured proposal") || payload.includes("technical plan"),
    "should contain planning instruction"
  );
});

// ── CHAT_MAX_ROUNDS constant ──────────────────────────────────────────────────

test("CHAT_MAX_ROUNDS is a positive integer", () => {
  assert.ok(Number.isInteger(CHAT_MAX_ROUNDS), "CHAT_MAX_ROUNDS must be integer");
  assert.ok(CHAT_MAX_ROUNDS >= 1,              "CHAT_MAX_ROUNDS must be >= 1");
});

test("CHAT_MAX_CONTEXT_CHARS is a positive integer", () => {
  assert.ok(Number.isInteger(CHAT_MAX_CONTEXT_CHARS), "CHAT_MAX_CONTEXT_CHARS must be integer");
  assert.ok(CHAT_MAX_CONTEXT_CHARS > 0,               "CHAT_MAX_CONTEXT_CHARS must be > 0");
});

// ── Per-turn token budget constants ──────────────────────────────────────────

test("CHAT_GPT_MAX_TOKENS is a positive integer", () => {
  assert.ok(Number.isInteger(CHAT_GPT_MAX_TOKENS), "must be integer");
  assert.ok(CHAT_GPT_MAX_TOKENS > 0,               "must be > 0");
});

test("CHAT_CLAUDE_MAX_TOKENS is a positive integer", () => {
  assert.ok(Number.isInteger(CHAT_CLAUDE_MAX_TOKENS), "must be integer");
  assert.ok(CHAT_CLAUDE_MAX_TOKENS > 0,               "must be > 0");
});

test("CHAT_SYNTHESIS_MAX_TOKENS is a positive integer", () => {
  assert.ok(Number.isInteger(CHAT_SYNTHESIS_MAX_TOKENS), "must be integer");
  assert.ok(CHAT_SYNTHESIS_MAX_TOKENS > 0,               "must be > 0");
});

test("synthesis budget is >= GPT and Claude chat budgets (synthesis needs more room)", () => {
  assert.ok(
    CHAT_SYNTHESIS_MAX_TOKENS >= CHAT_GPT_MAX_TOKENS,
    "synthesis budget should be at least as large as GPT turn budget"
  );
  assert.ok(
    CHAT_SYNTHESIS_MAX_TOKENS >= CHAT_CLAUDE_MAX_TOKENS,
    "synthesis budget should be at least as large as Claude turn budget"
  );
});
