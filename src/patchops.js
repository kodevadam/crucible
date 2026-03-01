/**
 * crucible — patchops.js
 *
 * Surgical patch operation engine (exec-layer-003).
 *
 * Invariants:
 *   1. Strict JSON parse — non-JSON model output is a hard failure.
 *   2. Snippet-based addressing — no raw line numbers. Eliminates the
 *      line-shift problem that affects line-range ops.
 *   3. Declaration order application — ops on the same file are applied
 *      in the order declared. Snippet-based, so no line-index drift.
 *   4. Main working tree is never touched during preview — all preview
 *      diffs use collision-safe temp files. Worktree apply is a separate
 *      function for Phase 2 test-loop use.
 *   5. Path security — every op's path is validated in parsePatchOps
 *      before it reaches the apply engine.
 */

import { randomBytes }                             from "crypto";
import { spawnSync }                               from "child_process";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, normalize, isAbsolute }             from "path";
import { tmpdir }                                  from "os";
import { safeEnv }                                 from "./safety.js";

// ── Path security ─────────────────────────────────────────────────────────────

/**
 * Validate that a patch op's path field is a safe relative path.
 * Throws patch_schema_invalid on traversal / absolute / .git paths.
 */
function validateOpPath(relPath, opIndex) {
  if (typeof relPath !== "string" || !relPath.trim()) {
    const err = new Error(`Op[${opIndex}] has empty or non-string "path"`);
    err.code = "patch_schema_invalid";
    throw err;
  }

  if (isAbsolute(relPath)) {
    const err = new Error(`Op[${opIndex}] "path" must be relative, got: ${relPath}`);
    err.code = "patch_schema_invalid";
    throw err;
  }

  // Windows drive prefix (e.g. C:\)
  if (/^[A-Za-z]:[/\\]/.test(relPath)) {
    const err = new Error(`Op[${opIndex}] "path" looks like a Windows absolute path: ${relPath}`);
    err.code = "patch_schema_invalid";
    throw err;
  }

  // UNC path
  if (relPath.startsWith("\\\\")) {
    const err = new Error(`Op[${opIndex}] "path" is a UNC path: ${relPath}`);
    err.code = "patch_schema_invalid";
    throw err;
  }

  // Traversal via ..
  const norm = normalize(relPath.replace(/\\/g, "/"));
  if (norm.split("/").includes("..")) {
    const err = new Error(`Op[${opIndex}] "path" contains ".." traversal: ${relPath}`);
    err.code = "patch_schema_invalid";
    throw err;
  }

  // .git directory access
  if (norm === ".git" || norm.startsWith(".git/") || norm.includes("/.git/")) {
    const err = new Error(`Op[${opIndex}] "path" targets .git directory: ${relPath}`);
    err.code = "patch_schema_invalid";
    throw err;
  }
}

// ── Schema validation ─────────────────────────────────────────────────────────

/**
 * Parse and validate a JSON patch-ops array returned by the model.
 *
 * Error codes:
 *   patch_json_invalid    — non-JSON, or model declared { "error": "..." }
 *   patch_schema_invalid  — valid JSON but op is malformed or path is unsafe
 *
 * On model-declared failure the thrown error also has:
 *   err.model_declared_error = true
 *   err.modelError = string from the model's error field
 *
 * @param {string} jsonString - Raw string returned by the model
 * @returns {Array} Validated ops array
 */
