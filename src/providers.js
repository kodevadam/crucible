/**
 * crucible — providers.js
 *
 * Thin abstraction over LLM provider SDKs.
 *
 * Interface:
 *   provider.chat(messages, { model, maxTokens, system? }) → string
 *   provider.listModels()                                   → [{ id, created }]
 *
 * Providers:
 *   OpenAIProvider    — OpenAI chat completions API
 *   AnthropicProvider — Anthropic Messages API
 *
 * IMPORTANT: Providers receive and return text only. They must never return
 * file paths, shell commands, or other executable content — callers are
 * responsible for treating model output as untrusted input.
 */

import OpenAI    from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { retrieveKey, SERVICE_OPENAI, SERVICE_ANTHROPIC } from "./keys.js";

// ── OpenAI ────────────────────────────────────────────────────────────────────

export class OpenAIProvider {
  constructor(apiKey) {
    this.client = new OpenAI({ apiKey });
  }

  /**
   * Send a chat request and return the assistant message text.
   * @param {Array<{role: string, content: string}>} messages
   * @param {{ model: string, maxTokens?: number }} opts
   * @returns {Promise<string>}
   */
  async chat(messages, { model, maxTokens = 2000 } = {}) {
    try {
      // max_completion_tokens is required by GPT-5+ / o-series models
      const res = await this.client.chat.completions.create({
        model, messages, max_completion_tokens: maxTokens,
      });
      return res.choices[0].message.content;
    } catch (err) {
      // Older models (gpt-4, gpt-4-turbo) reject max_completion_tokens — retry
      if (err?.status === 400 && err?.code === "unsupported_parameter") {
        try {
          const res = await this.client.chat.completions.create({
            model, messages, max_tokens: maxTokens,
          });
          return res.choices[0].message.content;
        } catch (retryErr) {
          const norm = normalizeApiError(retryErr, { provider: "openai", model });
          const enhanced = new Error(formatApiError(norm));
          enhanced.crucibleApiError = norm;
          throw enhanced;
        }
      }
      const norm = normalizeApiError(err, { provider: "openai", model });
      const enhanced = new Error(formatApiError(norm));
      enhanced.crucibleApiError = norm;
      throw enhanced;
    }
  }

  /**
   * List available models.
   * @returns {Promise<Array<{id: string, created: number}>>}
   */
  async listModels() {
    const { data } = await this.client.models.list();
    return data.map(m => ({ id: m.id, created: m.created }));
  }
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

export class AnthropicProvider {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
  }

  /**
   * Send a messages request and return the assistant text content.
   * @param {Array<{role: string, content: string}>} messages
   * @param {{ model: string, maxTokens?: number, system?: string }} opts
   * @returns {Promise<string>}
   */
  async chat(messages, { model, maxTokens = 2000, system } = {}) {
    try {
      const params = { model, max_tokens: maxTokens, messages };
      if (system) params.system = system;
      const res = await this.client.messages.create(params);
      return res.content[0].text;
    } catch (err) {
      const norm = normalizeApiError(err, { provider: "anthropic", model });
      const enhanced = new Error(formatApiError(norm));
      enhanced.crucibleApiError = norm;
      throw enhanced;
    }
  }

  /**
   * List available models.
   * @returns {Promise<Array<{id: string, created: string}>>}
   */
  async listModels() {
    const { data } = await this.client.models.list();
    return data.map(m => ({ id: m.id, created: m.created_at }));
  }
}

// ── API error normaliser ──────────────────────────────────────────────────────

/**
 * Normalise a provider API error into a structured diagnostic object.
 *
 * Fields returned:
 *   provider   — "openai" | "anthropic" | "unknown"
 *   model      — model id string, or "unknown"
 *   requestId  — provider request-id header (best-effort), or null
 *   status     — HTTP status code, or null
 *   code       — provider error code string, or null
 *   retryable  — true if a simple retry is likely to succeed
 *   message    — human-readable error string
 *   suggestion — one-line actionable hint for the user
 *
 * Used by callers to print a consistent failure block regardless of which SDK
 * threw.  Never throws itself.
 */
export function normalizeApiError(err, { provider = "unknown", model = "unknown" } = {}) {
  const status    = err?.status ?? err?.statusCode ?? null;
  const code      = err?.code ?? err?.error?.code ?? null;
  const requestId =
    err?.headers?.["x-request-id"] ??
    err?.request_id ??
    err?.error?.internal?.request_id ??
    null;

  const retryable =
    status === 429 ||
    (status != null && status >= 500 && status < 600) ||
    /timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(err?.message ?? "");

  let suggestion = "Check your API key and account quota.";
  if (status === 401 || status === 403)
    suggestion = "Invalid or missing API key — run: crucible keys status";
  else if (status === 429)
    suggestion = "Rate-limited — wait and retry, or reduce request rate / max tokens.";
  else if (status === 400 && code === "unsupported_parameter")
    suggestion = "Parameter unsupported by this model — try pinning to a different model version.";
  else if (status === 400)
    suggestion = "Bad request — check model name and token limits.";
  else if (status != null && status >= 500)
    suggestion = "Provider server error — retry shortly; check provider status page.";
  else if (status == null)
    suggestion = "Network or timeout error — check connectivity and retry.";

  return {
    provider, model, requestId,
    status, code,
    retryable,
    message:    err?.message ?? String(err),
    suggestion,
  };
}

