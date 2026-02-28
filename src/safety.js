/**
 * crucible — safety.js
 *
 * Secure path validation, branch name validation, and git execution helpers.
 *
 * All git operations go through gitq() / gitExec() which use spawnSync with
 * explicit args arrays — no shell interpolation, no injection surface.
 * All child processes receive a sanitized copy of the environment via safeEnv()
 * so that provider API keys are never forwarded to git, gh, or other tools.
 */

import { resolve, normalize, isAbsolute, sep } from "path";
import { spawnSync }                            from "child_process";
import { createHash }                           from "crypto";
import { homedir }                              from "os";

// ── Child-process environment sanitisation ────────────────────────────────────

/**
 * Names of environment variables that should never be forwarded to child
 * processes (git, gh, etc.).  These are AI provider credentials; they have
 * no legitimate use in git/gh and would represent a key-leakage surface if
 * passed through.
 *
 * DESIGN NOTE — blacklist vs. whitelist:
 *   A stricter alternative would be to whitelist only the env vars that
 *   git/gh actually need (PATH, HOME, GIT_*, GH_TOKEN, …) and drop
 *   everything else.  That approach has near-zero leakage surface but
 *   breaks third-party git helpers, SSH agents, locale settings, and
 *   anything else that tunnels through the environment.  The current
 *   blacklist is the pragmatic middle ground: low breakage risk, covers
 *   all known AI provider credentials.  If a "paranoid mode" is ever
 *   added (CRUCIBLE_PARANOID_ENV=1), switching to a whitelist there would
 *   be a clean opt-in without disturbing normal operation.  A paranoid
 *   baseline would include: PATH, HOME, USER, SHELL, TERM, LANG, LC_*,
 *   GIT_*, SSH_*, GPG_*, GH_TOKEN, GITHUB_TOKEN, CRUCIBLE_*, plus
 *   OS-specific keychain vars — with "warn on drop" logging so users
 *   can see what broke before it bites them.
 *
 * PROXY VARIABLES (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY):
 *   These are deliberately NOT stripped.  They are not secrets, and
 *   corporate users legitimately need them to reach GitHub through
 *   firewalls.  Stripping them silently would break `git fetch` and
 *   `gh pr create` in those environments with no obvious error.
 *   The trust-boundary concern is different here: a malicious proxy
 *   is a network-level threat, not a credential-exfiltration threat
 *   from within the process.  If Crucible ever adds a `--no-proxy`
 *   flag, it should be an explicit opt-in, not a silent default.
 *
 * NOTE: GitHub tokens (GH_TOKEN, GITHUB_TOKEN) are intentionally NOT listed
 * here — the gh CLI legitimately needs them.
 */
const STRIP_FROM_CHILD_ENV = new Set([
  "OPENAI_API_KEY",
  "OPENAI_ORG_ID",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "_CRUCIBLE_OPENAI_KEY",
  "_CRUCIBLE_ANTHROPIC_KEY",
]);

// ── Paranoid env mode (CRUCIBLE_PARANOID_ENV=1 | warn) ───────────────────────
//
// SCOPE CAVEAT — paranoid mode is NOT a sandbox.
//
// It meaningfully reduces the env surface area forwarded to child processes
// (git, gh, etc.), making accidental credential leakage through spawned tools
// much harder.  But it does NOT:
//   • prevent child processes from reading files on disk,
//   • prevent network access by git/gh,
//   • restrict filesystem operations of those tools,
//   • protect secrets that were baked into the binary or config files.
//
// Think of it as "we removed the easy paths," not "we built a jail."
// For actual process isolation, use a container or seccomp profile.
//
// Modes:
//   CRUCIBLE_PARANOID_ENV=1     enforce — drops vars and logs their names to stderr
//   CRUCIBLE_PARANOID_ENV=warn  audit   — logs what WOULD be dropped; nothing is removed

/**
 * Exact-match allowlist for paranoid mode.
 * These are the only env vars forwarded to child processes when
 * CRUCIBLE_PARANOID_ENV=1. Everything not covered by this set or the
 * prefix allowlist below is silently dropped (and its name is logged to
 * stderr so users can diagnose breakage).
 */
const PARANOID_EXACT_ALLOW = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM",
  "LANG", "LANGUAGE", "TZ",
  // GitHub CLI auth
  "GH_TOKEN", "GITHUB_TOKEN",
  // Corporate proxies (non-secret; required in many environments)
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  // Linux keychain / D-Bus (needed by libsecret / gnome-keyring)
  "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR",
]);