export function parsePatchOps(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString.trim());
  } catch (e) {
    const err = new Error(`Model returned non-JSON patch ops: ${e.message}`);
    err.code = "patch_json_invalid";
    err.raw  = jsonString.slice(0, 500);
    throw err;
  }

  // Model declared failure: { "error": "..." }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.error) {
    const err = new Error(`Model declared failure: ${parsed.error}`);
    err.code                 = "patch_json_invalid";
    err.model_declared_error = true;
    err.modelError           = String(parsed.error);
    throw err;
  }

  if (!Array.isArray(parsed)) {
    const err = new Error(`Patch ops must be a JSON array, got: ${typeof parsed}`);
    err.code = "patch_schema_invalid";
    throw err;
  }

  for (let i = 0; i < parsed.length; i++) {
    const op = parsed[i];
    if (!op || typeof op !== "object") {
      const err = new Error(`Op[${i}] is not an object`);
      err.code = "patch_schema_invalid";
      throw err;
    }

    if (!["replace", "insert_after", "delete"].includes(op.op)) {
      const err = new Error(`Op[${i}] has unknown op type: "${op.op}"`);
      err.code = "patch_schema_invalid";
      throw err;
    }

    validateOpPath(op.path, i);

    if ((op.op === "replace" || op.op === "delete") && typeof op.old !== "string") {
      const err = new Error(`Op[${i}] ("${op.op}") missing required string "old" field`);
      err.code = "patch_schema_invalid";
      throw err;
    }

    if (op.op === "replace" && typeof op.new !== "string") {
      const err = new Error(`Op[${i}] ("replace") missing required string "new" field`);
      err.code = "patch_schema_invalid";
      throw err;
    }

    if (op.op === "insert_after") {
      if (typeof op.anchor !== "string") {
        const err = new Error(`Op[${i}] ("insert_after") missing required string "anchor" field`);
        err.code = "patch_schema_invalid";
        throw err;
      }
      if (typeof op.text !== "string") {
        const err = new Error(`Op[${i}] ("insert_after") missing required string "text" field`);
        err.code = "patch_schema_invalid";
        throw err;
      }
    }

    if (op.occurrence !== undefined && (!Number.isInteger(op.occurrence) || op.occurrence < 1)) {
      const err = new Error(
        `Op[${i}] "occurrence" must be a positive integer, got: ${op.occurrence}`
      );
      err.code = "patch_schema_invalid";
      throw err;
    }
  }

  return parsed;
}

// ── Apply engine ──────────────────────────────────────────────────────────────

/**
 * Apply a single patch op to a content string.
 * Returns the modified content.
 * Throws patch_anchor_not_found (with opIndex + op summary) if snippet is missing.
 */
function applyOp(content, op, opIndex) {
  const occurrence = op.occurrence ?? 1;

  if (op.op === "replace" || op.op === "delete") {
    const needle = op.old;
    let found = 0, idx = -1, searchFrom = 0;
    while (found < occurrence) {
      idx = content.indexOf(needle, searchFrom);
      if (idx === -1) break;
      found++;
      if (found < occurrence) searchFrom = idx + 1;
    }
    if (idx === -1 || found < occurrence) {
      const err = new Error(
        `Op[${opIndex}] "${op.op}" snippet not found ` +
        `(path="${op.path}", occurrence=${occurrence}): ` +
        JSON.stringify(needle.slice(0, 80))
      );
      err.code    = "patch_anchor_not_found";
      err.opIndex = opIndex;
      err.op      = { op: op.op, path: op.path, occurrence };
      throw err;
    }
    if (op.op === "replace") {
      return content.slice(0, idx) + op.new + content.slice(idx + needle.length);
    }
    return content.slice(0, idx) + content.slice(idx + needle.length);
  }

  if (op.op === "insert_after") {
    const needle = op.anchor;
    let found = 0, idx = -1, searchFrom = 0;
    while (found < occurrence) {
      idx = content.indexOf(needle, searchFrom);
      if (idx === -1) break;
      found++;
      if (found < occurrence) searchFrom = idx + 1;
    }
    if (idx === -1 || found < occurrence) {
      const err = new Error(
        `Op[${opIndex}] "insert_after" anchor not found ` +
        `(path="${op.path}", occurrence=${occurrence}): ` +
        JSON.stringify(needle.slice(0, 80))
      );
      err.code    = "patch_anchor_not_found";
      err.opIndex = opIndex;
      err.op      = { op: op.op, path: op.path, occurrence };
      throw err;
    }
    const insertPoint = idx + needle.length;
    return content.slice(0, insertPoint) + op.text + content.slice(insertPoint);
  }

  // Unreachable after parsePatchOps validation
  throw new Error(`Unknown op type: ${op.op}`);
}