/**
 * Format a normalised API error as a human-readable block for console output.
 *
 * Example output:
 *   ✗ API error — openai / gpt-4o
 *     Status:     429  (retryable)
 *     Request ID: req-abc123
 *     Message:    Rate limit exceeded.
 *     Suggestion: Rate-limited — wait and retry, or reduce request rate / max tokens.
 */
export function formatApiError({ provider, model, requestId, status, retryable, message, suggestion }) {
  const lines = [
    `✗ API error — ${provider} / ${model}`,
    `  Status:     ${status ?? "n/a"}  (${retryable ? "retryable" : "not retryable"})`,
  ];
  if (requestId) lines.push(`  Request ID: ${requestId}`);
  lines.push(
    `  Message:    ${message}`,
    `  Suggestion: ${suggestion}`,
  );
  return lines.join("\n");
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a provider instance by type string.
 * @param {"openai"|"anthropic"} type
 * @param {string} apiKey
 * @returns {OpenAIProvider|AnthropicProvider}
 */
export function createProvider(type, apiKey) {
  switch (type) {
    case "openai":    return new OpenAIProvider(apiKey);
    case "anthropic": return new AnthropicProvider(apiKey);
    default:          throw new Error(`Unknown provider type: ${JSON.stringify(type)}`);
  }
}

// ── Shared lazy singletons ────────────────────────────────────────────────────
//
// All modules that talk to LLM APIs (cli.js, staging.js, repo.js) were each
// maintaining their own copy of this boilerplate.  Import these instead.
//
// Keys are resolved from the keychain/env at first use, so the singletons are
// safe to create before the user has entered their API keys — the key lookup
// is deferred until the first actual API call.
//
// DESIGN NOTE — singleton per provider vs. singleton per (provider, key):
//   The current design uses one client per provider for the lifetime of the
//   process.  That works perfectly for the common case (one user, one key
//   per provider).  If a future feature needs multiple keys in the same
//   process (e.g. "compare output across org A and org B", or ephemeral
//   per-request keys), replace the two module-level vars with a Map keyed
//   on a fingerprint of the API key (e.g. first 8 chars, never the full key):
//
//     const _clients = new Map(); // `${provider}:${key.slice(0,8)}` → client
//
//   This keeps the lazy-init pattern while supporting multi-key scenarios
//   without breaking any existing call sites.

let _openai       = null;
let _openaiKey    = null;
let _anthropic    = null;
let _anthropicKey = null;

/**
 * Shared lazy OpenAI SDK client.
 * Re-creates the client whenever the stored key changes so that a key entered
 * after first launch (or updated via `crucible keys`) takes effect immediately
 * without requiring a process restart.
 */
export function getOpenAI() {
  const key = retrieveKey(SERVICE_OPENAI) || "";
  if (!_openai || _openaiKey !== key) {
    _openai    = new OpenAI({ apiKey: key });
    _openaiKey = key;
  }
  return _openai;
}

/**
 * Shared lazy Anthropic SDK client.
 * Re-creates the client whenever the stored key changes (same rationale as
 * getOpenAI above).
 */
export function getAnthropic() {
  const key = retrieveKey(SERVICE_ANTHROPIC) || "";
  if (!_anthropic || _anthropicKey !== key) {
    _anthropic    = new Anthropic({ apiKey: key });
    _anthropicKey = key;
  }
  return _anthropic;
}

/**
 * Override the Anthropic singleton with a test double.
 * Pass null to clear the override so the next getAnthropic() call
 * re-creates the real client from the stored key.
 *
 * ONLY for use in integration tests — never call from production code.
 * Prefixed with _ as a naming convention for test-only exports.
 */
export function _setAnthropicForTest(mock) {
  if (mock === null) {
    // Clear the mock; next getAnthropic() call re-creates from the real key.
    _anthropic    = null;
    _anthropicKey = null;
  } else {
    // Inject the mock and synchronise _anthropicKey to the value getAnthropic()
    // would compute right now.  Without this, getAnthropic() sees a key change
    // (null !== "") and immediately overwrites the mock with a real client.
    _anthropic    = mock;
    _anthropicKey = retrieveKey(SERVICE_ANTHROPIC) || "";
  }
}