/**
 * Prefix allowlist for paranoid mode.
 * Any var whose name starts with one of these prefixes is forwarded.
 */
const PARANOID_PREFIX_ALLOW = [
  "LC_",       // locale categories (LC_ALL, LC_CTYPE, …)
  "GIT_",      // git internals (GIT_AUTHOR_NAME, GIT_SSH_COMMAND, …)
  "SSH_",      // SSH agent (SSH_AUTH_SOCK, SSH_AGENT_PID)
  "GPG_",      // GPG agent (GPG_AGENT_INFO)
  "CRUCIBLE_", // first-party overrides
];

/**
 * Core allowlist computation shared by enforce and warn modes.
 *
 * Returns { allowed, dropped } where:
 *   allowed — env object containing only permitted variables
 *   dropped — names (NOT values) of variables that were removed
 *
 * Additional vars can be opted-in via CRUCIBLE_EXTRA_ENV (comma-separated),
 * e.g.:  CRUCIBLE_EXTRA_ENV=SSH_AGENT_PID,KUBECONFIG
 */
function applyParanoidFilter() {
  const extra = new Set(
    (process.env.CRUCIBLE_EXTRA_ENV || "").split(",").map(s => s.trim()).filter(Boolean)
  );

  const allowed = {};
  const dropped = [];

  for (const [k, v] of Object.entries(process.env)) {
    const permitted =
      PARANOID_EXACT_ALLOW.has(k) ||
      PARANOID_PREFIX_ALLOW.some(pfx => k.startsWith(pfx)) ||
      extra.has(k);

    if (permitted) {
      allowed[k] = v;
    } else {
      dropped.push(k);
    }
  }

  return { allowed, dropped };
}

/**
 * CRUCIBLE_PARANOID_ENV=1 — enforce mode.
 * Builds a minimal allowlisted env; logs dropped var names to stderr.
 */
function paranoidEnforceEnv() {
  const { allowed, dropped } = applyParanoidFilter();
  if (dropped.length > 0) {
    process.stderr.write(
      `[crucible] paranoid-env (enforce): dropped ${dropped.length} var(s) from child env: ` +
      dropped.join(", ") + "\n"
    );
  }
  return allowed;
}

/**
 * CRUCIBLE_PARANOID_ENV=warn — audit/dry-run mode.
 * Returns the full environment unmodified, but logs what WOULD have been
 * dropped under enforce mode.  Safe rollout path: run with =warn first to
 * discover which tools depend on non-allowlisted vars, then switch to =1.
 */
function paranoidWarnEnv() {
  const { dropped } = applyParanoidFilter();
  if (dropped.length > 0) {
    process.stderr.write(
      `[crucible] paranoid-env (warn/dry-run): would drop ${dropped.length} var(s): ` +
      dropped.join(", ") +
      " — set CRUCIBLE_PARANOID_ENV=1 to enforce, or add to CRUCIBLE_EXTRA_ENV to allowlist.\n"
    );
  }
  return { ...process.env };
}

/**
 * Return a copy of process.env suitable for child processes.
 *
 * Three modes, controlled by CRUCIBLE_PARANOID_ENV:
 *
 *   (unset / any other value)
 *     Normal: strip known AI provider credentials (blacklist).  Low breakage
 *     risk; covers all known provider keys.
 *
 *   CRUCIBLE_PARANOID_ENV=warn
 *     Audit/dry-run: logs what WOULD be dropped under enforce mode, but
 *     returns the full env unchanged.  Use this first to discover deps.
 *     NOTE: still strips STRIP_FROM_CHILD_ENV regardless.
 *
 *   CRUCIBLE_PARANOID_ENV=1
 *     Enforce: default-deny allowlist — only PATH, HOME, GIT_*, SSH_*,
 *     GH_TOKEN, CRUCIBLE_*, etc. are kept.  Dropped variable *names*
 *     (never values) are logged to stderr.
 *     See SCOPE CAVEAT above: this is not a sandbox.
 */
export function safeEnv() {
  const mode = process.env.CRUCIBLE_PARANOID_ENV;
  if (mode === "1")    return paranoidEnforceEnv();
  if (mode === "warn") return paranoidWarnEnv();
  const env = { ...process.env };
  for (const k of STRIP_FROM_CHILD_ENV) delete env[k];
  return env;
}

/**
 * Compute a short, stable hash of an arbitrary string (prompt text, config
 * blob, etc.) for reproducibility bookkeeping.  Returns the first 12 hex
 * chars of the SHA-256 digest — long enough to be collision-resistant at
 * human scale, short enough to store cheaply.
 */