/**
 * Apply a validated ops array to a content string (pure function, no I/O).
 * Ops must all target the same file. Applied in declaration order.
 *
 * @param {string} content - Original file content
 * @param {Array}  ops     - Validated ops for a single file
 * @returns {string} Modified file content
 */
export function applyPatchOpsToContent(content, ops) {
  let result = content;
  for (let i = 0; i < ops.length; i++) {
    result = applyOp(result, ops[i], i);
  }
  return result;
}

/**
 * Apply a validated ops array to files inside a worktree path.
 * Groups ops by file path; applies each group in declaration order.
 * Never touches files outside worktreePath.
 *
 * Used by Phase 2 test-loop; staging preview uses diffContents instead.
 *
 * @param {string} worktreePath - Absolute path to the worktree
 * @param {Array}  ops          - Validated ops (may span multiple files)
 */
export function applyPatchOpsToWorktree(worktreePath, ops) {
  const byFile = new Map();
  for (const op of ops) {
    if (!byFile.has(op.path)) byFile.set(op.path, []);
    byFile.get(op.path).push(op);
  }

  for (const [relPath, fileOps] of byFile) {
    const absPath = join(worktreePath, relPath);
    let content = readFileSync(absPath, "utf8");
    for (let i = 0; i < fileOps.length; i++) {
      content = applyOp(content, fileOps[i], i);
    }
    writeFileSync(absPath, content, "utf8");
  }
}

// ── Diff helpers ──────────────────────────────────────────────────────────────

/**
 * Produce a unified diff of two content strings using git diff --no-index.
 *
 * Temp file names are collision-safe: pid + Date.now() + random bytes.
 * Both temp files are cleaned in finally, even on throw.
 *
 * Exit codes from git diff --no-index:
 *   0  = identical → return ""
 *   1  = diff present → return stdout (this is success, not an error)
 *   ≥2 = real git error → throw
 *
 * @param {string} originalStr - Before content
 * @param {string} proposedStr - After content
 * @param {string} [label]     - Used in diff header prefix (default "file")
 * @returns {string} Unified diff string, or "" if no changes
 */
export function diffContents(originalStr, proposedStr, label = "file") {
  const tag   = `${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const pathA = join(tmpdir(), `crucible-${tag}-a`);
  const pathB = join(tmpdir(), `crucible-${tag}-b`);

  try {
    writeFileSync(pathA, originalStr, "utf8");
    writeFileSync(pathB, proposedStr, "utf8");

    const r = spawnSync(
      "git",
      ["diff", "--no-index", "--unified=3",
       `--src-prefix=a/${label}/`, `--dst-prefix=b/${label}/`,
       pathA, pathB],
      { stdio: "pipe", shell: false, env: safeEnv() }
    );

    if (r.status === 0) return "";
    if (r.status === 1) return r.stdout?.toString() ?? "";

    const stderr = r.stderr?.toString().trim() ?? "";
    throw new Error(`git diff --no-index failed (status ${r.status}): ${stderr}`);
  } finally {
    try { unlinkSync(pathA); } catch {}
    try { unlinkSync(pathB); } catch {}
  }
}

/**
 * Get a unified diff of unstaged changes inside a worktree.
 * Used after applyPatchOpsToWorktree() for the authoritative diff.
 *
 * @param {string} worktreePath - Absolute path to the worktree
 * @param {string} [relPath]    - Limit diff to this relative path (optional)
 * @returns {string} Unified diff string (empty if no changes)
 */
export function getUnifiedDiff(worktreePath, relPath) {
  const args = ["diff", "--unified=3"];
  if (relPath) args.push("--", relPath);

  const r = spawnSync("git", ["-C", worktreePath, ...args], {
    stdio: "pipe",
    shell: false,
    env: safeEnv(),
  });

  return r.stdout?.toString() ?? "";
}
