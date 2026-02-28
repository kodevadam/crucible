/**
 * Tests for staging safety behaviour.
 *
 * These are unit tests for path validation within the staging workflow.
 * They do NOT require API keys or a real git repo.
 *
 * Covers:
 *   - validateStagingPath correctly guards staging operations
 *   - Malicious paths from model output are rejected before any disk op
 *   - Valid paths pass through
 */

import { test } from "node:test";
import assert   from "node:assert/strict";
import { validateStagingPath } from "../src/safety.js";

// ── Path traversal scenarios ──────────────────────────────────────────────────

const REPO = "/home/user/project";

const MALICIOUS_PATHS = [
  "../../etc/passwd",
  "../../../root/.ssh/id_rsa",
  "a/../../b/../../etc/shadow",
  "/etc/passwd",
  "/root/.bashrc",
];

for (const p of MALICIOUS_PATHS) {
  test(`validateStagingPath rejects: ${p}`, () => {
    assert.throws(
      () => validateStagingPath(REPO, p),
      (err) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });
}

// URL-encoded paths: %2F is a literal character in file names, not a separator.
// path.normalize keeps it as-is, so it's treated as a safe literal filename
// (not traversal). The file system won't treat %2F as / on POSIX.
test("validateStagingPath: URL-encoded path treated as literal (not traversal)", () => {
  // Should NOT throw — %2F is not a path separator
  const result = validateStagingPath(REPO, "..%2F..%2Fetc%2Fpasswd");
  assert.ok(typeof result === "string");
});

// ── Valid paths ───────────────────────────────────────────────────────────────

const VALID_PATHS = [
  "src/index.js",
  "lib/utils/helper.ts",
  "README.md",
  "a/b/c/d/e.txt",
  "package.json",
  ".env.example",
];

for (const p of VALID_PATHS) {
  test(`validateStagingPath accepts: ${p}`, () => {
    const result = validateStagingPath(REPO, p);
    assert.ok(typeof result === "string");
    assert.ok(result.startsWith(REPO));
    assert.ok(!result.includes(".."));
  });
}

// ── Boundary check ────────────────────────────────────────────────────────────

test("validateStagingPath: resolved path must start with repoRoot", () => {
  const resolved = validateStagingPath("/tmp/myrepo", "deep/nested/file.js");
  assert.ok(resolved.startsWith("/tmp/myrepo/"));
});

test("validateStagingPath: does not allow escaping via symlink-like path", () => {
  // Even if someone passes 'src/../../../etc/passwd', normalize catches it
  assert.throws(
    () => validateStagingPath("/repo", "src/../../../etc/passwd"),
    /traversal/i
  );
});

// ── Null / empty input ────────────────────────────────────────────────────────

test("validateStagingPath: rejects null", () => {
  assert.throws(() => validateStagingPath("/repo", null), /non-empty string/i);
});

test("validateStagingPath: rejects undefined", () => {
  assert.throws(() => validateStagingPath("/repo", undefined), /non-empty string/i);
});

test("validateStagingPath: rejects empty string", () => {
  assert.throws(() => validateStagingPath("/repo", ""), /non-empty string/i);
});

// ── Windows-style paths on Linux ─────────────────────────────────────────────

test("validateStagingPath: Windows absolute path C:\\... is relative on Linux", () => {
  // On Linux, 'C:\\Users\\foo' is not isAbsolute(), so it's treated as a
  // relative path with backslash in the name — should not throw and should
  // remain inside the repo root.
  const r = validateStagingPath("/repo", "C:\\Users\\foo");
  assert.ok(typeof r === "string");
  assert.ok(r.startsWith("/repo"));
});

test("validateStagingPath: Windows-style traversal C:\\..\\.. stays inside root", () => {
  // '\\' is normalised to '/' on Linux but '..' is still checked
  // If the path contains '..' after normalisation it must be rejected
  // 'C:\..\..\ after normalize → still has '..' → rejected
  // Note: on Linux, path.normalize("C:\\..\\..") = "C:\\..\\.." (no change)
  // The split on /[/\\]/ will find ".." segments → rejected
  assert.throws(
    () => validateStagingPath("/repo", "C:\\..\\..\\etc\\passwd"),
    /traversal/i
  );
});
