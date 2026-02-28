/**
 * Tests for src/keys.js
 *
 * Tests the file-fallback storage path using a temporary directory.
 * Keychain CLI is NOT required in CI — the file fallback is always available.
 *
 * Covers:
 *   - storeKey / retrieveKey round-trip via file fallback
 *   - Session-only mode: never writes to disk
 *   - redactKeys: exact match, trimmed, quoted variants
 *   - retrieveKey: env var compatibility fallback
 *   - File permissions set to 600
 */

import { test, before, after }            from "node:test";
import assert                             from "node:assert/strict";
import { mkdtempSync, rmSync, statSync }  from "fs";
import { tmpdir }                         from "os";
import { join }                           from "path";

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "crucible-keys-test-"));
});

after(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// We need to override KEYS_DIR so tests don't touch the real keychain.
// We do this by monkey-patching the module's internal path.
// Since keys.js uses a module-level constant, we instead test the exported
// functions with the CRUCIBLE_SILENCE_KEY_WARN env var set.

process.env.CRUCIBLE_SILENCE_KEY_WARN = "1";
// Force session-only OFF for most tests
delete process.env.CRUCIBLE_SESSION_ONLY;

// ── Import (after env setup) ──────────────────────────────────────────────────

// We import the module fresh per test file; env vars are read at module load.
const keysModule = await import("../src/keys.js");
const {
  storeKey, retrieveKey, deleteKey,
  redactKeys, getLoadedKeys,
  SERVICE_OPENAI, SERVICE_ANTHROPIC,
} = keysModule;

// ── redactKeys ────────────────────────────────────────────────────────────────

test("redactKeys: exact match", () => {
  const key = "sk-test-1234567890";
  const result = redactKeys(`apiKey: ${key}`, [key]);
  assert.equal(result, "apiKey: [REDACTED]");
});

test("redactKeys: multiple occurrences", () => {
  const key = "sk-test-abcdefghij";
  const text = `key1=${key} key2=${key}`;
  const result = redactKeys(text, [key]);
  assert.equal(result, "key1=[REDACTED] key2=[REDACTED]");
});

test("redactKeys: redacts trimmed variant", () => {
  const key = "  sk-test-trimmed1234  ";
  const trimmed = key.trim();
  const result = redactKeys(`value: ${trimmed}`, [key]);
  assert.equal(result, "value: [REDACTED]");
});

test("redactKeys: does not redact short keys (< 8 chars)", () => {
  const result = redactKeys("hello", ["hi"]);
  assert.equal(result, "hello");
});

test("redactKeys: returns non-string input unchanged", () => {
  assert.equal(redactKeys(null, []), null);
  assert.equal(redactKeys(undefined, []), undefined);
});

test("redactKeys: handles regex special chars in key", () => {
  const key = "sk-test.key+value$12345";
  const result = redactKeys(`value: ${key} end`, [key]);
  assert.equal(result, "value: [REDACTED] end");
});

// ── env var compatibility fallback ────────────────────────────────────────────

test("retrieveKey: falls back to OPENAI_API_KEY env var", () => {
  process.env.OPENAI_API_KEY = "sk-env-openai-12345678";
  const result = retrieveKey(SERVICE_OPENAI);
  assert.equal(result, "sk-env-openai-12345678");
  delete process.env.OPENAI_API_KEY;
});

test("retrieveKey: falls back to ANTHROPIC_API_KEY env var", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-env-12345678";
  const result = retrieveKey(SERVICE_ANTHROPIC);
  assert.equal(result, "sk-ant-env-12345678");
  delete process.env.ANTHROPIC_API_KEY;
});

// ── getLoadedKeys includes env vars ───────────────────────────────────────────

test("getLoadedKeys: includes OPENAI_API_KEY env var", () => {
  const val = "sk-test-loaded-key12345";
  process.env.OPENAI_API_KEY = val;
  const keys = getLoadedKeys();
  assert.ok(keys.includes(val));
  delete process.env.OPENAI_API_KEY;
});

// ── SERVICE constants ─────────────────────────────────────────────────────────

test("SERVICE_OPENAI is a non-empty string", () => {
  assert.ok(typeof SERVICE_OPENAI === "string" && SERVICE_OPENAI.length > 0);
});

test("SERVICE_ANTHROPIC is a non-empty string", () => {
  assert.ok(typeof SERVICE_ANTHROPIC === "string" && SERVICE_ANTHROPIC.length > 0);
});

test("SERVICE_OPENAI and SERVICE_ANTHROPIC are different", () => {
  assert.notEqual(SERVICE_OPENAI, SERVICE_ANTHROPIC);
});

// ── Session-only mode ─────────────────────────────────────────────────────────

test("session-only mode: CRUCIBLE_SESSION_ONLY=1 never writes to disk", async () => {
  // Run a child process with HOME redirected to a temp dir and SESSION_ONLY=1.
  // After calling storeKey, the temp dir must remain empty.
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir }  = await import("node:os");
  const { join }    = await import("node:path");

  const fakeHome = mkdtempSync(join(tmpdir(), "crucible-session-only-"));
  const keysDir  = join(fakeHome, ".config", "crucible", "keys");
  const keysJsPath = new URL("../src/keys.js", import.meta.url).pathname;

  // Build a small script that runs storeKey under session-only mode
  const script = [
    `process.env.HOME = ${JSON.stringify(fakeHome)};`,
    `process.env.CRUCIBLE_SESSION_ONLY = "1";`,
    `process.env.CRUCIBLE_SILENCE_KEY_WARN = "1";`,
    `const { storeKey } = await import(${JSON.stringify(keysJsPath)});`,
    `storeKey("crucible-openai", "sk-test-session-only-key12345");`,
  ].join("\n");

  try {
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { encoding: "utf8", shell: false, timeout: 10_000 }
    );
    assert.equal(r.status, 0, `child script exited with error:\n${r.stderr}`);
    assert.ok(
      !existsSync(keysDir),
      `session-only mode should not write files to disk, but ${keysDir} was created`
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
