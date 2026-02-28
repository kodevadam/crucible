/**
 * Unit tests for src/models.js
 *
 * All tests use synthetic model lists — no live API calls.
 * Covers: tier selection, created-missing fallback, latest-alias preference,
 *         mini/nano/preview exclusion, empty/null lists, cross-family safety.
 */

import { test }  from "node:test";
import assert    from "node:assert/strict";

import {
  selectBestGPTModel,
  selectBestClaudeModel,
  OPENAI_FALLBACK,
  CLAUDE_FALLBACK,
  EXCLUDE,
  PRIORITY,
} from "../src/models.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal OpenAI model object. created defaults to 1 (present). */
function gpt(id, created = 1) { return { id, created }; }

/** Build a minimal Anthropic model object. created_at defaults to a real ISO date. */
function claude(id, created_at = "2024-01-01T00:00:00Z") { return { id, created_at }; }

// ── EXCLUDE / PRIORITY sanity ─────────────────────────────────────────────────

test("EXCLUDE: filters mini", () => {
  assert.ok(EXCLUDE.test("gpt-4o-mini"));
});

test("EXCLUDE: filters nano", () => {
  assert.ok(EXCLUDE.test("gpt-4-nano"));
});

test("EXCLUDE: filters preview", () => {
  assert.ok(EXCLUDE.test("gpt-4.5-preview"));
});

test("EXCLUDE: does not filter gpt-4o", () => {
  assert.ok(!EXCLUDE.test("gpt-4o"));
});

test("EXCLUDE: does not filter gpt-4o-2024-11-20", () => {
  assert.ok(!EXCLUDE.test("gpt-4o-2024-11-20"));
});

test("PRIORITY tier 3 (gpt-4o) does not match gpt-4o-mini even without EXCLUDE", () => {
  // The tier pattern itself is /^gpt-4o/ which DOES match gpt-4o-mini,
  // so this confirms EXCLUDE is the defence — document the dependency.
  // (selectBestGPTModel applies EXCLUDE before tier matching.)
  const miniOnly = [gpt("gpt-4o-mini", 9999)];
  assert.equal(selectBestGPTModel(miniOnly), null,
    "gpt-4o-mini must not be returned from the gpt-4o tier");
});

test("PRIORITY last tier does not match gpt-4o", () => {
  // /^gpt-4(?!o|\.)/ must NOT match gpt-4o
  assert.ok(!PRIORITY[3].test("gpt-4o"));
});

test("PRIORITY last tier does not match gpt-4.5", () => {
  assert.ok(!PRIORITY[3].test("gpt-4.5"));
});

test("PRIORITY last tier matches gpt-4-turbo", () => {
  assert.ok(PRIORITY[3].test("gpt-4-turbo"));
});

test("PRIORITY last tier matches plain gpt-4", () => {
  assert.ok(PRIORITY[3].test("gpt-4"));
});

// ── selectBestGPTModel ────────────────────────────────────────────────────────

test("returns null for empty list", () => {
  assert.equal(selectBestGPTModel([]), null);
});

test("returns null for null input", () => {
  assert.equal(selectBestGPTModel(null), null);
});

test("returns null when all models are excluded", () => {
  assert.equal(selectBestGPTModel([gpt("gpt-4o-mini"), gpt("gpt-4o-preview")]), null);
});

test("picks gpt-5 over gpt-4o when both available", () => {
  const models = [gpt("gpt-4o", 100), gpt("gpt-5", 200)];
  assert.equal(selectBestGPTModel(models), "gpt-5");
});

test("picks gpt-4.5 over gpt-4o when both available", () => {
  const models = [gpt("gpt-4o", 100), gpt("gpt-4.5", 90)];
  assert.equal(selectBestGPTModel(models), "gpt-4.5");
});

test("falls through to gpt-4o tier when gpt-5 / gpt-4.5 absent", () => {
  const models = [gpt("gpt-4o-2024-11-20", 500), gpt("gpt-4-turbo", 200)];
  assert.equal(selectBestGPTModel(models), "gpt-4o-2024-11-20");
});

test("falls through to gpt-4 tier when higher tiers absent", () => {
  const models = [gpt("gpt-4-turbo", 300), gpt("gpt-4-32k", 100)];
  assert.equal(selectBestGPTModel(models), "gpt-4-turbo");
});

test("prefers newer created timestamp within same tier", () => {
  const models = [
    gpt("gpt-4o-2024-05-01", 1000),
    gpt("gpt-4o-2024-11-20", 2000),
  ];
  assert.equal(selectBestGPTModel(models), "gpt-4o-2024-11-20");
});

test("treats missing created as 0 (oldest)", () => {
  const models = [
    { id: "gpt-4o-no-created" },          // no created field
    gpt("gpt-4o-2024-01-01", 500),
  ];
  assert.equal(selectBestGPTModel(models), "gpt-4o-2024-01-01");
});

