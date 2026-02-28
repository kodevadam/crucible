/**
 * Environment & process-boundary hardening tests.
 *
 * Covers:
 *   - safeEnv(): strips AI provider keys, preserves PATH/HOME/GH_TOKEN
 *   - Child processes spawned by gitq/ghq do NOT receive OPENAI_API_KEY
 *   - validateStagingPath: rejects UNC paths (\\server\share, \\?\...)
 *   - redactKeys: key with trailing newline, key with spaces, quoted key in text
 *   - Regression: safeEnv() is used in all spawnSync calls in safety.js
 */

import { test }  from "node:test";
import assert    from "node:assert/strict";
import { readFileSync } from "fs";
import { join }  from "path";
import { spawnSync } from "child_process";

import { safeEnv, validateStagingPath, shortHash } from "../src/safety.js";
import { redactKeys }                              from "../src/keys.js";

const SRC_SAFETY = readFileSync(new URL("../src/safety.js", import.meta.url).pathname, "utf8");

// ── safeEnv: strips provider keys ────────────────────────────────────────────

test("safeEnv: strips OPENAI_API_KEY", () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test-strip-me-12345";
  try {
    const env = safeEnv();
    assert.ok(!("OPENAI_API_KEY" in env), "OPENAI_API_KEY should be absent from child env");
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    else delete process.env.OPENAI_API_KEY;
  }
});

test("safeEnv: strips ANTHROPIC_API_KEY", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-strip-12345";
  try {
    const env = safeEnv();
    assert.ok(!("ANTHROPIC_API_KEY" in env), "ANTHROPIC_API_KEY should be absent from child env");
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    else delete process.env.ANTHROPIC_API_KEY;
  }
});

test("safeEnv: strips OPENAI_ORG_ID", () => {
  process.env.OPENAI_ORG_ID = "org-test-12345";
  try {
    assert.ok(!("OPENAI_ORG_ID" in safeEnv()));
  } finally {
    delete process.env.OPENAI_ORG_ID;
  }
});

