/**
 * numutils.js — OBSOLETE number utilities
 *
 * This file is scheduled for removal. It will be replaced by src/core/precision.js
 * which fixes the rounding bug described below.
 *
 * BUG: Uses Math.trunc (truncation) instead of Math.round (round-half-up).
 *      Math.trunc(156.5) → 156, so format(1.565, 2) → "1.56" (WRONG).
 *      Correct result: Math.round(156.5) → 157, format(1.565, 2) → "1.57".
 */

export function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  // BUG: should be Math.round, not Math.trunc
  return Math.trunc(value * factor) / factor;
}
