/**
 * formatter.test.js
 *
 * Tests for the number formatter.  These tests exercise round-half-up
 * semantics.  They FAIL with the buggy Math.trunc implementation in
 * numutils.js and PASS once formatter.js is wired to core/precision.js.
 *
 * Failure analysis:
 *   format(1.565, 2) with Math.trunc:
 *     1.565 * 100 = 156.50000000000003  (IEEE 754)
 *     Math.trunc(156.500…) = 156
 *     156 / 100 = 1.56
 *     (1.56).toFixed(2) = "1.56"   ← WRONG, expected "1.57"
 *
 *   format(2.7, 0) with Math.trunc:
 *     2.7 * 1 = 2.7
 *     Math.trunc(2.7) = 2
 *     (2).toFixed(0) = "2"         ← WRONG, expected "3"
 */

import { test }   from "node:test";
import assert      from "node:assert/strict";
import { format }  from "../src/formatter.js";

test("format rounds 1.565 to 2dp using round-half-up (not truncation)", () => {
  assert.equal(format(1.565, 2), "1.57");
});

test("format rounds 2.7 to 0dp correctly", () => {
  assert.equal(format(2.7, 0), "3");
});

test("format leaves exactly-representable values unchanged", () => {
  assert.equal(format(1.5,  1), "1.5");
  assert.equal(format(3.14, 2), "3.14");
  assert.equal(format(0,    3), "0.000");
});
