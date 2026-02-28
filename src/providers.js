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
    const res = await this.client.chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens,
    });
    return res.choices[0].message.content;
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

let _openai    = null;
let _anthropic = null;

/** Shared lazy OpenAI SDK client. */
export function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: retrieveKey(SERVICE_OPENAI) || "" });
  return _openai;
}

/** Shared lazy Anthropic SDK client. */
export function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: retrieveKey(SERVICE_ANTHROPIC) || "" });
  return _anthropic;
}
