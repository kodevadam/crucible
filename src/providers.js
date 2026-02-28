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
