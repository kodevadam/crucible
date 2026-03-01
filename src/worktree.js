/**
 * crucible — worktree.js
 *
 * Isolated Git worktree lifecycle for test-iteration runs (exec-layer-002).
 *
 * Invariants enforced here:
 *   1. Worktrees are always created with --detach based on HEAD.
 *      Never attempt to check out a named branch — it may already be
 *      checked out in the main tree and Git will refuse.
 *
 *   2. Cleanup uses `git worktree remove --force`, never rm -rf.
 *      Skipping the git command leaves stale entries in .git/worktrees/
 *      that cause nondeterministic failures in future runs.
 *
 *   3. `git worktree prune` always runs after removal to evict any
 *      remaining stale refs.
 *
 * Directory layout (excluded from git via .gitignore):
 *   <repoPath>/.crucible/worktrees/<runId>/
 */

import { join }       from "path";
import { spawnSync }  from "child_process";
import { safeEnv }    from "./safety.js";

const WORKTREE_BASE = ".crucible/worktrees";

/**
 * Return the filesystem path for a worktree identified by runId.
 * Does not create or verify anything on disk.
 */
export function worktreePath(repoPath, runId) {
  return join(repoPath, WORKTREE_BASE, runId);
}

/**
 * Create a detached worktree at .crucible/worktrees/<runId> based on HEAD.
 *
 * Returns the absolute path to the worktree on success.
 * Throws with raw git stderr if creation fails.
 */
export function worktreeCreate(repoPath, runId) {
  const dest = worktreePath(repoPath, runId);
  const r = spawnSync(
    "git",
    ["-C", repoPath, "worktree", "add", "--detach", dest, "HEAD"],
    { stdio: "pipe", shell: false, env: safeEnv() }
  );
  if (r.status !== 0) {
    const msg = r.stderr?.toString().trim() || `exit ${r.status}`;
    throw new Error(`git worktree add failed: ${msg}`);
  }
  return dest;
}

/**
 * Remove a worktree created by worktreeCreate.
 *
 * Uses `git worktree remove --force` (not rm -rf) to keep .git/worktrees/
 * clean.  Logs to stderr if remove fails but continues to run prune so
 * stale refs do not accumulate.
 *
 * Always runs `git worktree prune` afterward.
 */
export function worktreeRemove(repoPath, runId) {
  const dest = worktreePath(repoPath, runId);

  const rm = spawnSync(
    "git",
    ["-C", repoPath, "worktree", "remove", dest, "--force"],
    { stdio: "pipe", shell: false, env: safeEnv() }
  );
  if (rm.status !== 0) {
    const msg = rm.stderr?.toString().trim() || `exit ${rm.status}`;
    process.stderr.write(`[crucible] worktree remove failed (${runId}): ${msg}\n`);
  }

  spawnSync(
    "git",
    ["-C", repoPath, "worktree", "prune"],
    { stdio: "pipe", shell: false, env: safeEnv() }
  );
}
