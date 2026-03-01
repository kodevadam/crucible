/**
 * Tests for src/worktree.js
 *
 * Covers:
 *   - worktreePath:   returns correct path without touching the filesystem
 *   - worktreeCreate: creates a detached worktree at the expected path
 *   - worktreeRemove: removes the worktree via git (not rm -rf); prune runs
 *   - worktreeRemove: non-fatal when worktree does not exist (logs, no throw)
 *   - try/finally:    removal always runs even if create body throws
 */

import { test }             from "node:test";
import assert               from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join }             from "node:path";
import { spawnSync }        from "node:child_process";
import { tmpdir }           from "node:os";
import { worktreePath, worktreeCreate, worktreeRemove } from "../src/worktree.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "crucible-wt-test-"));
  spawnSync("git", ["init", dir],                          { stdio: "pipe" });
  spawnSync("git", ["-C", dir, "config", "user.email", "test@test.com"], { stdio: "pipe" });
  spawnSync("git", ["-C", dir, "config", "user.name",  "Test"],          { stdio: "pipe" });
  // Need at least one commit for HEAD to point somewhere
  writeFileSync(join(dir, "README"), "init");
  spawnSync("git", ["-C", dir, "add", "."],                { stdio: "pipe" });
  spawnSync("git", ["-C", dir,
                    "-c", "core.hooksPath=/dev/null",
                    "-c", "commit.gpgsign=false",
                    "commit", "-m", "init"],               { stdio: "pipe" });
  return dir;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ── worktreePath ──────────────────────────────────────────────────────────────

test("worktreePath: returns path inside .crucible/worktrees", () => {
  const p = worktreePath("/repo", "run-123");
  assert.ok(p.includes(".crucible"));
  assert.ok(p.includes("worktrees"));
  assert.ok(p.endsWith("run-123"));
});

test("worktreePath: does not touch the filesystem", () => {
  // Should not throw even for a nonexistent repo path
  assert.doesNotThrow(() => worktreePath("/nonexistent-repo-path", "x"));
});

// ── worktreeCreate ────────────────────────────────────────────────────────────

test("worktreeCreate: creates directory at the expected path", () => {
  const repo = makeRepo();
  try {
    const dest = worktreeCreate(repo, "test-run");
    const expected = worktreePath(repo, "test-run");
    assert.equal(dest, expected);

    // Verify git knows about it
    const list = spawnSync("git", ["-C", repo, "worktree", "list"], { stdio: "pipe" });
    assert.ok(list.stdout.toString().includes("test-run"));
  } finally {
    cleanup(repo);
  }
});

test("worktreeCreate: worktree HEAD matches repo HEAD", () => {
  const repo = makeRepo();
  try {
    worktreeCreate(repo, "head-check");

    const repoHead = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"],
                               { stdio: "pipe" }).stdout.toString().trim();
    const wtPath   = worktreePath(repo, "head-check");
    const wtHead   = spawnSync("git", ["-C", wtPath, "rev-parse", "HEAD"],
                               { stdio: "pipe" }).stdout.toString().trim();

    assert.equal(wtHead, repoHead);
  } finally {
    cleanup(repo);
  }
});

test("worktreeCreate: throws with raw git message on failure", () => {
  assert.throws(
    () => worktreeCreate("/nonexistent-path-xyz", "run-fail"),
    /git worktree add failed/
  );
});

// ── worktreeRemove ────────────────────────────────────────────────────────────

test("worktreeRemove: removes worktree directory", () => {
  const repo = makeRepo();
  try {
    const dest = worktreeCreate(repo, "to-remove");
    worktreeRemove(repo, "to-remove");

    // Directory should be gone
    assert.equal(existsSync(dest), false);
  } finally {
    cleanup(repo);
  }
});

test("worktreeRemove: git worktree list no longer includes runId after removal", () => {
  const repo = makeRepo();
  try {
    worktreeCreate(repo, "cleanup-check");
    worktreeRemove(repo, "cleanup-check");

    const list = spawnSync("git", ["-C", repo, "worktree", "list"], { stdio: "pipe" });
    assert.ok(!list.stdout.toString().includes("cleanup-check"));
  } finally {
    cleanup(repo);
  }
});

test("worktreeRemove: does not throw when worktree does not exist", () => {
  const repo = makeRepo();
  try {
    // Should log to stderr but not throw
    assert.doesNotThrow(() => worktreeRemove(repo, "never-created"));
  } finally {
    cleanup(repo);
  }
});

// ── try/finally pattern ───────────────────────────────────────────────────────

test("try/finally: worktreeRemove cleans up even when body throws", () => {
  const repo = makeRepo();
  let dest;
  try {
    dest = worktreeCreate(repo, "finally-test");
    throw new Error("simulated failure");
  } catch {
    // expected
  } finally {
    if (dest) worktreeRemove(repo, "finally-test");
  }

  const list = spawnSync("git", ["-C", repo, "worktree", "list"], { stdio: "pipe" });
  assert.ok(!list.stdout.toString().includes("finally-test"));
  cleanup(repo);
});