test("safeEnv: strips ANTHROPIC_AUTH_TOKEN", () => {
  process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-auth-test-12345";
  try {
    assert.ok(!("ANTHROPIC_AUTH_TOKEN" in safeEnv()));
  } finally {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

test("safeEnv: preserves PATH", () => {
  const env = safeEnv();
  assert.ok("PATH" in env, "PATH must be preserved so child processes can find binaries");
});

test("safeEnv: preserves HOME", () => {
  const env = safeEnv();
  assert.ok("HOME" in env, "HOME must be preserved");
});

test("safeEnv: preserves GH_TOKEN (gh CLI needs it)", () => {
  const saved = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "ghp_test_token_12345";
  try {
    const env = safeEnv();
    assert.ok("GH_TOKEN" in env, "GH_TOKEN must not be stripped — gh CLI needs it to authenticate");
  } finally {
    if (saved !== undefined) process.env.GH_TOKEN = saved;
    else delete process.env.GH_TOKEN;
  }
});

test("safeEnv: preserves GITHUB_TOKEN (gh CLI needs it)", () => {
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "ghp_test_github_token_12345";
  try {
    const env = safeEnv();
    assert.ok("GITHUB_TOKEN" in env, "GITHUB_TOKEN must not be stripped — gh CLI needs it");
  } finally {
    if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
    else delete process.env.GITHUB_TOKEN;
  }
});

test("safeEnv: returns a copy, not the original process.env", () => {
  const env = safeEnv();
  assert.notStrictEqual(env, process.env, "safeEnv() must return a new object");
});

// ── No secrets in child env (subprocess-level assertion) ─────────────────────

test("child process spawned with safeEnv() does not receive OPENAI_API_KEY", () => {
  const secret = "sk-test-must-not-leak-12345678";
  const saved  = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = secret;

  try {
    // Spawn a Node.js process that prints its OPENAI_API_KEY (or 'NOT_SET')
    const r = spawnSync(
      process.execPath,
      ["--eval", "process.stdout.write(process.env.OPENAI_API_KEY || 'NOT_SET')"],
      { encoding: "utf8", shell: false, env: safeEnv() }
    );
    assert.equal(r.status, 0, `subprocess exited with error: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "NOT_SET",
      "OPENAI_API_KEY must not be forwarded to child processes"
    );
    assert.ok(!r.stdout.includes(secret),
      "Secret value must not appear anywhere in child process output"
    );
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    else delete process.env.OPENAI_API_KEY;
  }
});

test("child process spawned with safeEnv() does not receive ANTHROPIC_API_KEY", () => {
  const secret = "sk-ant-test-must-not-leak-12345";
  const saved  = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = secret;

  try {
    const r = spawnSync(
      process.execPath,
      ["--eval", "process.stdout.write(process.env.ANTHROPIC_API_KEY || 'NOT_SET')"],
      { encoding: "utf8", shell: false, env: safeEnv() }
    );
    assert.equal(r.status, 0, `subprocess exited with error: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "NOT_SET");
    assert.ok(!r.stdout.includes(secret));
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    else delete process.env.ANTHROPIC_API_KEY;
  }
});

// ── Regression: all spawnSync calls in safety.js use env: safeEnv() ──────────

test("regression: every spawnSync call in safety.js includes env: safeEnv()", () => {
  // Match spawnSync( ... ) blocks and confirm each one contains 'safeEnv()'
  // Approach: find all spawnSync( call sites, then check the surrounding context
  const spawnMatches = [...SRC_SAFETY.matchAll(/spawnSync\s*\(/g)];
  assert.ok(spawnMatches.length > 0, "expected at least one spawnSync call in safety.js");

  // Extract a window of text after each spawnSync( until the closing )
  // and verify safeEnv() appears within it.
  for (const m of spawnMatches) {
    const window = SRC_SAFETY.slice(m.index, m.index + 300);
    assert.ok(
      window.includes("safeEnv()"),
      `spawnSync at offset ${m.index} in safety.js does not pass env: safeEnv():\n${window}`
    );
  }
});

// ── UNC and NT device path rejection ─────────────────────────────────────────

const REPO = "/tmp/safe-repo";

test("validateStagingPath: rejects UNC path \\\\server\\share", () => {
  // JS string literal "\\\\server\\share" = actual value \\server\share
  assert.throws(
    () => validateStagingPath(REPO, "\\\\server\\share"),
    /UNC|device/i
  );
});

test("validateStagingPath: rejects NT device path \\\\?\\C:\\foo", () => {
  // "\\\\?\\C:\\foo" = actual value \\?\C:\foo
  assert.throws(
    () => validateStagingPath(REPO, "\\\\?\\C:\\foo"),
    /UNC|device/i
  );
});

test("validateStagingPath: rejects NT device path \\\\.\\pipe\\name", () => {
  // "\\\\.\\pipe\\name" = actual value \\.\pipe\name
  assert.throws(
    () => validateStagingPath(REPO, "\\\\.\\pipe\\name"),
    /UNC|device/i
  );
});

test("validateStagingPath: rejects //server/share (Unix absolute UNC-like)", () => {
  // // at start is absolute on Linux, caught by isAbsolute check
  assert.throws(
    () => validateStagingPath(REPO, "//server/share"),
    /absolute/i
  );
});

// ── redactKeys edge cases ─────────────────────────────────────────────────────

test("redactKeys: key stored with trailing newline — redacts trimmed occurrence in text", () => {
  const key    = "sk-test-trailing-newline1234\n";  // key value has trailing \n
  const text   = "Authorization: sk-test-trailing-newline1234 and more";
  const result = redactKeys(text, [key]);
  assert.ok(!result.includes("sk-test-trailing-newline1234"), "base key should be redacted");
  assert.ok(result.includes("[REDACTED]"));
});

test("redactKeys: key stored with leading/trailing spaces — redacts trimmed occurrence", () => {
  const key    = "  sk-test-spaced-key-12345  ";
  const text   = "key=sk-test-spaced-key-12345 logged";
  const result = redactKeys(text, [key]);
  assert.ok(!result.includes("sk-test-spaced-key-12345"), "trimmed key should be redacted");
  assert.ok(result.includes("[REDACTED]"));
});

test("redactKeys: key appearing in JSON context is redacted", () => {
  const key  = "sk-test-json-key-abcdef1234";
  const text = `{"api_key": "${key}", "model": "gpt-4"}`;
  const out  = redactKeys(text, [key]);
  assert.ok(!out.includes(key));
  assert.ok(out.includes("[REDACTED]"));
});

test("redactKeys: key with trailing newline in text (logger output) is redacted", () => {
  const key  = "sk-test-in-log-line-12345678";
  const text = `DEBUG api_key=${key}\nDEBUG request_id=abc`;
  const out  = redactKeys(text, [key]);
  assert.ok(!out.includes(key));
});

test("redactKeys: multiple different keys all redacted", () => {
  const k1  = "sk-openai-test-key-00000001";
  const k2  = "sk-ant-test-key-00000002xx";
  const text = `openai=${k1} anthropic=${k2}`;
  const out  = redactKeys(text, [k1, k2]);
  assert.ok(!out.includes(k1));
  assert.ok(!out.includes(k2));
  assert.equal(out.match(/\[REDACTED\]/g)?.length, 2);
});

test("redactKeys: null text returns null unchanged", () => {
  assert.equal(redactKeys(null, ["sk-test-nullkey12345"]), null);
});

test("redactKeys: undefined text returns undefined unchanged", () => {
  assert.equal(redactKeys(undefined, ["sk-test-undef12345"]), undefined);
});

// ── shortHash ─────────────────────────────────────────────────────────────────

test("shortHash: returns 12-char hex string", () => {
  const h = shortHash("hello world");
  assert.equal(typeof h, "string");
  assert.equal(h.length, 12);
  assert.ok(/^[0-9a-f]{12}$/.test(h), `expected 12 lowercase hex chars, got: ${h}`);
});

test("shortHash: same input → same output (deterministic)", () => {
  assert.equal(shortHash("crucible-prompt-v1"), shortHash("crucible-prompt-v1"));
});

test("shortHash: different inputs → different hashes", () => {
  assert.notEqual(shortHash("prompt v1"), shortHash("prompt v2"));
});

test("shortHash: handles empty string without throwing", () => {
  const h = shortHash("");
  assert.equal(h.length, 12);
});

test("shortHash: handles null/undefined without throwing", () => {
  assert.equal(shortHash(null).length, 12);
  assert.equal(shortHash(undefined).length, 12);
});

// ── Paranoid env mode (CRUCIBLE_PARANOID_ENV=1) ────────────────────────────────

function withParanoidEnv(fn) {
  const saved = process.env.CRUCIBLE_PARANOID_ENV;
  process.env.CRUCIBLE_PARANOID_ENV = "1";
  try { fn(); } finally {
    if (saved !== undefined) process.env.CRUCIBLE_PARANOID_ENV = saved;
    else delete process.env.CRUCIBLE_PARANOID_ENV;
  }
}

test("paranoid mode: PATH is forwarded", () => {
  withParanoidEnv(() => {
    const env = safeEnv();
    assert.ok("PATH" in env, "PATH must be in paranoid env");
  });
});

test("paranoid mode: HOME is forwarded", () => {
  withParanoidEnv(() => {
    const env = safeEnv();
    assert.ok("HOME" in env, "HOME must be in paranoid env");
  });
});

test("paranoid mode: OPENAI_API_KEY is not forwarded", () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-paranoid-test-key-12345";
  try {
    withParanoidEnv(() => {
      const env = safeEnv();
      assert.ok(!("OPENAI_API_KEY" in env), "OPENAI_API_KEY must be absent in paranoid env");
    });
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    else delete process.env.OPENAI_API_KEY;
  }
});

test("paranoid mode: ANTHROPIC_API_KEY is not forwarded", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-paranoid-test-12345";
  try {
    withParanoidEnv(() => {
      const env = safeEnv();
      assert.ok(!("ANTHROPIC_API_KEY" in env), "ANTHROPIC_API_KEY must be absent in paranoid env");
    });
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    else delete process.env.ANTHROPIC_API_KEY;
  }
});

test("paranoid mode: GH_TOKEN is forwarded (gh CLI needs it)", () => {
  const saved = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "ghp_paranoid_test_token_12345";
  try {
    withParanoidEnv(() => {
      const env = safeEnv();
      assert.ok("GH_TOKEN" in env, "GH_TOKEN must be forwarded in paranoid env");
    });
  } finally {
    if (saved !== undefined) process.env.GH_TOKEN = saved;
    else delete process.env.GH_TOKEN;
  }
});

test("paranoid mode: GIT_* prefix vars are forwarded", () => {
  const saved = process.env.GIT_AUTHOR_NAME;
  process.env.GIT_AUTHOR_NAME = "Test Author";
  try {
    withParanoidEnv(() => {
      const env = safeEnv();
      assert.ok("GIT_AUTHOR_NAME" in env, "GIT_* vars must be forwarded in paranoid env");
    });
  } finally {
    if (saved !== undefined) process.env.GIT_AUTHOR_NAME = saved;
    else delete process.env.GIT_AUTHOR_NAME;
  }
});

test("paranoid mode: arbitrary unknown var is NOT forwarded", () => {
  process.env._CRUCIBLE_TEST_UNKNOWN_VAR_XYZ = "secret";
  try {
    withParanoidEnv(() => {
      const env = safeEnv();
      assert.ok(
        !("_CRUCIBLE_TEST_UNKNOWN_VAR_XYZ" in env),
        "Unknown vars must be dropped in paranoid env"
      );
    });
  } finally {
    delete process.env._CRUCIBLE_TEST_UNKNOWN_VAR_XYZ;
  }
});

test("paranoid mode: CRUCIBLE_EXTRA_ENV allows opt-in of additional vars", () => {
  const savedExtra = process.env.CRUCIBLE_EXTRA_ENV;
  const savedFoo   = process.env.MY_CUSTOM_VAR_FOR_TEST;
  process.env.MY_CUSTOM_VAR_FOR_TEST = "my-value";
  process.env.CRUCIBLE_EXTRA_ENV     = "MY_CUSTOM_VAR_FOR_TEST";
  try {
    withParanoidEnv(() => {
      const env = safeEnv();
      assert.ok("MY_CUSTOM_VAR_FOR_TEST" in env, "CRUCIBLE_EXTRA_ENV opt-in must be respected");
    });
  } finally {
    if (savedExtra !== undefined) process.env.CRUCIBLE_EXTRA_ENV = savedExtra;
    else delete process.env.CRUCIBLE_EXTRA_ENV;
    if (savedFoo !== undefined) process.env.MY_CUSTOM_VAR_FOR_TEST = savedFoo;
    else delete process.env.MY_CUSTOM_VAR_FOR_TEST;
  }
});
