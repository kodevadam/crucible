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
        const res = await this.client.chat.completions.create({
          model, messages, max_tokens: maxTokens,
        });
        return res.choices[0].message.content;
      }
      throw err;
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
    const params = { model, max_tokens: maxTokens, messages };
    if (system) params.system = system;
    const res = await this.client.messages.create(params);
    return res.content[0].text;
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
