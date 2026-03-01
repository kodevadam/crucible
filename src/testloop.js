/**
 * crucible — testloop.js
 *
 * Test iteration infrastructure for the repair loop (exec-layer-004).
 *
 * This module is a primitive. It runs a test command in a given directory
 * and returns a structured result. It does NOT drive the repair loop —
 * that is Phase 2 orchestration.
 *
 * Invariants:
 *   1. stdio: "pipe" always — caller decides what to surface to the user.
 *   2. safeEnv() on every spawn — no AI credentials leak to the test process.
 *   3. Failure count uses framework-specific parsers when detectable;
 *      generic fallback is flagged as approximate (failureCountApprox: true).
 *   4. Network isolation is detected, not enforced — Phase 2 enforces.
 *   5. checkNetworkIsolation() never throws — graceful degrade.
 *   6. Worktrees are the caller's responsibility — this module does not
 *      create or destroy them.
 */

import { spawnSync } from "child_process";
import { safeEnv }   from "./safety.js";

// ── Failure count parsers ─────────────────────────────────────────────────────

function parseTAP(output) {
  const m = output.match(/^# fail (\d+)/m);
  return m ? parseInt(m[1], 10) : null;
}

function parseJest(output) {
  const m = output.match(/Tests:.*?(\d+) failed/);
  return m ? parseInt(m[1], 10) : null;
}

function parseGeneric(output) {
  return output.split("\n")
    .filter(l => /\b(FAIL|ERROR|failed|error)\b/i.test(l))
    .length;
}

/**
 * Detect failure count from combined stdout+stderr.
 * Returns { failureCount, framework, failureCountApprox }.
 */
function detectFailures(combined) {
  const tap = parseTAP(combined);
  if (tap !== null) {
    return { failureCount: tap, framework: "tap", failureCountApprox: false };
  }

  const jest = parseJest(combined);
  if (jest !== null) {
    return { failureCount: jest, framework: "jest", failureCountApprox: false };
  }

  // Generic fallback — fuzzy; count may over-report due to stack traces
  const count = parseGeneric(combined);
  process.stderr.write(
    `[crucible/testloop] warning: could not detect test framework; ` +
    `failure count is a fuzzy estimate (${count} matching lines)\n`
  );
  return { failureCount: count, framework: "generic", failureCountApprox: true };
}

// ── Failure excerpt extractor ─────────────────────────────────────────────────

const EXCERPT_MAX = 1200;

/**
 * Extract a deterministic, bounded excerpt from test output.
 *
 * Priority order:
 *   1. Assertion lines (most specific — AssertionError, assert., expect()...)
 *   2. Stack trace lines following the first assertion hit
 *   3. Test name failure markers (✗, FAIL, not ok...)
 *   4. Last resort: last 20 lines of combined output
 *
 * @param {string} output - Combined stdout + stderr
 * @returns {string} Excerpt (max 1200 chars, truncated with "..." if longer)
 */
export function extractFailureExcerpt(output) {
  const lines = output.split("\n");

  // 1. Assertion lines
  const ASSERTION_RE = /AssertionError|assert\.|expect\(|Expected:/i;
  const assertionLines = lines.filter(l => ASSERTION_RE.test(l)).slice(0, 15);

  if (assertionLines.length > 0) {
    // 2. Stack trace lines following the first assertion
    const firstAssertIdx = lines.findIndex(l => ASSERTION_RE.test(l));
    const stackLines = lines
      .slice(firstAssertIdx + 1)
      .filter(l => /^\s+at /.test(l))
      .slice(0, 10);

    const excerpt = [...assertionLines, ...stackLines].join("\n");
    return excerpt.length > EXCERPT_MAX
      ? excerpt.slice(0, EXCERPT_MAX) + "..."
      : excerpt;
  }

  // 3. Test name failure markers
  const TEST_NAME_RE = /^  [✗✕×]|^\s*(FAIL|not ok)\s/;
  const testNameLines = lines.filter(l => TEST_NAME_RE.test(l)).slice(0, 5);

  if (testNameLines.length > 0) {
    const excerpt = testNameLines.join("\n");
    return excerpt.length > EXCERPT_MAX
      ? excerpt.slice(0, EXCERPT_MAX) + "..."
      : excerpt;
  }

  // 4. Last resort: last 20 lines
  const tail = lines.slice(-20).join("\n");
  return tail.length > EXCERPT_MAX
    ? tail.slice(0, EXCERPT_MAX) + "..."
    : tail;
}

// ── Network isolation detection ───────────────────────────────────────────────

/**
 * Detect (not enforce) whether Linux network namespaces are available.
 * Phase 2 will use this to attempt isolation if available.
 *
 * @returns {{ available: boolean, method: "netns" | "none" }}
 */
export function checkNetworkIsolation() {
  try {
    const r = spawnSync("ip", ["netns", "list"], {
      stdio:   "pipe",
      shell:   false,
      timeout: 2000,
      env:     safeEnv(),
    });
    // ENOENT means `ip` is not installed
    if (r.error && r.error.code === "ENOENT") {
      return { available: false, method: "none" };
    }
    // exit 0 = no namespaces, exit 1 = listed — either means ip+netns works
    if (r.status === 0 || r.status === 1) {
      return { available: true, method: "netns" };
    }
    return { available: false, method: "none" };
  } catch {
    return { available: false, method: "none" };
  }
}

// ── Test iteration runner ─────────────────────────────────────────────────────

/**
 * Run a test command inside a directory and return a structured result.
 *
 * The caller is responsible for providing a valid directory (worktree or
 * repo root). This function does not create or destroy worktrees.
 *
 * @param {string} wtPath          - Absolute path to run the command in
 * @param {string} testCmd         - Command string, e.g. "npm test"
 * @param {object} [opts]
 * @param {number} [opts.timeout]  - Milliseconds before kill (default: 120 000)
 * @returns {object} Structured iteration result
 */
export async function runTestIteration(wtPath, testCmd, opts = {}) {
  const timeout   = opts.timeout ?? 120_000;
  const isolation = checkNetworkIsolation();

  // Minimal shell split: handles space-separated args without quoting edge-cases.
  // Full shell parsing is unnecessary complexity for v1.
  const parts = testCmd.trim().split(/\s+/);
  const cmd   = parts[0];
  const args  = parts.slice(1);

  const start = Date.now();
  const r = spawnSync(cmd, args, {
    cwd:     wtPath,
    stdio:   "pipe",
    shell:   false,
    env:     safeEnv(),
    timeout,
  });
  const durationMs = Date.now() - start;

  const stdout   = r.stdout?.toString() ?? "";
  const stderr   = r.stderr?.toString() ?? "";
  const combined = stdout + "\n" + stderr;
  const exitCode = r.status ?? (r.error ? 1 : 0);

  const { failureCount, framework, failureCountApprox } = detectFailures(combined);
  const excerpt = extractFailureExcerpt(combined);

  return {
    exitCode,
    stdout,
    stderr,
    failureCount,
    failureCountApprox,
    excerpt,
    framework,
    networkIsolated:        isolation.available,
    networkIsolationMethod: isolation.method,
    durationMs,
  };
}

// ── Iteration comparator ──────────────────────────────────────────────────────

/**
 * Compare two runTestIteration results.
 * Determines whether the repair loop is making progress (N vs N-1).
 *
 * @param {object} prev - Previous iteration result
 * @param {object} curr - Current iteration result
 * @returns {"improved" | "worse" | "same" | "unknown"}
 */
export function compareIterations(prev, curr) {
  const p = prev.failureCount;
  const c = curr.failureCount;

  // If exactly one count is unknown (-1), we cannot compare
  if (p === -1 && c !== -1) return "unknown";
  if (c === -1 && p !== -1) return "unknown";

  if (c < p) return "improved";
  if (c > p) return "worse";
  return "same";
}
