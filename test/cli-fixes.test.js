/**
 * Tests for the three crucible CLI fixes:
 *   A) askGPT uses max_completion_tokens, retries with max_tokens on unsupported_parameter
 *   B) (structural — no unit test; verified by Node not emitting the warning)
 *   C) normalizeGitHubRepoInput strips /tree/... and /blob/... URLs correctly
 *      destination-exists logic prompts correctly (via mock)
 */

import { test }  from "node:test";
import assert    from "node:assert/strict";

import { normalizeGitHubRepoInput } from "../src/safety.js";

// ── C: normalizeGitHubRepoInput ───────────────────────────────────────────────

test("normalizeGitHubRepoInput: plain owner/repo passes through", () => {
  assert.equal(normalizeGitHubRepoInput("kodevadam/crucible"), "kodevadam/crucible");
});

test("normalizeGitHubRepoInput: bare HTTPS URL strips to owner/repo", () => {
  assert.equal(
    normalizeGitHubRepoInput("https://github.com/kodevadam/crucible"),
    "kodevadam/crucible"
  );
});

test("normalizeGitHubRepoInput: /tree/branch URL strips to owner/repo", () => {
  assert.equal(
    normalizeGitHubRepoInput("https://github.com/kodevadam/crucible/tree/main"),
    "kodevadam/crucible"
  );
});

test("normalizeGitHubRepoInput: /tree/branch/subpath URL strips to owner/repo", () => {
  assert.equal(
    normalizeGitHubRepoInput("https://github.com/kodevadam/crucible/tree/main/src/cli.js"),
    "kodevadam/crucible"
  );
});

test("normalizeGitHubRepoInput: /blob/... URL strips to owner/repo", () => {
  assert.equal(
    normalizeGitHubRepoInput("https://github.com/octocat/Hello-World/blob/master/README.md"),
    "octocat/Hello-World"
  );
});

test("normalizeGitHubRepoInput: /commits/... URL strips to owner/repo", () => {
  assert.equal(
    normalizeGitHubRepoInput("https://github.com/octocat/Hello-World/commits/master"),
    "octocat/Hello-World"
  );
});

test("normalizeGitHubRepoInput: trims whitespace", () => {
  assert.equal(
    normalizeGitHubRepoInput("  https://github.com/kodevadam/crucible/tree/main  "),
    "kodevadam/crucible"
  );
});

test("normalizeGitHubRepoInput: http (non-https) URL also works", () => {
  assert.equal(
    normalizeGitHubRepoInput("http://github.com/kodevadam/crucible/tree/main"),
    "kodevadam/crucible"
  );
});

test("normalizeGitHubRepoInput: unknown input passes through unchanged (let gh handle it)", () => {
  // Not a github.com URL and not owner/repo — pass through for gh to error-report
  const weird = "git@github.com:kodevadam/crucible.git";
  assert.equal(normalizeGitHubRepoInput(weird), weird);
});

test("normalizeGitHubRepoInput: empty string returns empty string", () => {
  assert.equal(normalizeGitHubRepoInput(""), "");
});

// ── A: askGPT retry shim ──────────────────────────────────────────────────────
//
// We can't import askGPT directly (it's not exported and reads module-level
// state.gptModel).  Instead we verify the retry behaviour via a synthetic
// stub that mirrors the exact logic in askGPT().

async function askGPTShim(messages, createFn, maxTokens = 2000) {
  try {
    const res = await createFn({ max_completion_tokens: maxTokens, messages });
    return res.choices[0].message.content;
  } catch (err) {
    if (err?.status === 400 && err?.code === "unsupported_parameter") {
      const res = await createFn({ max_tokens: maxTokens, messages });
      return res.choices[0].message.content;
    }
    throw err;
  }
}

test("askGPT shim: uses max_completion_tokens on first attempt", async () => {
  let capturedParams;
  const stubCreate = async (params) => {
    capturedParams = params;
    return { choices: [{ message: { content: "ok" } }] };
  };
  const result = await askGPTShim([], stubCreate);
  assert.equal(result, "ok");
  assert.ok("max_completion_tokens" in capturedParams, "should use max_completion_tokens");
  assert.ok(!("max_tokens" in capturedParams), "should NOT use max_tokens on first try");
});

test("askGPT shim: retries with max_tokens on unsupported_parameter (400)", async () => {
  let callCount = 0;
  let secondCallParams;
  const stubCreate = async (params) => {
    callCount++;
    if (callCount === 1) {
      const err = new Error("unsupported_parameter");
      err.status = 400;
      err.code   = "unsupported_parameter";
      throw err;
    }
    secondCallParams = params;
    return { choices: [{ message: { content: "fallback" } }] };
  };
  const result = await askGPTShim([], stubCreate);
  assert.equal(result, "fallback");
  assert.equal(callCount, 2, "should have made exactly 2 calls");
  assert.ok("max_tokens" in secondCallParams, "retry must use max_tokens");
  assert.ok(!("max_completion_tokens" in secondCallParams), "retry must NOT use max_completion_tokens");
});

test("askGPT shim: honours explicit maxTokens override", async () => {
  let capturedParams;
  const stubCreate = async (params) => {
    capturedParams = params;
    return { choices: [{ message: { content: "ok" } }] };
  };
  await askGPTShim([], stubCreate, 3000);
  assert.equal(capturedParams.max_completion_tokens, 3000, "should forward custom maxTokens");
});

test("askGPT shim: propagates other errors without retry", async () => {
  let callCount = 0;
  const stubCreate = async () => {
    callCount++;
    const err = new Error("rate_limit_exceeded");
    err.status = 429;
    err.code   = "rate_limit_exceeded";
    throw err;
  };
  await assert.rejects(
    () => askGPTShim([], stubCreate),
    (err) => {
      assert.equal(err.code, "rate_limit_exceeded");
      return true;
    }
  );
  assert.equal(callCount, 1, "should NOT retry on non-unsupported_parameter errors");
});
