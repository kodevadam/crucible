/**
 * crucible — safety.js
 *
 * Secure path validation, branch name validation, and git execution helpers.
 *
 * All git operations go through gitq() / gitExec() which use spawnSync with
 * explicit args arrays — no shell interpolation, no injection surface.
 */

import { resolve, normalize, isAbsolute, sep } from "path";
import { spawnSync }                            from "child_process";

// ── Path validation ───────────────────────────────────────────────────────────

/**
 * Validate that proposedPath is safe to use within repoRoot.
 *
 * Rules enforced:
 *   - Must be a non-empty string
 *   - Must not be absolute
 *   - Must not contain '..' segments after normalisation
 *   - Resolved path must sit inside repoRoot (boundary-checked)
 *   - Normalises both / and \ separators (cheap Windows compat)
 *
 * Returns the resolved absolute path on success.
 * Throws an Error with a descriptive message on failure.
 */
export function validateStagingPath(repoRoot, proposedPath) {
  if (!proposedPath || typeof proposedPath !== "string") {
    throw new Error(
      `Path validation failed: expected non-empty string, got: ${JSON.stringify(proposedPath)}`
    );
  }

  // Reject absolute paths immediately
  if (isAbsolute(proposedPath)) {
    throw new Error(`Absolute path rejected: ${proposedPath}`);
  }

  // Normalise (collapses redundant separators, handles \ on Windows)
  const normalised = normalize(proposedPath);

  // Reject traversal after normalisation — split on both / and \
  const parts = normalised.split(/[/\\]/);
  if (parts.includes("..")) {
    throw new Error(`Path traversal rejected: ${proposedPath}`);
  }

  // Boundary check: resolved path must be strictly inside repoRoot
  const resolvedRoot = resolve(repoRoot);
  const resolvedPath = resolve(repoRoot, normalised);

  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + sep)) {
    throw new Error(`Path escapes repo root (${repoRoot}): ${proposedPath}`);
  }

  return resolvedPath;
}

// ── Branch name validation ────────────────────────────────────────────────────

// Conservative allowlist: alphanumerics plus . _ - /
const BRANCH_ALLOWED = /^[A-Za-z0-9._\-\/]+$/;

/**
 * Validate a git branch name.
 *
 * Enforces git's own rules plus a conservative character allowlist to
 * prevent shell injection if the name ever appears in a command string.
 *
 * Returns the trimmed name on success.
 * Throws an Error on failure.
 */
export function validateBranchName(name) {
  if (!name || typeof name !== "string") {
    throw new Error("Branch name must be a non-empty string.");
  }
  const t = name.trim();
  if (!t)                           throw new Error("Branch name cannot be blank.");
  if (!BRANCH_ALLOWED.test(t))      throw new Error(`Branch name contains forbidden characters: ${JSON.stringify(t)}`);
  if (t.startsWith("-"))            throw new Error(`Branch name cannot start with '-': ${JSON.stringify(t)}`);
  if (t.endsWith(".lock"))          throw new Error(`Branch name cannot end with '.lock': ${JSON.stringify(t)}`);
  if (t.includes(".."))             throw new Error(`Branch name cannot contain '..': ${JSON.stringify(t)}`);
  if (t.includes("@{"))             throw new Error(`Branch name cannot contain '@{': ${JSON.stringify(t)}`);
  if (t === "HEAD")                 throw new Error("Branch name cannot be 'HEAD'.");
  return t;
}

// ── Safe git execution ────────────────────────────────────────────────────────

/**
 * Run a git command with an explicit args array.
 * Output is captured and returned as a trimmed string.
 * Returns "" on non-zero exit (never throws).
 *
 * Equivalent to the old shq(`git -C "..." <args>`) pattern but without
 * shell interpolation.
 */
export function gitq(repoPath, args) {
  const r = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio:    ["ignore", "pipe", "pipe"],
    shell:    false,
  });
  return (r.stdout || "").trim();
}

/**
 * Run a git command with output shown to the user (stdio: inherit).
 * Throws on non-zero exit.
 *
 * Equivalent to the old sh(`git -C "..." <args>`) pattern but without
 * shell interpolation.
 */
export function gitExec(repoPath, args) {
  const r = spawnSync("git", ["-C", repoPath, ...args], { stdio: "inherit", shell: false });
  if (r.status !== 0 && r.status !== null) {
    throw new Error(`git ${args.join(" ")} failed (exit ${r.status})`);
  }
}

/**
 * Run a gh (GitHub CLI) command with an explicit args array.
 * Output shown to user. Throws on non-zero exit.
 */
export function ghExec(args) {
  const r = spawnSync("gh", args, { stdio: "inherit", shell: false });
  if (r.status !== 0 && r.status !== null) {
    throw new Error(`gh ${args[0]} failed (exit ${r.status})`);
  }
}

/**
 * Run a gh command capturing output.
 * Returns "" on failure (never throws).
 */
export function ghq(args) {
  const r = spawnSync("gh", args, {
    encoding: "utf8",
    stdio:    ["ignore", "pipe", "pipe"],
    shell:    false,
  });
  return (r.stdout || "").trim();
}
