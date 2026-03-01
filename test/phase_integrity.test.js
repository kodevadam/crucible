/**
 * Tests for src/phase_integrity.js and src/normalization.js
 *
 * Covers every invariant defined in the frozen spec:
 *   - Normalization v1 exact behavior
 *   - ID minting determinism and scope isolation
 *   - derived_from existence + same-response ordering
 *   - DAG cycle detection
 *   - ActiveSet correctness (leaf semantics L2)
 *   - Convergence semantics
 *   - Severity downgrade gate (⚑)
 *   - Superseded labeling in lineage entries
 *   - Similarity warn fires but does not block
 *   - Same text, different role => different IDs
 *   - Transform parent into children: all leaves must resolve
 *   - Closed ID reactivation => hard reject
 *   - deferred_count / rounds_active in lineage entries
 *   - computeSynthesisGaps uses canonical IDs, not fuzzy text
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { normalizeTextV1, NORMALIZATION_VERSION } from "../src/normalization.js";
import {
  mintCritiqueId,
  displayId,
  validateDag,
  getEffectiveDisposition,
  isTerminal,
  computeActiveSet,
  computeConvergenceState,
  computePendingFlags,
  computeRootSeverity,
  computeSimilarityWarn,
  computeSynthesisGaps,
  processCritiqueRound,
  buildLineageCards,
  buildChildrenMap,
} from "../src/phase_integrity.js";

// ── Normalization v1 ───────────────────────────────────────────────────────────

describe("normalizeTextV1", () => {
  test("trims leading/trailing whitespace", () => {
    assert.equal(normalizeTextV1("  hello  "), "hello");
  });

  test("collapses internal whitespace to single space", () => {
    assert.equal(normalizeTextV1("hello   world\t\there"), "hello world here");
  });

  test("folds to lowercase", () => {
    assert.equal(normalizeTextV1("Hello World"), "hello world");
  });

  test("strips trailing period", () => {
    assert.equal(normalizeTextV1("some issue."), "some issue");
  });

  test("strips trailing comma", () => {
    assert.equal(normalizeTextV1("some issue,"), "some issue");
  });

  test("strips trailing colon/semicolon/exclamation/question", () => {
    assert.equal(normalizeTextV1("issue:"), "issue");
    assert.equal(normalizeTextV1("issue;"), "issue");
    assert.equal(normalizeTextV1("issue!"), "issue");
    assert.equal(normalizeTextV1("issue?"), "issue");
  });

  test("preserves internal punctuation", () => {
    assert.equal(normalizeTextV1("missing error-handling in step 3"), "missing error-handling in step 3");
  });

  test("throws on non-string input", () => {
    assert.throws(() => normalizeTextV1(42), TypeError);
    assert.throws(() => normalizeTextV1(null), TypeError);
  });

  test("NORMALIZATION_VERSION is 'v1'", () => {
    assert.equal(NORMALIZATION_VERSION, "v1");
  });

  test("identical text normalizes identically (pinned)", () => {
    const a = normalizeTextV1("  No retry logic for transient errors.  ");
    const b = normalizeTextV1("  No retry logic for transient errors.  ");
    assert.equal(a, b);
  });
});

// ── ID minting ─────────────────────────────────────────────────────────────────

describe("mintCritiqueId", () => {
  test("produces blk_ prefix + 64 hex chars", () => {
    const id = mintCritiqueId("1", "gpt", 1, "some text");
    assert.match(id, /^blk_[0-9a-f]{64}$/);
  });

  test("deterministic for same inputs", () => {
    const a = mintCritiqueId("1", "gpt", 1, "same text");
    const b = mintCritiqueId("1", "gpt", 1, "same text");
    assert.equal(a, b);
  });

  test("differs by proposal_id", () => {
    const a = mintCritiqueId("1", "gpt", 1, "text");
    const b = mintCritiqueId("2", "gpt", 1, "text");
    assert.notEqual(a, b);
  });

  test("differs by role (same text same round)", () => {
    const a = mintCritiqueId("1", "gpt",    1, "same text");
    const b = mintCritiqueId("1", "claude", 1, "same text");
    assert.notEqual(a, b);
  });

  test("differs by round", () => {
    const a = mintCritiqueId("1", "gpt", 1, "text");
    const b = mintCritiqueId("1", "gpt", 2, "text");
    assert.notEqual(a, b);
  });

  test("differs by text", () => {
    const a = mintCritiqueId("1", "gpt", 1, "text a");
    const b = mintCritiqueId("1", "gpt", 1, "text b");
    assert.notEqual(a, b);
  });

  test("displayId is blk_ + 8 chars = 12 chars total", () => {
    const id  = mintCritiqueId("1", "gpt", 1, "text");
    const did = displayId(id);
    assert.equal(did.length, 12);
    assert.ok(did.startsWith("blk_"));
  });
});

// ── DAG validation ─────────────────────────────────────────────────────────────

describe("validateDag", () => {
  test("valid: empty store", () => {
    assert.deepEqual(validateDag(new Map()), { valid: true });
  });

  test("valid: linear chain root → child → grandchild", () => {
    const store = new Map([
      ["root", { derived_from: null }],
      ["child", { derived_from: ["root"] }],
      ["gc", { derived_from: ["child"] }],
    ]);
    assert.deepEqual(validateDag(store), { valid: true });
  });

  test("valid: diamond (shared ancestor)", () => {
    const store = new Map([
      ["root", { derived_from: null }],
      ["a",    { derived_from: ["root"] }],
      ["b",    { derived_from: ["root"] }],
      ["leaf", { derived_from: ["a", "b"] }],
    ]);
    assert.deepEqual(validateDag(store), { valid: true });
  });

  test("invalid: self-loop", () => {
    const store = new Map([
      ["a", { derived_from: ["a"] }],
    ]);
    const result = validateDag(store);
    assert.equal(result.valid, false);
    assert.ok(Array.isArray(result.cycle));
  });

  test("invalid: cycle of two", () => {
    const store = new Map([
      ["a", { derived_from: ["b"] }],
      ["b", { derived_from: ["a"] }],
    ]);
    const result = validateDag(store);
    assert.equal(result.valid, false);
  });

  test("cross-proposal refs (missing from store) are ignored", () => {
    const store = new Map([
      ["a", { derived_from: ["external-id-not-in-store"] }],
    ]);
    assert.deepEqual(validateDag(store), { valid: true });
  });
});

// ── Effective disposition ──────────────────────────────────────────────────────

describe("getEffectiveDisposition", () => {
  const rec = (decided_by, decision, proposed_at) => ({ decided_by, decision, proposed_at });

  test("returns null for empty array", () => {
    assert.equal(getEffectiveDisposition([]), null);
    assert.equal(getEffectiveDisposition(null), null);
  });

  test("human beats model", () => {
    const records = [
      rec("gpt",   "rejected",  "2024-01-01T00:00:00Z"),
      rec("human", "accepted",  "2024-01-02T00:00:00Z"),
    ];
    assert.equal(getEffectiveDisposition(records).decided_by, "human");
  });

  test("host beats model", () => {
    const records = [
      rec("claude", "deferred", "2024-01-01T00:00:00Z"),
      rec("host",   "accepted", "2024-01-02T00:00:00Z"),
    ];
    assert.equal(getEffectiveDisposition(records).decided_by, "host");
  });

  test("human beats host", () => {
    const records = [
      rec("host",  "rejected", "2024-01-01T00:00:00Z"),
      rec("human", "accepted", "2024-01-02T00:00:00Z"),
    ];
    assert.equal(getEffectiveDisposition(records).decided_by, "human");
  });

  test("within same authority, latest proposed_at wins", () => {
    const records = [
      rec("gpt", "rejected", "2024-01-01T00:00:00Z"),
      rec("gpt", "accepted", "2024-01-03T00:00:00Z"),
    ];
    assert.equal(getEffectiveDisposition(records).decision, "accepted");
  });
});

// ── isTerminal ────────────────────────────────────────────────────────────────

describe("isTerminal", () => {
  const disp = (decision) => ({ decided_by: "gpt", decision, proposed_at: "" });

  test("null disposition → not terminal", () => {
    assert.equal(isTerminal(null), false);
  });

  test("accepted → terminal", () => {
    assert.equal(isTerminal(disp("accepted")), true);
  });

  test("rejected → terminal", () => {
    assert.equal(isTerminal(disp("rejected")), true);
  });

  test("deferred → terminal", () => {
    assert.equal(isTerminal(disp("deferred")), true);
  });

  test("pending_transformation → NEVER terminal", () => {
    assert.equal(isTerminal(disp("pending_transformation"), ["child1"], () => true), false);
  });

  test("transformed with all children terminal → terminal", () => {
    assert.equal(isTerminal(disp("transformed"), ["c1", "c2"], () => true), true);
  });

  test("transformed with no children → not terminal", () => {
    assert.equal(isTerminal(disp("transformed"), [], () => true), false);
  });

  test("transformed with some children non-terminal → not terminal", () => {
    const isChildTerminal = id => id === "c1"; // c2 is not
    assert.equal(isTerminal(disp("transformed"), ["c1", "c2"], isChildTerminal), false);
  });
});

// ── Active set ────────────────────────────────────────────────────────────────

describe("computeActiveSet", () => {
  function makeStore(items) {
    const m = new Map();
    for (const [id, data] of Object.entries(items)) m.set(id, { id, ...data });
    return m;
  }

  function makeDispositions(map) {
    const m = new Map();
    for (const [id, records] of Object.entries(map)) m.set(id, records);
    return m;
  }

  test("single non-disposed item is active", () => {
    const items        = makeStore({ a: { severity: "blocking", derived_from: null } });
    const dispositions = makeDispositions({});
    const children     = buildChildrenMap(items);
    const active       = computeActiveSet(items, dispositions, children);
    assert.deepEqual(active, ["a"]);
  });

  test("accepted item is not active", () => {
    const items = makeStore({ a: { severity: "blocking", derived_from: null } });
    const dispositions = makeDispositions({
      a: [{ decided_by: "gpt", decision: "accepted", proposed_at: "2024-01-01T00:00:00Z", terminal_at: "2024-01-01T00:00:00Z" }],
    });
    const children = buildChildrenMap(items);
    const active   = computeActiveSet(items, dispositions, children);
    assert.deepEqual(active, []);
  });

  test("parent transformed into two children — parent not active if both children accepted", () => {
    const items = makeStore({
      parent: { severity: "blocking", derived_from: null },
      c1:     { severity: "important", derived_from: ["parent"] },
      c2:     { severity: "minor",     derived_from: ["parent"] },
    });
    const now = "2024-01-01T00:00:00Z";
    const dispositions = makeDispositions({
      parent: [{ decided_by: "gpt", decision: "transformed",  proposed_at: now, terminal_at: null }],
      c1:     [{ decided_by: "gpt", decision: "accepted",     proposed_at: now, terminal_at: now }],
      c2:     [{ decided_by: "gpt", decision: "accepted",     proposed_at: now, terminal_at: now }],
    });
    const children = buildChildrenMap(items);
    const active   = computeActiveSet(items, dispositions, children);
    // parent is terminal (transformed + all children terminal); no active items
    assert.deepEqual(active, []);
  });

  test("parent transformed; one child unresolved — only leaf child is active", () => {
    const items = makeStore({
      parent: { severity: "blocking", derived_from: null },
      c1:     { severity: "important", derived_from: ["parent"] },
      c2:     { severity: "minor",     derived_from: ["parent"] },
    });
    const now = "2024-01-01T00:00:00Z";
    const dispositions = makeDispositions({
      parent: [{ decided_by: "gpt", decision: "transformed", proposed_at: now, terminal_at: null }],
      c1:     [{ decided_by: "gpt", decision: "accepted",    proposed_at: now, terminal_at: now }],
      // c2 has no disposition
    });
    const children = buildChildrenMap(items);
    const active   = computeActiveSet(items, dispositions, children);
    // parent not terminal (c2 not resolved); c1 terminal (not active); c2 active leaf
    assert.ok(active.includes("c2"));
    assert.ok(!active.includes("c1"));
  });
});

// ── Convergence ───────────────────────────────────────────────────────────────

describe("computeConvergenceState", () => {
  function makeStore(items) {
    const m = new Map();
    for (const [id, data] of Object.entries(items)) m.set(id, { id, ...data });
    return m;
  }

  test("empty active set → closed", () => {
    assert.equal(computeConvergenceState([], new Map()), "closed");
  });

  test("active set with only minor items → closed", () => {
    const store = makeStore({ a: { severity: "minor" }, b: { severity: "important" } });
    assert.equal(computeConvergenceState(["a", "b"], store), "closed");
  });

  test("active set with a blocking item → open", () => {
    const store = makeStore({ a: { severity: "blocking" } });
    assert.equal(computeConvergenceState(["a"], store), "open");
  });
});

// ── Pending flags ─────────────────────────────────────────────────────────────

describe("computePendingFlags", () => {
  const rec = (decision) => [{ decided_by: "gpt", decision, proposed_at: "2024-01-01T00:00:00Z" }];

  test("no flags for normal decisions", () => {
    const d = new Map([["a", rec("accepted")], ["b", rec("rejected")]]);
    assert.deepEqual(computePendingFlags(d), []);
  });

  test("pending_transformation item is flagged", () => {
    const d = new Map([
      ["a", rec("accepted")],
      ["b", rec("pending_transformation")],
    ]);
    assert.ok(computePendingFlags(d).includes("b"));
  });
});

// ── Root severity (RS2) ────────────────────────────────────────────────────────

describe("computeRootSeverity", () => {
  function makeStore(items) {
    const m = new Map();
    for (const [id, data] of Object.entries(items)) m.set(id, { id, ...data });
    return m;
  }

  test("returns null for empty rootIds", () => {
    assert.equal(computeRootSeverity([], new Map()), null);
  });

  test("single root returns its severity", () => {
    const store = makeStore({ r: { severity: "minor" } });
    assert.equal(computeRootSeverity(["r"], store), "minor");
  });

  test("max severity across multiple roots", () => {
    const store = makeStore({
      r1: { severity: "minor" },
      r2: { severity: "blocking" },
      r3: { severity: "important" },
    });
    assert.equal(computeRootSeverity(["r1", "r2", "r3"], store), "blocking");
  });
});

// ── Similarity warn ───────────────────────────────────────────────────────────

describe("computeSimilarityWarn", () => {
  test("identical text warns", () => {
    const closed = [{ id: "blk_aaa", normalized_text: "missing retry logic for transient errors" }];
    const warns  = computeSimilarityWarn("missing retry logic for transient errors", closed);
    assert.ok(warns.includes("blk_aaa"));
  });

  test("completely different text does not warn", () => {
    const closed = [{ id: "blk_aaa", normalized_text: "add authentication middleware" }];
    const warns  = computeSimilarityWarn("remove unused dependencies from package.json", closed, 0.7);
    assert.deepEqual(warns, []);
  });

  test("warn does not throw on empty closed list", () => {
    assert.doesNotThrow(() => computeSimilarityWarn("some text", []));
  });
});

// ── processCritiqueRound integration ─────────────────────────────────────────

describe("processCritiqueRound", () => {
  const baseOpts = {
    proposalId: "42",
    role:       "gpt",
    round:      1,
    closedItems: [],
  };

  test("mints items and returns them", () => {
    const itemStore       = new Map();
    const dispositionStore = new Map();
    const minted          = [];

    const result = processCritiqueRound({
      ...baseOpts,
      rawItems: [
        { severity: "blocking",  title: "No error handling",  detail: "steps 3-5 have no error handling" },
        { severity: "important", title: "Missing tests",       detail: "no unit tests defined" },
      ],
      itemStore,
      dispositionStore,
      insertItems:        items => minted.push(...items),
      insertDispositions: ()    => {},
    });

    assert.equal(result.mintedItems.length, 2);
    assert.equal(result.errors.length, 0);
    assert.ok(result.mintedItems[0].id.startsWith("blk_"));
    assert.equal(result.mintedItems[0].minted_by, "host");
    assert.equal(result.mintedItems[0].normalization_spec_version, NORMALIZATION_VERSION);
  });

  test("same text, different role => different IDs", () => {
    const mkResult = (role) => processCritiqueRound({
      ...baseOpts,
      role,
      rawItems:           [{ severity: "blocking", title: "Same title", detail: "same detail" }],
      itemStore:          new Map(),
      dispositionStore:   new Map(),
      insertItems:        () => {},
      insertDispositions: () => {},
    });

    const gptId    = mkResult("gpt").mintedItems[0].id;
    const claudeId = mkResult("claude").mintedItems[0].id;
    assert.notEqual(gptId, claudeId);
  });

  test("derived_from with unknown parent => hard error", () => {
    const result = processCritiqueRound({
      ...baseOpts,
      rawItems: [{
        severity:    "important",
        title:       "Child item",
        detail:      "depends on unknown parent",
        derived_from: ["blk_" + "0".repeat(64)],
      }],
      itemStore:          new Map(),
      dispositionStore:   new Map(),
      insertItems:        () => {},
      insertDispositions: () => {},
    });

    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes("not found"));
  });

  test("similarity warn emits but does not block (no error)", () => {
    const normalizedText = "missing retry logic for transient errors";
    const closedItems    = [{ id: "blk_" + "a".repeat(64), normalized_text: normalizedText }];

    const result = processCritiqueRound({
      ...baseOpts,
      rawItems:     [{ severity: "important", title: "Missing retry logic for transient errors", detail: "" }],
      itemStore:    new Map(),
      dispositionStore: new Map(),
      closedItems,
      insertItems:        () => {},
      insertDispositions: () => {},
    });

    assert.equal(result.errors.length, 0);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings[0].includes("similar"));
  });

  test("severity downgrade gate opens ⚑ and sets pending_transformation", () => {
    const result = processCritiqueRound({
      ...baseOpts,
      rawItems: [{
        severity: "blocking",
        title:    "Needs auth middleware",
        detail:   "auth is missing",
        disposition: {
          decision:               "accepted",
          rationale:              "valid concern",
          severity_downgrade_to:  "important",  // downgrade proposed
        },
      }],
      itemStore:          new Map(),
      dispositionStore:   new Map(),
      insertItems:        () => {},
      insertDispositions: () => {},
    });

    assert.equal(result.errors.length, 0);
    assert.ok(result.warnings.some(w => w.includes("⚑")));
    assert.ok(result.dispositionRecords.some(d => d.decision === "pending_transformation"));
  });

  test("blocking item cannot be deferred → hard error", () => {
    const result = processCritiqueRound({
      ...baseOpts,
      rawItems: [{
        severity: "blocking",
        title:    "Critical security flaw",
        detail:   "sql injection in query",
        disposition: { decision: "deferred", rationale: "handle later" },
      }],
      itemStore:          new Map(),
      dispositionStore:   new Map(),
      insertItems:        () => {},
      insertDispositions: () => {},
    });

    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some(e => e.includes("blocking") && e.includes("deferred")));
  });
});

// ── Lineage card builder ───────────────────────────────────────────────────────

describe("buildLineageCards", () => {
  function makeStore(items) {
    const m = new Map();
    for (const [id, data] of Object.entries(items)) m.set(id, { id, display_id: id.slice(0,12), ...data });
    return m;
  }

  test("active item with no disposition produces card with decision: null", () => {
    const rootId   = mintCritiqueId("p1", "gpt", 1, "root issue root detail");
    const itemStore = new Map([[rootId, {
      id:           rootId,
      display_id:   displayId(rootId),
      round:        1,
      role:         "gpt",
      severity:     "blocking",
      root_severity: "blocking",
      title:        "root issue",
      derived_from: null,
      root_ids:     [rootId],
    }]]);

    const cards = buildLineageCards({
      proposalId:   "p1",
      round:        1,
      activeSet:    [rootId],
      itemStore,
      dispositions: new Map(),
    });

    assert.equal(cards.length, 1);
    assert.equal(cards[0].id, rootId);
    assert.equal(cards[0].lineage[0].entries[0].decision, null);
  });

  test("human disposition supersedes model record — model entry is labeled superseded", () => {
    const itemId = mintCritiqueId("p1", "gpt", 1, "auth missing auth detail");
    const itemStore = new Map([[itemId, {
      id:           itemId,
      display_id:   displayId(itemId),
      round:        1,
      role:         "gpt",
      severity:     "blocking",
      root_severity: "blocking",
      title:        "auth missing",
      derived_from: null,
      root_ids:     [itemId],
    }]]);

    const dispositions = new Map([[itemId, [
      { decided_by: "gpt",   decision: "deferred",  rationale: "model said defer",  proposed_at: "2024-01-01T00:00:00Z", terminal_at: "2024-01-01T00:00:00Z" },
      { decided_by: "human", decision: "accepted",  rationale: "human overrides",   proposed_at: "2024-01-02T00:00:00Z", terminal_at: "2024-01-02T00:00:00Z" },
    ]]]);

    const cards = buildLineageCards({
      proposalId:   "p1",
      round:        1,
      activeSet:    [itemId],
      itemStore,
      dispositions,
    });

    const entry = cards[0].lineage[0].entries[0];
    assert.equal(entry.decision, "accepted");   // human's decision
    assert.equal(entry.superseded, false);       // effective record is not superseded
    // The superseded model records should be attached
    assert.ok(Array.isArray(entry.superseded_model_records));
    assert.equal(entry.superseded_model_records[0].decided_by, "gpt");
    assert.ok(entry.superseded_model_records[0].superseded.by === "human");
  });
});

// ── buildChildrenMap ──────────────────────────────────────────────────────────

describe("buildChildrenMap", () => {
  test("root has no children if no item derives from it", () => {
    const store = new Map([
      ["root",  { derived_from: null }],
      ["other", { derived_from: null }],
    ]);
    const map = buildChildrenMap(store);
    assert.deepEqual(map.get("root"),  []);
    assert.deepEqual(map.get("other"), []);
  });

  test("child correctly appears in parent's children list", () => {
    const store = new Map([
      ["root",  { derived_from: null }],
      ["child", { derived_from: ["root"] }],
    ]);
    const map = buildChildrenMap(store);
    assert.deepEqual(map.get("root"),  ["child"]);
    assert.deepEqual(map.get("child"), []);
  });

  test("multi-parent child appears in both parent lists", () => {
    const store = new Map([
      ["a",    { derived_from: null }],
      ["b",    { derived_from: null }],
      ["leaf", { derived_from: ["a", "b"] }],
    ]);
    const map = buildChildrenMap(store);
    assert.ok(map.get("a").includes("leaf"));
    assert.ok(map.get("b").includes("leaf"));
  });
});

// ── Closed ID re-activation guard ─────────────────────────────────────────────

describe("processCritiqueRound — closed ID re-activation guard", () => {
  const baseOpts = {
    proposalId: "p1",
    role:       "gpt",
    round:      2,
    closedItems: [],
  };

  test("derived_from pointing to accepted (terminal) item => hard error", () => {
    const terminalId = mintCritiqueId("p1", "gpt", 1, "original concern original detail");

    // Pre-populate itemStore with a terminal item
    const itemStore = new Map([[terminalId, {
      id:           terminalId,
      display_id:   displayId(terminalId),
      round:        1,
      severity:     "blocking",
      derived_from: null,
      root_ids:     [terminalId],
    }]]);

    // Pre-populate dispositionStore: item is accepted (terminal)
    const now = "2024-01-01T00:00:00Z";
    const dispositionStore = new Map([[terminalId, [
      { decided_by: "gpt", decision: "accepted", proposed_at: now, terminal_at: now },
    ]]]);

    const result = processCritiqueRound({
      ...baseOpts,
      rawItems: [{
        severity:    "important",
        title:       "Follow-up concern",
        detail:      "more detail",
        derived_from: [terminalId],
      }],
      itemStore,
      dispositionStore,
      insertItems:        () => {},
      insertDispositions: () => {},
    });

    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some(e => e.includes("already resolved")));
    assert.ok(result.errors.some(e => e.includes("mint a new root item")));
  });

  test("derived_from pointing to active (non-terminal) item is allowed", () => {
    const parentId = mintCritiqueId("p1", "gpt", 1, "active parent active detail");

    // Pre-populate itemStore with a non-terminal item
    const itemStore = new Map([[parentId, {
      id:           parentId,
      display_id:   displayId(parentId),
      round:        1,
      severity:     "blocking",
      derived_from: null,
      root_ids:     [parentId],
    }]]);

    // No disposition → not terminal
    const dispositionStore = new Map();

    const result = processCritiqueRound({
      ...baseOpts,
      rawItems: [{
        severity:    "important",
        title:       "Child of active parent",
        detail:      "refined concern",
        derived_from: [parentId],
      }],
      itemStore,
      dispositionStore,
      insertItems:        () => {},
      insertDispositions: () => {},
    });

    assert.equal(result.errors.length, 0);
    assert.equal(result.mintedItems[0].derived_from[0], parentId);
  });

  test("derived_from pointing to rejected (terminal) item => hard error", () => {
    const rejectedId = mintCritiqueId("p1", "claude", 1, "rejected issue rejected detail");

    const itemStore = new Map([[rejectedId, {
      id:           rejectedId,
      display_id:   displayId(rejectedId),
      round:        1,
      severity:     "important",
      derived_from: null,
      root_ids:     [rejectedId],
    }]]);

    const now = "2024-01-01T00:00:00Z";
    const dispositionStore = new Map([[rejectedId, [
      { decided_by: "claude", decision: "rejected", proposed_at: now, terminal_at: now },
    ]]]);

    const result = processCritiqueRound({
      ...baseOpts,
      role:    "gpt",
      rawItems: [{
        severity:    "blocking",
        title:       "Re-raising rejected concern",
        detail:      "but it was rejected",
        derived_from: [rejectedId],
      }],
      itemStore,
      dispositionStore,
      insertItems:        () => {},
      insertDispositions: () => {},
    });

    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some(e => e.includes("already resolved") || e.includes("rejected")));
  });
});

// ── Stall tracking: deferred_count / rounds_active ────────────────────────────

describe("buildLineageCards — stall tracking fields", () => {
  test("deferred_count reflects number of deferred decisions", () => {
    const itemId = mintCritiqueId("p1", "gpt", 1, "stalled concern stalled detail");
    const itemStore = new Map([[itemId, {
      id:           itemId,
      display_id:   displayId(itemId),
      round:        1,
      role:         "gpt",
      severity:     "important",
      root_severity: "important",
      title:        "stalled concern",
      derived_from: null,
      root_ids:     [itemId],
    }]]);

    const now = "2024-01-01T00:00:00Z";
    const dispositions = new Map([[itemId, [
      { decided_by: "gpt", decision: "deferred",  rationale: "r1", proposed_at: now, terminal_at: null },
      { decided_by: "gpt", decision: "deferred",  rationale: "r2", proposed_at: "2024-01-02T00:00:00Z", terminal_at: null },
    ]]]);

    const cards = buildLineageCards({
      proposalId: "p1",
      round:      3,
      activeSet:  [itemId],
      itemStore,
      dispositions,
    });

    const entry = cards[0].lineage[0].entries[0];
    assert.equal(entry.deferred_count, 2);
  });

  test("rounds_active = current_round - item.round", () => {
    const itemId = mintCritiqueId("p1", "gpt", 1, "old concern old detail");
    const itemStore = new Map([[itemId, {
      id:           itemId,
      display_id:   displayId(itemId),
      round:        1,   // introduced round 1
      role:         "gpt",
      severity:     "blocking",
      root_severity: "blocking",
      title:        "old concern",
      derived_from: null,
      root_ids:     [itemId],
    }]]);

    const cards = buildLineageCards({
      proposalId:   "p1",
      round:        4,   // currently in round 4
      activeSet:    [itemId],
      itemStore,
      dispositions: new Map(),
    });

    const entry = cards[0].lineage[0].entries[0];
    assert.equal(entry.rounds_active, 3);  // 4 - 1
  });

  test("rounds_active is 0 for item introduced this round", () => {
    const itemId = mintCritiqueId("p1", "gpt", 2, "fresh concern fresh detail");
    const itemStore = new Map([[itemId, {
      id:           itemId,
      display_id:   displayId(itemId),
      round:        2,
      role:         "gpt",
      severity:     "important",
      root_severity: "important",
      title:        "fresh concern",
      derived_from: null,
      root_ids:     [itemId],
    }]]);

    const cards = buildLineageCards({
      proposalId:   "p1",
      round:        2,
      activeSet:    [itemId],
      itemStore,
      dispositions: new Map(),
    });

    const entry = cards[0].lineage[0].entries[0];
    assert.equal(entry.rounds_active, 0);
    assert.equal(entry.deferred_count, 0);
  });
});

// ── computeSynthesisGaps ──────────────────────────────────────────────────────

describe("computeSynthesisGaps", () => {
  function makeStore(items) {
    const m = new Map();
    for (const [id, data] of Object.entries(items)) m.set(id, { id, ...data });
    return m;
  }

  test("returns empty array when no blocking items in active set", () => {
    const store = makeStore({ a: { severity: "important", title: "minor thing", display_id: "blk_0000" } });
    const gaps  = computeSynthesisGaps(["a"], store, { accepted_suggestions: [] });
    assert.deepEqual(gaps, []);
  });

  test("returns empty array when all blocking items addressed by display_id", () => {
    const id    = mintCritiqueId("p1", "gpt", 1, "auth missing display match");
    const store = new Map([[id, {
      id,
      display_id: displayId(id),
      severity:   "blocking",
      title:      "auth missing",
      round:      1,
    }]]);

    const plan = {
      accepted_suggestions: [`[${displayId(id)}] auth added — reason accepted`],
      rejected_suggestions: [],
    };

    const gaps = computeSynthesisGaps([id], store, plan);
    assert.deepEqual(gaps, []);
  });

  test("returns empty array when blocking item addressed by title match", () => {
    const id    = mintCritiqueId("p1", "gpt", 1, "no retry logic title match");
    const store = new Map([[id, {
      id,
      display_id: displayId(id),
      severity:   "blocking",
      title:      "no retry logic",
      round:      1,
    }]]);

    const plan = {
      accepted_suggestions: ["no retry logic — added exponential backoff (source: GPT, severity: blocking)"],
      rejected_suggestions: [],
    };

    const gaps = computeSynthesisGaps([id], store, plan);
    assert.deepEqual(gaps, []);
  });

  test("returns unaddressed blocking items", () => {
    const id    = mintCritiqueId("p1", "gpt", 1, "sql injection unaddressed gap");
    const store = new Map([[id, {
      id,
      display_id: displayId(id),
      severity:   "blocking",
      title:      "sql injection vulnerability",
      round:      1,
    }]]);

    const plan = {
      accepted_suggestions: ["some unrelated thing accepted"],
      rejected_suggestions: [],
    };

    const gaps = computeSynthesisGaps([id], store, plan);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].id, id);
  });

  test("non-blocking active items are not included in gaps", () => {
    const id    = mintCritiqueId("p1", "gpt", 1, "minor style concern gap test");
    const store = new Map([[id, {
      id,
      display_id: displayId(id),
      severity:   "important",  // not blocking
      title:      "minor style concern",
      round:      1,
    }]]);

    const gaps = computeSynthesisGaps([id], store, { accepted_suggestions: [], rejected_suggestions: [] });
    assert.deepEqual(gaps, []);
  });

  test("handles null/empty synthesis plan gracefully", () => {
    const id    = mintCritiqueId("p1", "gpt", 1, "blocking issue null plan test");
    const store = new Map([[id, {
      id,
      display_id: displayId(id),
      severity:   "blocking",
      title:      "blocking issue",
      round:      1,
    }]]);

    assert.doesNotThrow(() => computeSynthesisGaps([id], store, null));
    assert.doesNotThrow(() => computeSynthesisGaps([id], store, {}));
  });
});
