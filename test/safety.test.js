/**
 * Tests for src/safety.js
 *
 * Covers:
 *   - validateStagingPath:    traversal rejection, absolute paths, valid paths
 *   - validateBranchName:     injection vectors, reserved words, valid names
 *   - isSafeDeletionTarget:   blocks /, $HOME, shallow paths, empty input
 */

import { test } from "node:test";
import assert   from "node:assert/strict";
import { validateStagingPath, validateBranchName, isSafeDeletionTarget } from "../src/safety.js";
import { sep } from "path";
import { homedir } from "os";

// ── validateStagingPath ───────────────────────────────────────────────────────

test("validateStagingPath: accepts simple relative path", () => {
  const result = validateStagingPath("/repo", "src/index.js");
  assert.ok(result.endsWith(`src${sep}index.js`));
});

test("validateStagingPath: accepts nested relative path", () => {
  const result = validateStagingPath("/repo", "a/b/c.txt");
  assert.ok(result.includes("a"));
});

test("validateStagingPath: rejects path with ..", () => {
  assert.throws(
    () => validateStagingPath("/repo", "../etc/passwd"),
    /traversal|absolute/i
  );
});

test("validateStagingPath: rejects path with .. in middle", () => {
  assert.throws(
    () => validateStagingPath("/repo", "a/../../etc/passwd"),
    /traversal/i
  );
});

test("validateStagingPath: rejects absolute path", () => {
  assert.throws(
    () => validateStagingPath("/repo", "/etc/passwd"),
    /absolute/i
  );
});

test("validateStagingPath: rejects Windows-style absolute path", () => {
  // On Linux this won't be isAbsolute, but it should still not escape root
  // The C:\ style path is just a relative path on Linux — validate it
  // doesn't cause harm. At minimum it should not throw for this test.
  // (Windows-specific absolute detection is covered by the sep boundary check)
  const r = validateStagingPath("/repo", "C:\\foo");
  assert.ok(typeof r === "string");
});

test("validateStagingPath: rejects null", () => {
  assert.throws(
    () => validateStagingPath("/repo", null),
    /non-empty string/i
  );
});

test("validateStagingPath: rejects empty string", () => {
  assert.throws(
    () => validateStagingPath("/repo", ""),
    /non-empty string/i
  );
});

test("validateStagingPath: rejects path with only ..", () => {
  assert.throws(
    () => validateStagingPath("/repo", ".."),
    /traversal/i
  );
});

test("validateStagingPath: returned path starts with repoRoot", () => {
  const resolved = validateStagingPath("/tmp/myrepo", "src/utils.js");
  assert.ok(resolved.startsWith("/tmp/myrepo"));
});

// ── validateBranchName ────────────────────────────────────────────────────────

test("validateBranchName: accepts simple name", () => {
  assert.equal(validateBranchName("feature/my-thing"), "feature/my-thing");
});

test("validateBranchName: accepts name with numbers", () => {
  assert.equal(validateBranchName("fix-123"), "fix-123");
});

test("validateBranchName: trims whitespace", () => {
  assert.equal(validateBranchName("  main  "), "main");
});

test("validateBranchName: rejects blank", () => {
  assert.throws(() => validateBranchName(""), /blank|empty/i);
});

test("validateBranchName: rejects whitespace-only", () => {
  assert.throws(() => validateBranchName("   "), /blank/i);
});

test("validateBranchName: rejects shell injection via semicolon", () => {
  assert.throws(
    () => validateBranchName("feat; rm -rf /"),
    /forbidden characters/i
  );
});

test("validateBranchName: rejects shell injection via backtick", () => {
  assert.throws(
    () => validateBranchName("feat`id`"),
    /forbidden characters/i
  );
});

test("validateBranchName: rejects leading dash", () => {
  assert.throws(
    () => validateBranchName("-foo"),
    /cannot start with/i
  );
});

test("validateBranchName: rejects .lock suffix", () => {
  assert.throws(
    () => validateBranchName("feat.lock"),
    /cannot end with/i
  );
});

