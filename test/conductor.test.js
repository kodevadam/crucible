/**
 * crucible — test/conductor.test.js
 *
 * Unit tests for src/conductor.js.
 * Focuses on the pure functions (evaluateDelta, buildIterationContext)
 * which contain the core decision logic and are fully testable without
 * API calls or real worktrees.
 *
 * runRepairLoop / runConductor require a live model API and a git repo;
 * those are integration-tested separately.
 */

import { test }                                           from "node:test";
import assert                                             from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync }             from "fs";
import { join }                                           from "path";
import { tmpdir }                                         from "os";
import { evaluateDelta, buildIterationContext }           from "../src/conductor.js";

// ── evaluateDelta: iteration 1 ───────────────────────────────────────────────

test("evaluateDelta: iteration=1, known failureCount → continue (first attempt is exploratory)", () => {
  assert.equal(evaluateDelta(1, null,      5),  "continue");
  assert.equal(evaluateDelta(1, null,      1),  "continue");
  assert.equal(evaluateDelta(1, null,      0),  "continue"); // exitCode was non-zero but count is 0
});

test("evaluateDelta: iteration=1, failureCount=-1 → bail_unknown (can't measure progress)", () => {
  assert.equal(evaluateDelta(1, null, -1), "bail_unknown");
});

// delta is null on iteration 1 (no prev to compare against), test all ignore it
test("evaluateDelta: iteration=1 ignores delta value (no prev exists)", () => {
  // Even if we erroneously pass a delta on iter 1, failureCount drives the decision
  assert.equal(evaluateDelta(1, "improved", 3), "continue");
  assert.equal(evaluateDelta(1, "same",     3), "continue");
  assert.equal(evaluateDelta(1, "worse",    3), "continue");
});

// ── evaluateDelta: iteration ≥ 2 ────────────────────────────────────────────

test("evaluateDelta: iteration=2, improved → continue", () => {
  assert.equal(evaluateDelta(2, "improved", 2), "continue");
});

test("evaluateDelta: iteration=2, same → bail_same", () => {
  assert.equal(evaluateDelta(2, "same", 3), "bail_same");
});

test("evaluateDelta: iteration=2, worse → bail_worse", () => {
  assert.equal(evaluateDelta(2, "worse", 5), "bail_worse");
});

test("evaluateDelta: iteration=2, unknown delta → bail_unknown", () => {
  assert.equal(evaluateDelta(2, "unknown", -1), "bail_unknown");
  assert.equal(evaluateDelta(2, "unknown",  3), "bail_unknown");
});

test("evaluateDelta: iteration=3, improved → continue (still within budget)", () => {
  assert.equal(evaluateDelta(3, "improved", 1), "continue");
});

test("evaluateDelta: iteration=3, same → bail_same", () => {
  assert.equal(evaluateDelta(3, "same", 2), "bail_same");
});

test("evaluateDelta: iteration=3, worse → bail_worse", () => {
  assert.equal(evaluateDelta(3, "worse", 6), "bail_worse");
});

// ── buildIterationContext: payload shape ─────────────────────────────────────

test("buildIterationContext: includes all required fields with correct shape", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-cond-test-"));
  try {
    writeFileSync(join(wt, "src.js"), "const x = 1;\n", "utf8");

    const ctx = buildIterationContext({
      plan:              "update x to 2",
      affectedFiles:     [{ path: "src.js", action: "modify", note: "update constant" }],
      wtPath:            wt,
      repoUnderstanding: "a simple repo",
      failureExcerpt:    "AssertionError: expected 1 to equal 2",
      previousOps:       [{ op: "replace", path: "src.js", old: "const x = 1", new: "const x = 2" }],
      iteration:         2,
      headSha:           "abc123def456",
    });

    assert.equal(ctx.plan,              "update x to 2");
    assert.equal(ctx.iteration,         2);
    assert.equal(ctx.failureExcerpt,    "AssertionError: expected 1 to equal 2");
    assert.ok(Array.isArray(ctx.previousOps),          "previousOps should be an array");
    assert.equal(ctx.fileContents["src.js"],            "const x = 1;\n");
    assert.equal(ctx.repoState.headSha,                "abc123def456");
    assert.equal(ctx.repoState.worktreeDetached,       true);
    assert.ok(Array.isArray(ctx.repoState.changedPaths));
    assert.ok(ctx.repoState.changedPaths.includes("src.js"), "changedPaths should list ops paths");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("buildIterationContext: first iteration (no previousOps, no failureExcerpt)", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-cond-test-"));
  try {
    writeFileSync(join(wt, "index.js"), "module.exports = {};\n", "utf8");

    const ctx = buildIterationContext({
      plan:              "add exports",
      affectedFiles:     [{ path: "index.js", action: "modify", note: "add exports" }],
      wtPath:            wt,
      repoUnderstanding: null,
      failureExcerpt:    null,
      previousOps:       null,
      iteration:         1,
      headSha:           "deadbeef0000",
    });

    assert.equal(ctx.failureExcerpt,            null);
    assert.equal(ctx.previousOps,               null);
    assert.equal(ctx.repoUnderstanding,         null);
    assert.equal(ctx.repoState.changedPaths.length, 0, "no changedPaths on first iteration");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("buildIterationContext: gracefully handles file missing from worktree", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-cond-test-"));
  try {
    // Do NOT create the file — simulates a worktree missing a file
    const ctx = buildIterationContext({
      plan:              "create something",
      affectedFiles:     [{ path: "missing.js", action: "modify", note: "update" }],
      wtPath:            wt,
      repoUnderstanding: null,
      failureExcerpt:    null,
      previousOps:       null,
      iteration:         1,
      headSha:           "cafebabe",
    });

    assert.equal(ctx.fileContents["missing.js"], null,
      "missing file should be null, not throw");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("buildIterationContext: skips non-modify files in fileContents", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-cond-test-"));
  try {
    writeFileSync(join(wt, "existing.js"), "existing\n", "utf8");

    const ctx = buildIterationContext({
      plan:          "add and delete",
      affectedFiles: [
        { path: "new.js",      action: "create", note: "new file" },
        { path: "existing.js", action: "modify", note: "update it" },
        { path: "gone.js",     action: "delete", note: "remove it" },
      ],
      wtPath:            wt,
      repoUnderstanding: null,
      failureExcerpt:    null,
      previousOps:       null,
      iteration:         1,
      headSha:           "f00d",
    });

    // Only "modify" files appear in fileContents
    assert.ok(!("new.js" in ctx.fileContents),  "create files excluded from fileContents");
    assert.ok(!("gone.js" in ctx.fileContents), "delete files excluded from fileContents");
    assert.ok("existing.js" in ctx.fileContents, "modify files included in fileContents");
    assert.equal(ctx.fileContents["existing.js"], "existing\n");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});
