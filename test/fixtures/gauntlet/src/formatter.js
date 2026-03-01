/**
 * formatter.js — human-readable number formatter
 *
 * Formats a number to a fixed number of decimal places using
 * round-half-up semantics.
 *
 * NOTE: The import below will be updated to ./core/precision.js once
 * that module is created and numutils.js is removed.
 */

import { roundTo } from "./numutils.js";

/**
 * Format a number to a fixed number of decimal places.
 *
 * @param {number} value    - The number to format
 * @param {number} decimals - Number of decimal places (0 or more)
 * @returns {string}
 */
export function format(value, decimals) {
  const rounded = roundTo(value, decimals);
  return rounded.toFixed(decimals);
}
