/**
 * crucible — github.js
 *
 * GitHub CLI integration for repo browsing and account management.
 *
 * All operations go through the `gh` CLI using safe spawnSync calls (no shell
 * interpolation).  The gh CLI handles token storage securely — crucible does
 * not store or transmit GitHub tokens itself.
 *
 * Public API:
 *   getGhAuthStatus()           → { installed, authed, username }
 *   listUserRepos(opts)         → repo[]
 *   listOrgRepos(handle, opts)  → repo[]
 *   searchRepos(query, opts)    → repo[]
 *   runGhAuthLogin()            → bool
 *   runGhAuthLogout()           → bool
 */

import { spawnSync } from "child_process";
import { safeEnv }   from "./safety.js";

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Run a gh command capturing stdout.
 * Returns trimmed stdout string, or "" on failure.
 */
function ghCapture(args) {
  const r = spawnSync("gh", args, {
    encoding: "utf8",
    stdio:    ["ignore", "pipe", "pipe"],
    shell:    false,
    env:      safeEnv(),
  });
  return (r.stdout || "").trim();
}

/**
 * Run a gh command with stdio inherited (interactive).
 * Returns true if exit code was 0.
 */
function ghInteractive(args) {
  const r = spawnSync("gh", args, {
    stdio:  "inherit",
    shell:  false,
    env:    safeEnv(),
  });
  return r.status === 0;
}

/**
 * Parse gh JSON output, returning [] on any error.
 */
function parseJson(raw) {
  try { return JSON.parse(raw || "[]"); }
  catch { return []; }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Check whether the gh CLI is installed and authenticated.
 *
 * Returns:
 *   { installed: false, authed: false, username: null }   — gh not found
 *   { installed: true,  authed: false, username: null }   — not authenticated
 *   { installed: true,  authed: true,  username: string } — authenticated
 */
export function getGhAuthStatus() {
  // Check if gh binary is runnable (more portable than `which`)
  const probe = spawnSync("gh", ["--version"], {
    encoding: "utf8",
    stdio:    ["ignore", "pipe", "pipe"],
    shell:    false,
  });
  if (probe.status !== 0) return { installed: false, authed: false, username: null };

  // gh auth status exits non-zero when not logged in
  const authCheck = spawnSync("gh", ["auth", "status"], {
    encoding: "utf8",
    stdio:    ["ignore", "pipe", "pipe"],
    shell:    false,
    env:      safeEnv(),
  });
  if (authCheck.status !== 0) return { installed: true, authed: false, username: null };

  // Extract username: "Logged in to github.com account <username> ..."
  const output = (authCheck.stderr || "") + (authCheck.stdout || "");
  const match  = output.match(/account\s+([A-Za-z0-9_-]+)/i);
  let username = match ? match[1] : null;

  // Fall back to API call if regex didn't match
  if (!username) {
    username = ghCapture(["api", "/user", "--jq", ".login"]) || null;
  }

  return { installed: true, authed: true, username };
}

/**
 * Run `gh auth login` interactively.
 * Returns true if the login succeeded (exit 0).
 */
export function runGhAuthLogin() {
  return ghInteractive(["auth", "login"]);
}

/**
 * Run `gh auth logout` interactively.
 * Returns true if logout succeeded.
 */
export function runGhAuthLogout() {
  return ghInteractive(["auth", "logout"]);
}

// ── Repo listing ──────────────────────────────────────────────────────────────

const REPO_JSON_FIELDS = "nameWithOwner,name,description,isPrivate,updatedAt";

/**
 * List repositories for the authenticated user.
 *
 * opts:
 *   limit  {number}  max repos to return (capped at 100, default 60)
 *   source {boolean} if true, exclude forks
 *
 * Returns array of:
 *   { nameWithOwner, name, description, isPrivate, updatedAt }
 */
export function listUserRepos({ limit = 60, source = false } = {}) {
  const args = [
    "repo", "list",
    "--limit", String(Math.min(Math.max(1, limit), 100)),
    "--json",  REPO_JSON_FIELDS,
  ];
  if (source) args.push("--source");
  return parseJson(ghCapture(args));
}

/**
 * List repositories for a specific GitHub user or organisation.
 *
 * handle: GitHub login or org name (e.g. "torvalds", "nodejs")
 * opts.limit: max repos (capped at 100, default 60)
 *
 * Returns same shape as listUserRepos.
 */
export function listOrgRepos(handle, { limit = 60 } = {}) {
  if (!handle || typeof handle !== "string") return [];
  return parseJson(ghCapture([
    "repo", "list", handle.trim(),
    "--limit", String(Math.min(Math.max(1, limit), 100)),
    "--json",  REPO_JSON_FIELDS,
  ]));
}

/**
 * Search public GitHub repositories matching a query string.
 *
 * query: search terms (e.g. "react hooks", "user:octocat")
 * opts.limit: max results (capped at 30, default 20)
 *
 * Returns same shape as listUserRepos.
 */
export function searchRepos(query, { limit = 20 } = {}) {
  if (!query || typeof query !== "string") return [];
  return parseJson(ghCapture([
    "search", "repos", query.trim(),
    "--limit", String(Math.min(Math.max(1, limit), 30)),
    "--json",  REPO_JSON_FIELDS,
  ]));
}
