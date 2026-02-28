/**
 * crucible — models.js
 *
 * Pure, testable model-selection logic with no API client dependencies.
 *
 * Separation of concerns:
 *   - This module: filtering, ranking, selection (pure functions, easy to test)
 *   - cli.js:      API calls, caching, fallback warnings
 */

/**
 * Model IDs matching this pattern are excluded from chat-model selection.
 * "mini" and "nano" are cheaper/weaker variants that should not appear in the
 * same tier as their full-sized siblings (e.g. gpt-4o-mini ≠ gpt-4o).
 */
export const EXCLUDE =
  /transcribe|search|realtime|audio|vision|preview|tts|whisper|dall-e|instruct|embed|codex|mini|nano/i;

/**
 * Priority tiers for OpenAI model selection, highest-quality first.
 * Each pattern is anchored and uses a negative lookahead to prevent
 * cross-family contamination:
 *   - "gpt-4o" must not accidentally pull in "gpt-4o-mini" (handled by EXCLUDE
 *     too, but the lookahead makes intent explicit)
 *   - "gpt-4" (last tier) must not pull in gpt-4o or gpt-4.5 models
 *
 * The first tier with any usable (non-EXCLUDE) candidates wins.
 */
export const PRIORITY = [
  /^gpt-5/,               // gpt-5, gpt-5-turbo, … (mini/nano caught by EXCLUDE)
  /^gpt-4\.5/,            // gpt-4.5 (preview caught by EXCLUDE)
  /^gpt-4o/,              // gpt-4o (mini caught by EXCLUDE)
  /^gpt-4(?!o|\.)/,       // plain gpt-4 family only — not gpt-4o or gpt-4.5
];

/** Hardcoded last-resort fallbacks, used only when models.list() fails. */
export const OPENAI_FALLBACK = "gpt-4o";
export const CLAUDE_FALLBACK = "claude-sonnet-4-6";

// ── Selection helpers ─────────────────────────────────────────────────────────

/**
 * Sort OpenAI model objects newest-first.
 *
 * Ranking within a group:
 *   1. "latest" aliases (e.g. gpt-4o-2024-latest) — always point to current
 *   2. `created` Unix timestamp descending (treat missing/falsy as 0 = oldest)
 *   3. Lexicographic descending as tiebreaker (ISO date suffixes sort correctly)
 */
function sortOpenAINewest(models) {
  return [...models].sort((a, b) => {
    const aLat = /\blatest\b/i.test(a.id);
    const bLat = /\blatest\b/i.test(b.id);
    if (aLat !== bLat) return aLat ? -1 : 1;

    const ac = a.created || 0;
    const bc = b.created || 0;
    if (ac !== bc) return bc - ac;

    return b.id.localeCompare(a.id);
  });
}

/**
 * Select the best GPT model from a list of OpenAI model objects.
 *
 * Returns the model ID string, or null if the list is empty / contains no
 * usable candidates.  Never throws.
 */
export function selectBestGPTModel(models) {
  const usable = (models || []).filter(m => m?.id && !EXCLUDE.test(m.id));
  for (const pat of PRIORITY) {
    const tier = sortOpenAINewest(usable.filter(m => pat.test(m.id)));
    if (tier.length) return tier[0].id;
  }
  return null;
}

/**
 * Select the best Claude Sonnet model from a list of Anthropic model objects.
 *
 * Ranking:
 *   1. `created_at` ISO string descending (treat missing as epoch = oldest)
 *   2. Lexicographic descending as tiebreaker
 *
 * Returns the model ID string, or null if no Sonnet model is found.
 */
export function selectBestClaudeModel(models) {
  const sonnets = (models || [])
    .filter(m => m?.id?.includes("sonnet"))
    .sort((a, b) => {
      const ac = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bc = b.created_at ? new Date(b.created_at).getTime() : 0;
      if (ac !== bc) return bc - ac;
      return b.id.localeCompare(a.id);
    });
  return sonnets[0]?.id || null;
}
