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
  extractFailureSignatures,
  extractStackRefs,
  enrichFailureContext,
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

// ── 10. runTestIteration: failureSignatures in result ────────────────────────

test("runTestIteration: failureSignatures present and empty on exit 0", async () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-tl-"));
  try {
    writeFileSync(join(wt, "ok.js"), `process.exit(0);`, "utf8");
    const result = await runTestIteration(wt, "node ok.js");
    assert.ok(Array.isArray(result.failureSignatures), "failureSignatures should be an array");
    assert.equal(result.failureSignatures.length, 0, "no signatures on success");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("runTestIteration: failureSignatures non-empty on failure", async () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-tl-"));
  try {
    writeFileSync(join(wt, "fail.js"),
      `console.error("AssertionError: expected 1 to equal 2"); process.exit(1);`, "utf8");
    const result = await runTestIteration(wt, "node fail.js");
    assert.ok(result.failureSignatures.length > 0, "should have at least one signature");
    assert.ok(
      result.failureSignatures.some(s => s.startsWith("AssertionError::")),
      `expected AssertionError:: signature, got: ${result.failureSignatures}`
    );
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ── 11. extractFailureSignatures ─────────────────────────────────────────────

test("extractFailureSignatures: extracts AssertionError signature", () => {
  const sigs = extractFailureSignatures(
    "AssertionError: expected 1 to equal 2\n    at test.js:5:10",
    ""
  );
  assert.ok(sigs.length > 0, "should produce at least one signature");
  assert.ok(sigs.some(s => s.startsWith("AssertionError::")));
});

test("extractFailureSignatures: extracts Jest bullet marker", () => {
  const sigs = extractFailureSignatures(
    "● MyComponent › renders correctly",
    ""
  );
  assert.ok(sigs.some(s => s.startsWith("jest::")), `got: ${sigs}`);
});

test("extractFailureSignatures: extracts TAP not-ok line", () => {
  const sigs = extractFailureSignatures(
    "not ok 3 - should equal expected value",
    ""
  );
  assert.ok(sigs.some(s => s.startsWith("tap::")), `got: ${sigs}`);
});

test("extractFailureSignatures: normalises hex addresses (same logical error → same sig)", () => {
  const run1 = extractFailureSignatures("Error: segfault at 0xdeadbeef", "");
  const run2 = extractFailureSignatures("Error: segfault at 0xcafebabe", "");
  assert.deepEqual(run1, run2, "hex addresses should be normalised away");
});

test("extractFailureSignatures: empty input → empty array", () => {
  assert.deepEqual(extractFailureSignatures("", ""), []);
  assert.deepEqual(extractFailureSignatures(null, null), []);
});

// ── 12. compareIterations: signature-aware progress detection ────────────────

test("compareIterations: same count, different signatures → improved (peeling the onion)", () => {
  const prev = { failureCount: 3, failureSignatures: ["AssertionError::A", "TypeError::B", "Error::C"] };
  const curr = { failureCount: 3, failureSignatures: ["AssertionError::A", "TypeError::X", "RangeError::Y"] };
  assert.equal(compareIterations(prev, curr), "improved");
});

test("compareIterations: same count, identical signatures → same (truly stuck)", () => {
  const sigs = ["AssertionError::expected 1 to equal 2", "TypeError::cannot read"];
  const prev = { failureCount: 2, failureSignatures: [...sigs] };
  const curr = { failureCount: 2, failureSignatures: [...sigs] };
  assert.equal(compareIterations(prev, curr), "same");
});

test("compareIterations: same count, no signatures → same (no data, conservative)", () => {
  assert.equal(compareIterations({ failureCount: 3 }, { failureCount: 3 }), "same");
});

// ── 13. extractStackRefs ─────────────────────────────────────────────────────

test("extractStackRefs: parses standard Node.js stack frame", () => {
  const text = [
    "AssertionError: expected 1 to equal 2",
    "    at Object.<anonymous> (/home/user/project/test/parser.test.js:15:5)",
    "    at Module._compile (node:internal/modules/cjs/loader:1376:14)",
  ].join("\n");

  const refs = extractStackRefs(text);
  assert.ok(refs.length > 0, "should extract at least one ref");
  assert.ok(refs[0].rawPath.includes("parser.test.js"), `got: ${refs[0].rawPath}`);
  assert.equal(refs[0].line, 15);
});

test("extractStackRefs: skips node: internals and node_modules", () => {
  const text = [
    "    at node:internal/process/task_queues:140:5",
    "    at /home/user/project/node_modules/jest-runner/build/runTest.js:350:5",
    "    at Object.<anonymous> (/home/user/project/src/real.js:42:1)",
  ].join("\n");

  const refs = extractStackRefs(text);
  assert.equal(refs.length, 1, `should only get userland ref, got: ${JSON.stringify(refs)}`);
  assert.ok(refs[0].rawPath.includes("real.js"));
});

test("extractStackRefs: empty input → empty array", () => {
  assert.deepEqual(extractStackRefs(""), []);
  assert.deepEqual(extractStackRefs(null), []);
});

// ── 14. enrichFailureContext ──────────────────────────────────────────────────

test("enrichFailureContext: reads failing file from worktree", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-tl-enrich-"));
  try {
    // Create a source file in the mock worktree
    writeFileSync(join(wt, "parser.js"), [
      "function parse(input) {",
      "  if (!input) throw new Error('null input');",
      "  return JSON.parse(input);",
      "}",
      "module.exports = parse;",
    ].join("\n"), "utf8");

    // Simulate a test result with a stack trace pointing to our file
    const result = {
      exitCode: 1,
      stdout: "",
      stderr: [
        "AssertionError: expected null got string",
        `    at Object.<anonymous> (${wt}/parser.js:2:5)`,
        "    at node:internal/process/task_queues:140:5",
      ].join("\n"),
      excerpt: "AssertionError: expected null got string",
    };

    const enriched = enrichFailureContext(result, wt);
    assert.equal(enriched.excerpt, result.excerpt);
    assert.ok(Array.isArray(enriched.refs));
    assert.ok(enriched.refs.length > 0, "should find the file reference");
    assert.ok(enriched.refs[0].path.includes("parser.js"), `got path: ${enriched.refs[0].path}`);
    assert.ok(typeof enriched.refs[0].snippet === "string");
    assert.ok(enriched.refs[0].snippet.includes("null input"), "snippet should contain surrounding code");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("enrichFailureContext: returns empty refs when wtPath is null", () => {
  const result = { exitCode: 1, stdout: "", stderr: "Error", excerpt: "Error" };
  const enriched = enrichFailureContext(result, null);
  assert.deepEqual(enriched.refs, []);
});

test("enrichFailureContext: returns empty refs when stack has no readable files", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-tl-enrich-"));
  try {
    const result = {
      exitCode: 1,
      stdout:   "    at Object.<anonymous> (/nonexistent/path/file.js:1:1)",
      stderr:   "",
      excerpt:  "error",
    };
    const enriched = enrichFailureContext(result, wt);
    assert.deepEqual(enriched.refs, []);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});