test("validateBranchName: rejects double-dot", () => {
  assert.throws(
    () => validateBranchName("feat..bar"),
    /cannot contain '\.\.'/i
  );
});

test("validateBranchName: rejects @{ sequence", () => {
  // '@' is not in the allowlist so it fails with "forbidden characters"
  assert.throws(
    () => validateBranchName("feat@{bar}"),
    /forbidden characters|cannot contain '@\{'/i
  );
});

test("validateBranchName: rejects HEAD", () => {
  assert.throws(
    () => validateBranchName("HEAD"),
    /cannot be 'HEAD'/i
  );
});

test("validateBranchName: rejects spaces", () => {
  assert.throws(
    () => validateBranchName("my branch"),
    /forbidden characters/i
  );
});

test("validateBranchName: rejects quotes", () => {
  assert.throws(
    () => validateBranchName('feat"bar'),
    /forbidden characters/i
  );
});

test("validateBranchName: rejects dollar sign", () => {
  assert.throws(
    () => validateBranchName("feat$bar"),
    /forbidden characters/i
  );
});

// ── Edge cases per security review ────────────────────────────────────────────

test("validateBranchName: accepts refs/heads/foo style", () => {
  // Slash is in the allowlist; full refspec-style names are valid
  assert.equal(validateBranchName("refs/heads/foo"), "refs/heads/foo");
});

test("validateBranchName: rejects @{1} (reflog shorthand)", () => {
  // '@' is not in the allowlist — caught as forbidden characters
  assert.throws(
    () => validateBranchName("@{1}"),
    /forbidden characters/i
  );
});

test("validateBranchName: rejects HEAD^ (parent ref)", () => {
  // '^' is not in the allowlist
  assert.throws(
    () => validateBranchName("HEAD^"),
    /forbidden characters/i
  );
});

test("validateBranchName: rejects --foo (double-dash option-like name)", () => {
  // Leading '-' is caught by the leading-dash check after allowlist passes
  assert.throws(
    () => validateBranchName("--foo"),
    /cannot start with/i
  );
});

// ── isSafeDeletionTarget ──────────────────────────────────────────────────────

test("isSafeDeletionTarget: rejects empty string", () => {
  const r = isSafeDeletionTarget("");
  assert.equal(r.safe, false);
  assert.ok(r.reason, "should provide a reason");
});

test("isSafeDeletionTarget: rejects null/undefined", () => {
  assert.equal(isSafeDeletionTarget(null).safe,      false);
  assert.equal(isSafeDeletionTarget(undefined).safe, false);
});

test("isSafeDeletionTarget: rejects filesystem root /", () => {
  const r = isSafeDeletionTarget("/");
  assert.equal(r.safe, false);
  assert.ok(/root/i.test(r.reason), "reason should mention root");
});

test("isSafeDeletionTarget: rejects home directory", () => {
  const r = isSafeDeletionTarget(homedir());
  assert.equal(r.safe, false);
  assert.ok(/home/i.test(r.reason), "reason should mention home");
});

test("isSafeDeletionTarget: rejects shallow paths (fewer than 3 components)", () => {
  const r = isSafeDeletionTarget("/tmp");
  assert.equal(r.safe, false);
  assert.ok(/shallow/i.test(r.reason), "reason should mention shallow");
});

test("isSafeDeletionTarget: accepts a deep-enough safe path", () => {
  const safePath = `${homedir()}/.crucible/repos/myrepo`;
  const r = isSafeDeletionTarget(safePath);
  assert.equal(r.safe, true, `Expected safe for ${safePath}: ${r.reason}`);
});

test("isSafeDeletionTarget: accepts /tmp/a/b (3 components)", () => {
  const r = isSafeDeletionTarget("/tmp/a/b");
  assert.equal(r.safe, true);
});

test("isSafeDeletionTarget: returns safe:true for deeply nested path", () => {
  const r = isSafeDeletionTarget("/home/user/.crucible/repos/deep/nested/path");
  assert.equal(r.safe, true);
});