test("treats created=0 as oldest", () => {
  const models = [gpt("gpt-4o-zero", 0), gpt("gpt-4o-real", 999)];
  assert.equal(selectBestGPTModel(models), "gpt-4o-real");
});

test("prefers 'latest' alias over newer created timestamp", () => {
  const models = [
    gpt("gpt-4o-2024-latest", 100),    // older created but alias
    gpt("gpt-4o-2024-11-20",  999),    // newer created but dated snapshot
  ];
  assert.equal(selectBestGPTModel(models), "gpt-4o-2024-latest");
});

test("lexicographic tiebreaker when created is equal", () => {
  const ts = 500;
  const models = [gpt("gpt-4o-2024-05-01", ts), gpt("gpt-4o-2024-11-20", ts)];
  // "gpt-4o-2024-11-20" > "gpt-4o-2024-05-01" lexicographically
  assert.equal(selectBestGPTModel(models), "gpt-4o-2024-11-20");
});

test("excludes preview from all tiers", () => {
  const models = [gpt("gpt-4.5-preview", 9999), gpt("gpt-4o", 1)];
  assert.equal(selectBestGPTModel(models), "gpt-4o");
});

test("gpt-4o tier does not include gpt-4o-mini even at high created", () => {
  const models = [gpt("gpt-4o-mini", 9999), gpt("gpt-4o", 1)];
  assert.equal(selectBestGPTModel(models), "gpt-4o");
});

test("permission-filtered: only older tier available", () => {
  // Simulates an account that can't access gpt-5 or gpt-4.5
  const models = [gpt("gpt-4-turbo", 300)];
  assert.equal(selectBestGPTModel(models), "gpt-4-turbo");
});

test("ignores entries with missing id", () => {
  const models = [{ created: 9999 }, gpt("gpt-4o", 1)];
  assert.equal(selectBestGPTModel(models), "gpt-4o");
});

// ── selectBestClaudeModel ─────────────────────────────────────────────────────

test("returns null for empty list", () => {
  assert.equal(selectBestClaudeModel([]), null);
});

test("returns null for null input", () => {
  assert.equal(selectBestClaudeModel(null), null);
});

test("returns null when no sonnet models present", () => {
  const models = [claude("claude-opus-4-6"), claude("claude-haiku-4-5")];
  assert.equal(selectBestClaudeModel(models), null);
});

test("returns the only sonnet model when just one", () => {
  assert.equal(selectBestClaudeModel([claude("claude-sonnet-4-6")]), "claude-sonnet-4-6");
});

test("picks newest by created_at", () => {
  const models = [
    claude("claude-sonnet-3-7", "2025-02-24T00:00:00Z"),
    claude("claude-sonnet-4-6", "2025-10-01T00:00:00Z"),
    claude("claude-sonnet-4-5", "2025-07-15T00:00:00Z"),
  ];
  assert.equal(selectBestClaudeModel(models), "claude-sonnet-4-6");
});

test("treats missing created_at as epoch (oldest)", () => {
  const models = [
    { id: "claude-sonnet-old" },                              // no created_at
    claude("claude-sonnet-4-6", "2025-10-01T00:00:00Z"),
  ];
  assert.equal(selectBestClaudeModel(models), "claude-sonnet-4-6");
});

test("lexicographic tiebreaker when created_at equal", () => {
  const ts = "2025-01-01T00:00:00Z";
  const models = [
    claude("claude-sonnet-4-5", ts),
    claude("claude-sonnet-4-6", ts),
  ];
  // "claude-sonnet-4-6" > "claude-sonnet-4-5" lexicographically
  assert.equal(selectBestClaudeModel(models), "claude-sonnet-4-6");
});

test("ignores non-sonnet models in a mixed list", () => {
  const models = [
    claude("claude-opus-4-6",  "2025-11-01T00:00:00Z"),  // newer but not sonnet
    claude("claude-sonnet-4-6","2025-10-01T00:00:00Z"),
  ];
  assert.equal(selectBestClaudeModel(models), "claude-sonnet-4-6");
});

test("ignores entries with missing id", () => {
  const models = [{ created_at: "2099-01-01T00:00:00Z" }, claude("claude-sonnet-4-6")];
  assert.equal(selectBestClaudeModel(models), "claude-sonnet-4-6");
});

// ── Fallback constant sanity ──────────────────────────────────────────────────

test("OPENAI_FALLBACK is a non-empty string", () => {
  assert.ok(typeof OPENAI_FALLBACK === "string" && OPENAI_FALLBACK.length > 0);
});

test("CLAUDE_FALLBACK is a non-empty string", () => {
  assert.ok(typeof CLAUDE_FALLBACK === "string" && CLAUDE_FALLBACK.length > 0);
});

test("CLAUDE_FALLBACK contains 'sonnet'", () => {
  assert.ok(CLAUDE_FALLBACK.includes("sonnet"),
    "Claude fallback should always be a sonnet model per product decision");
});
