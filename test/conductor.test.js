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
import { mkdtempSync, writeFileSync, rmSync, symlinkSync,
         readFileSync, mkdirSync }                        from "fs";
import { join }                                           from "path";
import { tmpdir }                                         from "os";
import { spawnSync }                                      from "child_process";
import { evaluateDelta, buildIterationContext,
         dispatchRepairTool, REPAIR_TOOLS,
         RUN_COMMAND_MAX_OUTPUT }                        from "../src/conductor.js";

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

test("buildIterationContext: new fields (enrichedFailure, anchorError, wtPath) default to null/present", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-cond-test-"));
  try {
    const ctx = buildIterationContext({
      plan: "p", affectedFiles: [], wtPath: wt,
      repoUnderstanding: null, failureExcerpt: null,
      previousOps: null, iteration: 1, headSha: "abc",
    });
    assert.equal(ctx.enrichedFailure, null);
    assert.equal(ctx.anchorError,     null);
    assert.equal(ctx.wtPath,          wt, "wtPath should be passed through for tool dispatch");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ── dispatchRepairTool: path security ─────────────────────────────────────────

test("dispatchRepairTool: reads a valid file inside the worktree", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-dispatch-"));
  try {
    writeFileSync(join(wt, "hello.js"), "const x = 1;\n", "utf8");
    const result = dispatchRepairTool("read_file", { path: "hello.js" }, wt);
    assert.equal(result, "const x = 1;\n");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("dispatchRepairTool: read_file with line range", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-dispatch-"));
  try {
    writeFileSync(join(wt, "multi.js"), "line1\nline2\nline3\nline4\n", "utf8");
    const result = dispatchRepairTool("read_file", { path: "multi.js", start_line: 2, end_line: 3 }, wt);
    assert.ok(result.includes("line2"), `got: ${result}`);
    assert.ok(result.includes("line3"), `got: ${result}`);
    assert.ok(!result.includes("line1"), `should not include line1, got: ${result}`);
    assert.ok(!result.includes("line4"), `should not include line4, got: ${result}`);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("dispatchRepairTool: rejects path traversal attempts", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-dispatch-"));
  try {
    const TRAVERSAL_PATHS = [
      "../../etc/passwd",
      "../../../root/.ssh/id_rsa",
      "/etc/passwd",
      "a/../../b/../../secret",
    ];
    for (const p of TRAVERSAL_PATHS) {
      const result = dispatchRepairTool("read_file", { path: p }, wt);
      assert.ok(
        result.startsWith("[path rejected:"),
        `traversal path "${p}" should be rejected, got: ${result}`
      );
    }
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("dispatchRepairTool: returns error string for missing file (does not throw)", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-dispatch-"));
  try {
    const result = dispatchRepairTool("read_file", { path: "nonexistent.js" }, wt);
    assert.ok(result.startsWith("[file not found:"), `got: ${result}`);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("dispatchRepairTool: returns error string for unknown tool (does not throw)", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-dispatch-"));
  try {
    const result = dispatchRepairTool("explode_repo", {}, wt);
    assert.ok(result.startsWith("[unknown tool:"), `got: ${result}`);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ── REPAIR_TOOLS: contract shape ──────────────────────────────────────────────

test("REPAIR_TOOLS: has read_file, search_content, run_command, submit_ops entries", () => {
  const names = REPAIR_TOOLS.map(t => t.name);
  assert.ok(names.includes("read_file"),      "missing read_file");
  assert.ok(names.includes("search_content"), "missing search_content");
  assert.ok(names.includes("run_command"),    "missing run_command");
  assert.ok(names.includes("submit_ops"),     "missing submit_ops");
});

test("REPAIR_TOOLS: each tool has name, description, and input_schema", () => {
  for (const tool of REPAIR_TOOLS) {
    assert.ok(typeof tool.name        === "string", `${tool.name}: missing name`);
    assert.ok(typeof tool.description === "string", `${tool.name}: missing description`);
    assert.ok(tool.input_schema && tool.input_schema.type === "object",
      `${tool.name}: missing input_schema`);
  }
});

test("REPAIR_TOOLS: submit_ops requires ops array", () => {
  const submitOps = REPAIR_TOOLS.find(t => t.name === "submit_ops");
  assert.ok(submitOps.input_schema.required.includes("ops"));
  assert.equal(submitOps.input_schema.properties.ops.type, "array");
});

test("REPAIR_TOOLS: read_file requires path but not start_line/end_line", () => {
  const readFile = REPAIR_TOOLS.find(t => t.name === "read_file");
  assert.ok(readFile.input_schema.required.includes("path"));
  assert.ok(!readFile.input_schema.required.includes("start_line"), "start_line should be optional");
  assert.ok(!readFile.input_schema.required.includes("end_line"),   "end_line should be optional");
});

test("REPAIR_TOOLS: run_command requires kind, has enum of allowed kinds, target is optional", () => {
  const runCmd = REPAIR_TOOLS.find(t => t.name === "run_command");
  assert.ok(runCmd, "run_command tool must exist");
  assert.ok(runCmd.input_schema.required.includes("kind"));
  assert.ok(!runCmd.input_schema.required.includes("target"), "target should be optional");
  const kinds = runCmd.input_schema.properties.kind.enum;
  for (const k of ["test", "build", "lint", "typecheck", "git_diff"]) {
    assert.ok(kinds.includes(k), `missing kind: ${k}`);
  }
});

// ── dispatchRepairTool: run_command ───────────────────────────────────────────

test("dispatchRepairTool: run_command git_diff returns exit code line", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-dispatch-"));
  try {
    // git_diff in a non-git dir will fail, but we just verify the response shape
    const result = dispatchRepairTool("run_command", { kind: "git_diff" }, wt);
    assert.ok(result.startsWith("exit "), `response should start with 'exit ', got: ${result}`);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("dispatchRepairTool: run_command rejects unknown kind", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-dispatch-"));
  try {
    const result = dispatchRepairTool("run_command", { kind: "rm_rf" }, wt);
    assert.ok(result.startsWith("[unknown command kind:"), `got: ${result}`);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("dispatchRepairTool: run_command rejects traversal target", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-dispatch-"));
  try {
    const result = dispatchRepairTool("run_command", { kind: "git_diff", target: "../../etc" }, wt);
    assert.ok(result.startsWith("[target path rejected:"), `got: ${result}`);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("dispatchRepairTool: run_command rejects .git/ target", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-dispatch-"));
  try {
    const result = dispatchRepairTool("run_command", { kind: "git_diff", target: ".git/config" }, wt);
    assert.ok(result.startsWith("[target path rejected:"), `got: ${result}`);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ── Case 5: output cap ────────────────────────────────────────────────────────
//
// Write a tiny Node script that floods stdout, then verify the returned string
// is bounded by RUN_COMMAND_MAX_OUTPUT (plus a short prefix for "exit N\n" and
// the "[output truncated]" suffix — both small constants).

test("dispatchRepairTool: run_command caps output at RUN_COMMAND_MAX_OUTPUT chars", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-dispatch-"));
  try {
    // Script writes well over the cap; the dispatcher must truncate.
    writeFileSync(join(wt, "flood.js"),
      `process.stdout.write("x".repeat(${RUN_COMMAND_MAX_OUTPUT * 3}));\n`, "utf8");

    const result = dispatchRepairTool(
      "run_command", { kind: "test" }, wt,
      { testCmd: "node flood.js" }
    );

    // Must contain exit code line (always present)
    assert.ok(result.startsWith("exit "), `no exit line: ${result.slice(0, 40)}`);
    // Must contain the truncation marker
    assert.ok(result.includes("[output truncated]"), "expected truncation marker");
    // Total length must not far exceed the cap
    assert.ok(result.length < RUN_COMMAND_MAX_OUTPUT + 200,
      `response too long: ${result.length} chars`);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ── Extended adversarial audit: symlink + shell safety + exit codes ───────────

test("dispatchRepairTool: read_file blocked on symlink-escape path", () => {
  const wt       = mkdtempSync(join(tmpdir(), "crucible-sym-"));
  const external = mkdtempSync(join(tmpdir(), "crucible-ext-"));
  try {
    writeFileSync(join(external, "secret.txt"), "SENSITIVE\n", "utf8");
    symlinkSync(external, join(wt, "evil")); // wt/evil → external dir

    const result = dispatchRepairTool("read_file", { path: "evil/secret.txt" }, wt);
    assert.ok(result.startsWith("[path rejected:"),
      `should be rejected, got: ${result.slice(0, 80)}`);
    assert.ok(!result.includes("SENSITIVE"), "sensitive content must not be returned");
  } finally {
    rmSync(wt,       { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("dispatchRepairTool: run_command target is single arg — shell metacharacters not interpreted", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-dispatch-"));
  try {
    // If shell: false is ever accidentally removed, "echo INJECTED" would run.
    // With shell: false, "nonexistent; echo INJECTED" is one literal path argument.
    const result = dispatchRepairTool(
      "run_command",
      { kind: "git_diff", target: "nonexistent; echo INJECTED" },
      wt
    );
    assert.ok(result.startsWith("exit "), "should have exit line");
    assert.ok(!result.includes("INJECTED"), "semicolon must not be shell-interpreted");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("dispatchRepairTool: run_command captures nonzero exit code correctly", () => {
  const wt = mkdtempSync(join(tmpdir(), "crucible-dispatch-"));
  try {
    writeFileSync(join(wt, "fail.js"), "process.exit(42);\n", "utf8");
    const result = dispatchRepairTool(
      "run_command", { kind: "test" }, wt,
      { testCmd: "node fail.js" }
    );
    assert.ok(result.startsWith("exit 42"),
      `expected exit 42, got: ${result.slice(0, 40)}`);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ── Worktree reset proof ──────────────────────────────────────────────────────
//
// Conductor invariant #1: "Worktree created once; reset to HEAD before every iteration."
// This test proves that the exact git commands the conductor uses
// (`git reset --hard HEAD` + `git clean -fd`) actually restore worktree
// contents to HEAD, eliminating cumulative drift across iterations.
//
// We don't run runRepairLoop (requires model API) but we directly exercise
// the same two commands against a real git worktree.

function git(cwd, args) {
  return spawnSync(
    "git",
    ["-C", cwd,
     "-c", "core.hooksPath=/dev/null",
     "-c", "commit.gpgsign=false",  // disable signing; test env may require it
     "-c", "tag.gpgsign=false",
     ...args],
    {
      encoding: "utf8",
      stdio:    ["ignore", "pipe", "pipe"],
      shell:    false,
      env:      { ...process.env },
    }
  );
}

test("worktree reset: git reset --hard HEAD + clean -fd restores to HEAD content", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "crucible-repo-"));
  const wtDir   = mkdtempSync(join(tmpdir(), "crucible-wt-"));

  try {
    // ── 1. Create a minimal git repo with one committed file ──────────────────
    git(repoDir, ["init", "--initial-branch=main"]);
    git(repoDir, ["config", "user.email", "test@crucible"]);
    git(repoDir, ["config", "user.name",  "Crucible Test"]);
    writeFileSync(join(repoDir, "app.js"), "const version = 1;\n", "utf8");
    git(repoDir, ["add", "app.js"]);
    git(repoDir, ["commit", "-m", "initial commit"]);

    // ── 2. Create a linked worktree (mirrors what conductor does) ─────────────
    // Use a fresh tempdir path that doesn't exist yet as the worktree target
    rmSync(wtDir, { recursive: true, force: true }); // worktree add creates it
    git(repoDir, ["worktree", "add", "--detach", wtDir]);

    // Verify the worktree has the committed content
    assert.equal(readFileSync(join(wtDir, "app.js"), "utf8"), "const version = 1;\n",
      "worktree should start at HEAD content");

    // ── 3. Simulate "iteration 1 modified files" ──────────────────────────────
    writeFileSync(join(wtDir, "app.js"), "const version = 99; // iteration 1 change\n", "utf8");
    writeFileSync(join(wtDir, "new-file-from-iter1.js"), "// leftover\n", "utf8");

    assert.equal(readFileSync(join(wtDir, "app.js"), "utf8"),
      "const version = 99; // iteration 1 change\n",
      "modification is in place before reset");

    // ── 4. Apply the exact reset the conductor runs before each iteration ──────
    git(wtDir, ["reset", "--hard", "HEAD"]);
    git(wtDir, ["clean",  "-fd"]);

    // ── 5. Verify: app.js is back to HEAD; untracked file is gone ─────────────
    assert.equal(readFileSync(join(wtDir, "app.js"), "utf8"), "const version = 1;\n",
      "app.js must be restored to HEAD after reset --hard");

    let leftoverExists = false;
    try { readFileSync(join(wtDir, "new-file-from-iter1.js")); leftoverExists = true; } catch {}
    assert.equal(leftoverExists, false,
      "untracked file from iteration 1 must be removed by git clean -fd");

  } finally {
    // Remove linked worktree before deleting its directory
    git(repoDir, ["worktree", "remove", "--force", wtDir]);
    rmSync(repoDir, { recursive: true, force: true });
    // wtDir may already be removed by `worktree remove`; force:true handles that
    try { rmSync(wtDir, { recursive: true, force: true }); } catch {}
  }
});
