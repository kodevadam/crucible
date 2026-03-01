/**
 * crucible — normalization.js
 *
 * Canonical text normalization for critique item ID minting.
 * PINNED: changing any behavior here changes all downstream IDs.
 * Tests in test/phase_integrity.test.js lock this down.
 */

export const NORMALIZATION_VERSION = "v1";

/**
 * Normalize critique item text for stable ID minting.
 *
 * v1 rules (in order):
 *   1. Trim leading/trailing whitespace
 *   2. Collapse all internal whitespace runs to a single space
 *   3. Fold to lowercase
 *   4. Strip punctuation that does not affect meaning:
 *      trailing periods, commas, colons, semicolons from the end
 *      (internal punctuation is preserved to avoid false collisions)
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeTextV1(text) {
  if (typeof text !== "string") throw new TypeError("normalizeTextV1: expected string");
  return text
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[.,;:!?]+$/, "");
}
