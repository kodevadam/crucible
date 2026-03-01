/**
 * crucible — test/testloop.test.js
 *
 * Tests for src/testloop.js — the exec-layer-004 test iteration primitives.
 * Uses Node's native test runner (node --test).
 */

import { test }                               from "node:test";
import assert                                 from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync }  from "fs";
import { join }                               from "path";
import { tmpdir }                             from "os";
import {
  runTestIteration,
  compareIterations,
  extractFailureExcerpt,
  checkNetworkIsolation,
} from "../src/testloop.js";

// ── 1. runTestIteration captures stdout and stderr ───────────────────────────

test("runTestIteration: captures stdout and stderr separately", async () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-tl-"));
  try {
    // Write a script to avoid shell quoting issues with spawnSync(shell:false)
    writeFileSync(
      join(wt, "script.js"),
      `process.stdout.write("hello-out"); process.stderr.write("hello-err");`,
      "utf8"
    );
    const result = await runTestIteration(wt, "node script.js");
    assert.ok(result.stdout.includes("hello-out"), `stdout: ${result.stdout}`);
    assert.ok(result.stderr.includes("hello-err"), `stderr: ${result.stderr}`);
    assert.equal(result.exitCode, 0);
    assert.ok(typeof result.durationMs === "number" && result.durationMs >= 0);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ── 2. TAP failure count parsed from # fail N ────────────────────────────────

test("runTestIteration: TAP # fail N parsed correctly", async () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-tl-"));
  try {
    writeFileSync(
      join(wt, "tap.js"),
      `console.log("TAP version 13\\n1..2\\nnot ok 1 - oops\\nok 2 - fine\\n# fail 1");`,
      "utf8"
    );
    const result = await runTestIteration(wt, "node tap.js");
    assert.equal(result.framework,          "tap");
    assert.equal(result.failureCount,       1);
    assert.equal(result.failureCountApprox, false);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ── 3. Jest failure count parsed from "Tests: N failed" ─────────────────────

test("runTestIteration: Jest 'Tests: N failed' parsed correctly", async () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-tl-"));
  try {
    writeFileSync(
      join(wt, "jest.js"),
      `console.log("Tests: 3 failed, 7 passed, 10 total");`,
      "utf8"
    );
    const result = await runTestIteration(wt, "node jest.js");
    assert.equal(result.framework,          "jest");
    assert.equal(result.failureCount,       3);
    assert.equal(result.failureCountApprox, false);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ── 4. Generic fallback sets framework="generic" and failureCountApprox=true ─

test("runTestIteration: generic fallback sets failureCountApprox=true", async () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-tl-"));
  try {
    writeFileSync(
      join(wt, "generic.js"),
      `console.log("FAIL: something broke\\nERROR: another issue");`,
      "utf8"
    );
    const result = await runTestIteration(wt, "node generic.js");
    assert.equal(result.framework,          "generic");
    assert.equal(result.failureCountApprox, true);
    assert.ok(result.failureCount >= 0, "failureCount should be non-negative");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ── 5. extractFailureExcerpt prioritises assertion lines ─────────────────────

test("extractFailureExcerpt: assertion lines take priority", () => {
  const output = [
    "some preamble noise",
    "AssertionError: expected 1 to equal 2",
    "    at Object.<anonymous> (test.js:5:10)",
    "    at Module._compile (internal/modules/cjs/loader.js:999:30)",
    "unrelated trailer",
  ].join("\n");

  const excerpt = extractFailureExcerpt(output);
  assert.ok(
    excerpt.includes("AssertionError"),
    `expected AssertionError in excerpt, got: ${excerpt}`
  );
  assert.ok(
    excerpt.includes("at Object"),
    `expected stack trace in excerpt, got: ${excerpt}`
  );
});

// ── 6. extractFailureExcerpt falls back to last 20 lines ─────────────────────

test("extractFailureExcerpt: falls back to last 20 lines when no assertion signals", () => {
  const lines  = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const output = lines.join("\n");

  const excerpt = extractFailureExcerpt(output);
  assert.ok(
    excerpt.includes("line 40"),
    `expected last lines in excerpt, got: ${excerpt}`
  );
  assert.ok(
    !excerpt.includes("line 1"),
    `first lines should not appear in excerpt, got: ${excerpt}`
  );
});

// ── 7. compareIterations returns "improved" when count decreases ─────────────

test("compareIterations: improved when failureCount decreases", () => {
  assert.equal(compareIterations({ failureCount: 5 }, { failureCount: 3 }), "improved");
});

test("compareIterations: worse when failureCount increases", () => {
  assert.equal(compareIterations({ failureCount: 2 }, { failureCount: 4 }), "worse");
});

test("compareIterations: same when counts are equal", () => {
  assert.equal(compareIterations({ failureCount: 3 }, { failureCount: 3 }), "same");
});

// ── 8. compareIterations returns "unknown" when one count is -1 ──────────────

test("compareIterations: unknown when prev is -1 and curr is not", () => {
  assert.equal(compareIterations({ failureCount: -1 }, { failureCount: 3 }), "unknown");
});

test("compareIterations: unknown when curr is -1 and prev is not", () => {
  assert.equal(compareIterations({ failureCount: 3 }, { failureCount: -1 }), "unknown");
});

test("compareIterations: same when both are -1", () => {
  assert.equal(compareIterations({ failureCount: -1 }, { failureCount: -1 }), "same");
});

// ── 9. checkNetworkIsolation: never throws ───────────────────────────────────

test("checkNetworkIsolation: always returns without throwing", () => {
  assert.doesNotThrow(() => {
    const result = checkNetworkIsolation();
    assert.ok(typeof result.available === "boolean");
    assert.ok(result.method === "netns" || result.method === "none");
  });
});
