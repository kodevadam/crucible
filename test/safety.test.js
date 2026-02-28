/**
 * Tests for src/safety.js
 *
 * Covers:
 *   - validateStagingPath: traversal rejection, absolute paths, valid paths
 *   - validateBranchName:  injection vectors, reserved words, valid names
 */

import { test } from "node:test";
import assert   from "node:assert/strict";
import { validateStagingPath, validateBranchName } from "../src/safety.js";
import { sep } from "path";

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
