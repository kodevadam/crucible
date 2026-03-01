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

import { spawnSync }    from "child_process";
import { readFileSync } from "fs";
import { join }         from "path";
import { safeEnv }      from "./safety.js";

// ── Failure enrichment constants ──────────────────────────────────────────────

const ENRICH_MAX_REFS      = 5;   // max stack-ref locations to auto-read
const ENRICH_CONTEXT_LINES = 8;   // lines above and below the failing line

// ── Failure signature helpers (Phase D) ──────────────────────────────────────

/**
 * Strip volatile tokens from a failure message so the same logical failure
 * produces the same signature across runs.
 *
 * Strips: hex addresses, UUIDs, ISO timestamps, large numeric IDs.
 * Keeps: error class names, assertion text, file names.
 */
function normalizeMessage(msg) {
  return (msg || "")
    .replace(/0x[0-9a-fA-F]{4,}/g,                                           "<addr>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+\-]+/g,                              "<ts>")
    .replace(/\b\d{10,13}\b/g,                                               "<id>")
    .trim();
}

/**
 * Extract normalised failure signatures from combined test output.
 * Used by compareIterations to detect "peeling the onion" progress even
 * when the raw failure count stays the same.
 *
 * Signature format: "<kind>::<normalised-message>"
 *
 * @param {string} stdout
 * @param {string} stderr
 * @returns {string[]} Up to 20 deduplicated signatures
 */
export function extractFailureSignatures(stdout, stderr) {
  const text = (stdout || "") + "\n" + (stderr || "");
  const sigs = new Set();

  // Error class: message  (AssertionError, TypeError, RangeError, FAILED, …)
  const ERROR_RE = /\b(\w*Error|\w*Exception|FAIL(?:URE)?|FAILED)\b[:\s]+(.{5,120})/gm;
  let m;
  while ((m = ERROR_RE.exec(text)) !== null) {
    const [, cls, raw] = m;
    sigs.add(`${cls}::${normalizeMessage(raw.slice(0, 100))}`);
  }

  // Jest bullet markers: ● test suite name
  const JEST_RE = /^\s*● (.{5,120})/gm;
  while ((m = JEST_RE.exec(text)) !== null) {
    sigs.add(`jest::${normalizeMessage(m[1].slice(0, 100))}`);
  }

  // TAP "not ok N - description"
  const TAP_RE = /^not ok \d+ - (.{3,120})/gm;
  while ((m = TAP_RE.exec(text)) !== null) {
    sigs.add(`tap::${normalizeMessage(m[1].slice(0, 100))}`);
  }

  return [...sigs].slice(0, 20);
}

// ── Stack reference extractor (Phase C) ──────────────────────────────────────

/**
 * Parse file:line references from a Node.js / TypeScript stack trace.
 * Skips node internals (node:*), node_modules, and internal/ paths.
 * Prefers userland frames first (assertion site, then first non-library frame).
 *
 * @param {string} text - Combined stdout + stderr
 * @returns {Array<{rawPath: string, line: number}>} Up to ENRICH_MAX_REFS entries
 */
export function extractStackRefs(text) {
  if (!text) return [];

  const refs = [];
  const seen = new Set();

  // Matches: at Optional.Name (/abs/path/file.js:42:5)
  //          at /abs/path/file.js:42:5
  //          at file:///abs/path/file.ts:42:5
  const FRAME_RE =
    /at\s+(?:[^()\s]+\s+\()?(?:file:\/\/\/?)?((?:[A-Za-z]:[\\/]|\/)[^\s()'"]+\.(?:[jt]sx?|mjs|cjs)):(\d+)(?::\d+)?\)?/g;

  let m;
  while ((m = FRAME_RE.exec(text)) !== null) {
    const rawPath = m[1].replace(/\\/g, "/");
    const line    = parseInt(m[2], 10);

    if (rawPath.includes("node_modules")) continue;
    if (rawPath.includes("/internal/"))   continue;
    if (rawPath.startsWith("node:"))      continue;

    const key = `${rawPath}:${line}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ rawPath, line });
    }
  }

  return refs.slice(0, ENRICH_MAX_REFS);
}

/**
 * Enrich a test-iteration result with code snippets from the worktree at the
 * locations referenced in the failure's stack trace.
 *
 * Reads from the worktree (not main tree) so the model sees the code it just
 * produced, not HEAD state.
 *
 * @param {object} result - runTestIteration result
 * @param {string} wtPath - Absolute path to the worktree root
 * @returns {{ excerpt: string, refs: Array<{path, line, snippet}> }}
 */
export function enrichFailureContext(result, wtPath) {
  if (!wtPath) return { excerpt: result.excerpt, refs: [] };

  const combined = (result.stdout || "") + "\n" + (result.stderr || "");
  const rawRefs  = extractStackRefs(combined);
  const enriched = [];

  for (const { rawPath, line } of rawRefs) {
    // Convert absolute worktree path → repo-relative
    let relPath = rawPath;
    if (rawPath.startsWith(wtPath + "/")) {
      relPath = rawPath.slice(wtPath.length + 1);
    } else if (rawPath.startsWith(wtPath)) {
      relPath = rawPath.slice(wtPath.length).replace(/^\//, "");
    }

    // Skip refs that point outside the worktree (e.g. system libs)
    if (relPath === rawPath && !relPath.startsWith(".")) continue;

    const absPath = join(wtPath, relPath);
    try {
      const content = readFileSync(absPath, "utf8");
      const lines   = content.split("\n");
      const start   = Math.max(0, line - 1 - ENRICH_CONTEXT_LINES);
      const end     = Math.min(lines.length, line + ENRICH_CONTEXT_LINES);
      const snippet = lines
        .slice(start, end)
        .map((l, i) => `${start + i + 1}: ${l}`)
        .join("\n");

      enriched.push({ path: relPath, line, snippet });
    } catch {
      // File not readable — skip silently
    }

    if (enriched.length >= ENRICH_MAX_REFS) break;
  }

  return { excerpt: result.excerpt, refs: enriched };
}

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
  const excerpt           = extractFailureExcerpt(combined);
  const failureSignatures = exitCode !== 0
    ? extractFailureSignatures(stdout, stderr)
    : [];

  return {
    exitCode,
    stdout,
    stderr,
    failureCount,
    failureCountApprox,
    excerpt,
    failureSignatures,
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
/**
 * Compare two runTestIteration results.
 * Determines whether the repair loop is making progress (N vs N-1).
 *
 * Failure-count comparison is the primary signal. When counts are equal,
 * signature comparison detects "peeling the onion" progress — the model fixed
 * one failure and uncovered another. Same count + different signatures = improved.
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

  // Counts are equal. Check failure signatures to detect "peeling the onion":
  // fixing one failure reveals another → different signatures = progress.
  const prevSigs = prev.failureSignatures;
  const currSigs = curr.failureSignatures;

  if (!prevSigs?.length || !currSigs?.length) return "same"; // no signature data

  const prevSet = new Set(prevSigs);
  const unchanged = currSigs.every(s => prevSet.has(s)) && currSigs.length === prevSigs.length;

  return unchanged ? "same" : "improved";
}
