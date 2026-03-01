/**
 * crucible — test/patchops.test.js
 *
 * Tests for src/patchops.js — the exec-layer-003 patch operation engine.
 * Uses Node's native test runner (node --test).
 */

import { test }                                           from "node:test";
import assert                                             from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { join }                                           from "path";
import { tmpdir }                                         from "os";
import {
  parsePatchOps,
  applyPatchOpsToContent,
  applyPatchOpsToWorktree,
  diffContents,
} from "../src/patchops.js";

// ── 1. replace: single occurrence ────────────────────────────────────────────

test("replace: single occurrence substitutes first match", () => {
  const content = "hello world\nhello again\n";
  const ops     = [{ op: "replace", path: "f.js", old: "world", new: "earth", occurrence: 1 }];
  assert.equal(applyPatchOpsToContent(content, ops), "hello earth\nhello again\n");
});

// ── 2. replace: occurrence=2 targets second match ────────────────────────────

test("replace: occurrence=2 leaves first match, changes second", () => {
  const content = "foo bar foo baz\n";
  const ops     = [{ op: "replace", path: "f.js", old: "foo", new: "qux", occurrence: 2 }];
  const result  = applyPatchOpsToContent(content, ops);
  assert.equal(result, "foo bar qux baz\n");
});

// ── 3. replace: not found → patch_anchor_not_found ───────────────────────────

test("replace: not found throws patch_anchor_not_found with op summary", () => {
  const content = "hello world\n";
  const ops     = [{ op: "replace", path: "f.js", old: "missing snippet", new: "x" }];
  try {
    applyPatchOpsToContent(content, ops);
    assert.fail("expected to throw");
  } catch (e) {
    assert.equal(e.code, "patch_anchor_not_found");
    assert.equal(typeof e.opIndex, "number");
    assert.ok(e.op, "error must include op summary");
    assert.equal(e.op.op, "replace");
    assert.equal(e.op.path, "f.js");
  }
});

// ── 4. insert_after: inserts text after anchor ───────────────────────────────

test("insert_after: inserts text immediately after anchor", () => {
  const content = "line1\nline2\nline3\n";
  const ops     = [{ op: "insert_after", path: "f.js", anchor: "line1\n", text: "inserted\n" }];
  assert.equal(applyPatchOpsToContent(content, ops), "line1\ninserted\nline2\nline3\n");
});

// ── 5. delete: removes snippet ───────────────────────────────────────────────

test("delete: removes exact snippet from content", () => {
  const content = "keep this\nremove this\nkeep that\n";
  const ops     = [{ op: "delete", path: "f.js", old: "remove this\n" }];
  assert.equal(applyPatchOpsToContent(content, ops), "keep this\nkeep that\n");
});

// ── 6. multi-op: declaration order, no line drift ────────────────────────────

test("multi-op: declaration order applied, insert then replace on same file", () => {
  const content = "A\nB\nC\n";
  const ops = [
    { op: "insert_after", path: "f.js", anchor: "A\n", text: "A2\n" },
    { op: "replace",      path: "f.js", old: "C\n",    new: "D\n"  },
  ];
  // After insert_after: "A\nA2\nB\nC\n"
  // After replace C→D:  "A\nA2\nB\nD\n"
  assert.equal(applyPatchOpsToContent(content, ops), "A\nA2\nB\nD\n");
});

// ── 7. diffContents: produces @@ hunk headers ────────────────────────────────

test("diffContents: produces unified diff with @@ hunk headers", () => {
  const original = "line1\nline2\nline3\n";
  const proposed = "line1\nCHANGED\nline3\n";
  const diff     = diffContents(original, proposed, "test.js");
  assert.ok(diff.includes("@@"),       `expected @@ header in diff:\n${diff}`);
  assert.ok(diff.includes("+CHANGED"), `expected +CHANGED in diff:\n${diff}`);
  assert.ok(diff.includes("-line2"),   `expected -line2 in diff:\n${diff}`);
});

// ── 8. parsePatchOps: non-JSON → patch_json_invalid ──────────────────────────

test("parsePatchOps: non-JSON string throws patch_json_invalid", () => {
  try {
    parsePatchOps("this is not json at all");
    assert.fail("expected to throw");
  } catch (e) {
    assert.equal(e.code, "patch_json_invalid");
  }
});

test("parsePatchOps: model-declared error throws with model_declared_error flag", () => {
  try {
    parsePatchOps(JSON.stringify({ error: "cannot find the anchor" }));
    assert.fail("expected to throw");
  } catch (e) {
    assert.equal(e.code, "patch_json_invalid");
    assert.equal(e.model_declared_error, true);
    assert.ok(e.modelError.includes("cannot find the anchor"));
  }
});

test("parsePatchOps: path traversal in op throws patch_schema_invalid", () => {
  const ops = [{ op: "replace", path: "../../etc/passwd", old: "x", new: "y" }];
  try {
    parsePatchOps(JSON.stringify(ops));
    assert.fail("expected to throw");
  } catch (e) {
    assert.equal(e.code, "patch_schema_invalid");
  }
});

test("parsePatchOps: .git path in op throws patch_schema_invalid", () => {
  const ops = [{ op: "replace", path: ".git/config", old: "x", new: "y" }];
  try {
    parsePatchOps(JSON.stringify(ops));
    assert.fail("expected to throw");
  } catch (e) {
    assert.equal(e.code, "patch_schema_invalid");
  }
});

// ── 9. applyPatchOpsToWorktree: only writes inside worktree ──────────────────

test("applyPatchOpsToWorktree: writes only to files inside worktree path", () => {
  const wt       = mkdtempSync(join(tmpdir(), "crucible-wt-test-"));
  const sentinel = join(tmpdir(), `crucible-sentinel-${process.pid}.txt`);
  try {
    writeFileSync(join(wt, "src.js"), "hello world\n", "utf8");
    writeFileSync(sentinel, "unchanged\n", "utf8");

    applyPatchOpsToWorktree(wt, [
      { op: "replace", path: "src.js", old: "world", new: "earth" },
    ]);

    // File inside worktree was modified
    assert.equal(readFileSync(join(wt, "src.js"), "utf8"), "hello earth\n");
    // Sentinel outside worktree was not touched
    assert.equal(readFileSync(sentinel, "utf8"), "unchanged\n");
  } finally {
    rmSync(wt, { recursive: true, force: true });
    try { rmSync(sentinel); } catch {}
  }
});