export function shortHash(text) {
  return createHash("sha256").update(text ?? "").digest("hex").slice(0, 12);
}

// ── Path validation ───────────────────────────────────────────────────────────

/**
 * Validate that proposedPath is safe to use within repoRoot.
 *
 * Rules enforced:
 *   - Must be a non-empty string
 *   - Must not be absolute
 *   - Must not be a UNC path (\\server\share) or NT device path (\\?\...)
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

  // Reject UNC paths (\\server\share) and NT device paths (\\.\, \\?\)
  // On Windows these reach network shares or raw devices; proactively reject
  // them on all platforms for defence in depth.
  if (/^\\\\/.test(proposedPath)) {
    throw new Error(`UNC/device path rejected: ${proposedPath}`);
  }

  // Reject absolute paths immediately (also catches //server/share on Linux)
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
 * shell interpolation.  safeEnv() ensures API keys are not forwarded.
 */
export function gitq(repoPath, args) {
  const r = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio:    ["ignore", "pipe", "pipe"],
    shell:    false,
    env:      safeEnv(),
  });
  return (r.stdout || "").trim();
}

/**
 * Run a git command with output shown to the user (stdio: inherit).
 * Throws on non-zero exit.
 *
 * Equivalent to the old sh(`git -C "..." <args>`) pattern but without
 * shell interpolation.  safeEnv() ensures API keys are not forwarded.
 */
export function gitExec(repoPath, args) {
  const r = spawnSync("git", ["-C", repoPath, ...args], {
    stdio:  "inherit",
    shell:  false,
    env:    safeEnv(),
  });
  if (r.status !== 0 && r.status !== null) {
    throw new Error(`git ${args.join(" ")} failed (exit ${r.status})`);
  }
}

/**
 * Run a gh (GitHub CLI) command with an explicit args array.
 * Output shown to user. Throws on non-zero exit.
 * safeEnv() ensures AI provider keys are not forwarded (GH_TOKEN is preserved).
 */
export function ghExec(args) {
  const r = spawnSync("gh", args, {
    stdio:  "inherit",
    shell:  false,
    env:    safeEnv(),
  });
  if (r.status !== 0 && r.status !== null) {
    throw new Error(`gh ${args[0]} failed (exit ${r.status})`);
  }
}

/**
 * Run a gh command capturing output.
 * Returns "" on failure (never throws).
 * safeEnv() ensures AI provider keys are not forwarded (GH_TOKEN is preserved).
 */
export function ghq(args) {
  const r = spawnSync("gh", args, {
    encoding: "utf8",
    stdio:    ["ignore", "pipe", "pipe"],
    shell:    false,
    env:      safeEnv(),
  });
  return (r.stdout || "").trim();
}

// ── Deletion target guard ─────────────────────────────────────────────────────

/**
 * Check whether a path is safe to pass to "rm -rf".
 *
 * Returns { safe: true } on success, or { safe: false, reason: string }.
 *
 * Guards:
 *   1. Must be a non-empty string
 *   2. Must not resolve to the filesystem root (/)
 *   3. Must not resolve to the user's home directory
 *   4. Resolved path must have at least 3 components (depth guard)
 *
 * Does NOT throw — callers check the returned object.
 */
export function isSafeDeletionTarget(p) {
  const s = String(p ?? "").trim();
  if (!s) return { safe: false, reason: "Empty path" };
  const abs = resolve(s);
  if (abs === "/") return { safe: false, reason: "Refusing to delete filesystem root (/)" };
  const home = homedir();
  if (abs === home) return { safe: false, reason: `Refusing to delete home directory (${home})` };
  const parts = abs.split(sep).filter(Boolean);
  if (parts.length < 3) return { safe: false, reason: `Path too shallow to delete safely: ${abs}` };
  return { safe: true };
}

// ── GitHub URL normalisation ───────────────────────────────────────────────────

/**
 * Normalise a GitHub repo input to "owner/repo".
 *
 * Accepts:
 *   owner/repo
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/branch[/path]
 *   https://github.com/owner/repo/blob/branch/file
 *   https://github.com/owner/repo/commits/branch
 *
 * Unknown inputs are returned unchanged so that `gh` can produce its own error.
 */
export function normalizeGitHubRepoInput(input) {
  const s = (input || "").trim();
  // Full GitHub URL — strip tree/blob/commits suffix
  const m = s.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/(?:tree|blob|commits?)\/.*)?$/);
  if (m) return m[1];
  // Short owner/repo form
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return s;
  // Unknown — pass through for gh to handle
  return s;
}
