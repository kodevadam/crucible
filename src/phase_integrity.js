/**
 * crucible — phase_integrity.js
 *
 * Host-side pipeline integrity for the critique/disposition system.
 * All public functions are pure (explicit inputs, no global state) except
 * processCritiqueRound(), which coordinates DB writes via the db argument.
 *
 * Sections:
 *   1. ID minting (SHA-256, deterministic)
 *   2. DAG validation (cycle detection)
 *   3. Effective disposition (authority precedence)
 *   4. Terminal / active-set / convergence computation
 *   5. Pending flags
 *   6. Root-severity computation (RS2)
 *   7. Similarity warning
 *   8. Full write path: processCritiqueRound()
 *   9. Lineage card builder (synthesis prompt construction)
 */

import { createHash, randomUUID } from "crypto";
import { normalizeTextV1, NORMALIZATION_VERSION } from "./normalization.js";

// ── 1. ID minting ─────────────────────────────────────────────────────────────

/**
 * Mint a stable CritiqueItem ID.
 * Scope: proposal_id | role | round | normalized_text
 * Format: "blk_" + hex(sha256(scope))
 */
export function mintCritiqueId(proposalId, role, round, normalizedText) {
  const scope = `${proposalId}|${role}|${round}|${normalizedText}`;
  const hex   = createHash("sha256").update(scope, "utf8").digest("hex");
  return `blk_${hex}`;
}

/**
 * Derive a human-readable display ID from the full ID.
 * Format: "blk_" + first 8 hex chars
 */
export function displayId(id) {
  return id.slice(0, 12); // "blk_" + 8 chars
}

// ── 2. DAG validation ─────────────────────────────────────────────────────────

/**
 * Validate the derived_from DAG for a proposal.
 * Returns { valid: true } or { valid: false, cycle: string[] }
 *
 * @param {Map<string, {derived_from: string[]|null}>} itemStore  id → item
 */
export function validateDag(itemStore) {
  // DFS with three-colour marking: white=0, grey=1 (in-stack), black=2 (done)
  const colour = new Map();
  const parent = new Map();

  function dfs(id) {
    colour.set(id, 1);
    const item = itemStore.get(id);
    for (const parentId of (item?.derived_from || [])) {
      if (!itemStore.has(parentId)) continue; // cross-proposal refs allowed by spec
      const c = colour.get(parentId) || 0;
      if (c === 1) {
        // Back-edge — cycle found; reconstruct path
        const cycle = [parentId];
        let cur = id;
        while (cur !== parentId) { cycle.push(cur); cur = parent.get(cur); }
        cycle.push(parentId);
        return cycle.reverse();
      }
      if (c === 0) {
        parent.set(parentId, id);
        const found = dfs(parentId);
        if (found) return found;
      }
    }
    colour.set(id, 2);
    return null;
  }

  for (const id of itemStore.keys()) {
    if (!colour.get(id)) {
      const cycle = dfs(id);
      if (cycle) return { valid: false, cycle };
    }
  }
  return { valid: true };
}

// ── 3. Effective disposition ──────────────────────────────────────────────────

/**
 * Authority precedence: human > host > model.
 * Within the same authority, latest proposed_at wins.
 *
 * @param {Array<import('./critique_schema.js').DispositionRecord>} records
 * @returns {import('./critique_schema.js').DispositionRecord | null}
 */
export function getEffectiveDisposition(records) {
  if (!records || !records.length) return null;

  const rank = r => {
    if (r.decided_by === "human") return 3;
    if (r.decided_by === "host")  return 2;
    return 1; // gpt or claude = model
  };

  return records.reduce((best, cur) => {
    if (!best) return cur;
    const rb = rank(best), rc = rank(cur);
    if (rc > rb) return cur;
    if (rc === rb && cur.proposed_at > best.proposed_at) return cur;
    return best;
  }, null);
}

// ── 4. Terminal / active-set / convergence ────────────────────────────────────

/**
 * Terminal dispositions — items that are done and cannot be reopened.
 * "transformed" is terminal only when all its children are also terminal.
 * "pending_transformation" is NEVER terminal (⚑ gate open).
 */
const TERMINAL_DECISIONS = new Set(["accepted", "rejected", "deferred"]);

/**
 * Is the effective disposition terminal for this item?
 *
 * @param {object|null} effectiveDisp  result of getEffectiveDisposition()
 * @param {string[]}    childIds       host-computed child IDs (for "transformed")
 * @param {(id:string) => boolean} isChildTerminal
 */
export function isTerminal(effectiveDisp, childIds = [], isChildTerminal = () => false) {
  if (!effectiveDisp) return false;
  if (TERMINAL_DECISIONS.has(effectiveDisp.decision)) return true;
  if (effectiveDisp.decision === "transformed") {
    return childIds.length > 0 && childIds.every(isChildTerminal);
  }
  // "pending_transformation" → never terminal
  return false;
}

/**
 * A leaf is "active" if all its children (in this proposal) are terminal up to `round`.
 * An item with no children is always a leaf.
 *
 * @param {string}   itemId
 * @param {string[]} childIds   host-computed children of this item
 * @param {(id:string) => boolean} isChildTerminalFn
 */
export function isLeafActive(itemId, childIds, isChildTerminalFn) {
  if (!childIds.length) return true;
  return childIds.every(id => isChildTerminalFn(id));
}

/**
 * Compute the active set for a round: non-terminal leaf items.
 *
 * @param {Map<string, object>}  itemStore      id → CritiqueItem
 * @param {Map<string, object[]>} dispositions  id → DispositionRecord[]
 * @param {Map<string, string[]>} childrenMap   id → child id[]
 * @returns {string[]}  IDs of active items (non-terminal leaves)
 */
export function computeActiveSet(itemStore, dispositions, childrenMap) {
  // First, determine terminal status for all items
  const terminalCache = new Map();

  function itemIsTerminal(id) {
    if (terminalCache.has(id)) return terminalCache.get(id);
    const records = dispositions.get(id) || [];
    const eff     = getEffectiveDisposition(records);
    const children = childrenMap.get(id) || [];
    const result  = isTerminal(eff, children, itemIsTerminal);
    terminalCache.set(id, result);
    return result;
  }

  const active = [];
  for (const [id] of itemStore) {
    if (itemIsTerminal(id)) continue;
    const children = childrenMap.get(id) || [];
    if (isLeafActive(id, children, itemIsTerminal)) {
      active.push(id);
    }
  }
  return active;
}

/**
 * Convergence: closed iff no blocking items remain in the active set.
 *
 * @param {string[]}            activeSet
 * @param {Map<string, object>} itemStore
 */
export function computeConvergenceState(activeSet, itemStore) {
  const hasBlocking = activeSet.some(id => {
    const item = itemStore.get(id);
    return item?.severity === "blocking";
  });
  return hasBlocking ? "open" : "closed";
}

// ── 5. Pending flags ──────────────────────────────────────────────────────────

/**
 * Return item IDs that have an open ⚑ flag:
 * effective disposition is "pending_transformation".
 *
 * @param {Map<string, object[]>} dispositions  id → DispositionRecord[]
 */
export function computePendingFlags(dispositions) {
  const flags = [];
  for (const [id, records] of dispositions) {
    const eff = getEffectiveDisposition(records);
    if (eff?.decision === "pending_transformation") flags.push(id);
  }
  return flags;
}

// ── 6. Root-severity computation (RS2) ────────────────────────────────────────

const SEV_RANK = { blocking: 3, important: 2, minor: 1 };

/**
 * Compute root_severity for an item: max severity across all root_ids.
 *
 * @param {string[]}            rootIds
 * @param {Map<string, object>} itemStore
 * @returns {"blocking"|"important"|"minor"|null}
 */
export function computeRootSeverity(rootIds, itemStore) {
  if (!rootIds.length) return null;
  let best = null;
  for (const rid of rootIds) {
    const root = itemStore.get(rid);
    if (!root) continue;
    const r = SEV_RANK[root.severity];
    if (r === undefined) continue;
    if (best === null || r > SEV_RANK[best]) best = root.severity;
  }
  return best;
}

// ── 7. Similarity warning ─────────────────────────────────────────────────────

/**
 * Warn if a new item (derived_from==null) is suspiciously similar to a
 * closed item. Uses character-level Jaccard on 3-grams.
 *
 * @param {string}   normalizedText
 * @param {object[]} closedItems     [{id, normalized_text}]
 * @param {number}   threshold       default 0.7
 * @returns {string[]}  IDs of near-matches
 */
export function computeSimilarityWarn(normalizedText, closedItems, threshold = 0.7) {
  const warns = [];
  const aGrams = trigrams(normalizedText);
  if (!aGrams.size) return warns;

  for (const item of closedItems) {
    const bGrams = trigrams(item.normalized_text || "");
    if (!bGrams.size) continue;
    const inter = [...aGrams].filter(g => bGrams.has(g)).length;
    const union  = new Set([...aGrams, ...bGrams]).size;
    if (inter / union >= threshold) warns.push(item.id);
  }
  return warns;
}

function trigrams(str) {
  const s = new Set();
  for (let i = 0; i + 2 < str.length; i++) s.add(str.slice(i, i + 3));
  return s;
}

// ── 8. Full write path: processCritiqueRound() ───────────────────────────────

/**
 * Process one model's critique output for a round.
 *
 * Steps (matching spec §2 write path):
 *   1. Parse raw critique items from model output
 *   2. Normalize text (pinned version)
 *   3. Mint IDs
 *   4. Validate derived_from existence + same-response ordering
 *   5. Compute root_ids
 *   6. Similarity warn (derived_from==null vs closed items)
 *   7. Insert minted CritiqueItems (immutable)
 *   8. Compute child_ids host-side
 *   9. Validate + apply dispositions (downgrade gate)
 *  10. Insert disposition records
 *
 * @param {object}   opts
 * @param {string|number} opts.proposalId
 * @param {"gpt"|"claude"} opts.role
 * @param {number}   opts.round
 * @param {object[]} opts.rawItems         parsed from model output
 *   Each: { severity, title, detail, derived_from?: string[], disposition?: object }
 * @param {Map<string,object>}  opts.itemStore       existing CritiqueItems
 * @param {Map<string,object[]>} opts.dispositionStore existing dispositions
 * @param {object[]} opts.closedItems       [{id, normalized_text}] for sim-warn
 * @param {function} opts.insertItems       (items[]) => void
 * @param {function} opts.insertDispositions (records[]) => void
 *
 * @returns {{ mintedItems: object[], dispositionRecords: object[], warnings: string[], errors: string[] }}
 */
export function processCritiqueRound({
  proposalId,
  role,
  round,
  rawItems,
  itemStore,
  dispositionStore,
  closedItems = [],
  insertItems,
  insertDispositions,
}) {
  const errors   = [];
  const warnings = [];
  const mintedItems         = [];
  const dispositionRecords  = [];

  // Track newly-minted IDs in parse order for same-response ordering validation
  const mintedThisResponse = new Map(); // id → parse-order index

  // Pre-compute terminal status for all items already in canonical store.
  // Used by the closed-ID re-activation guard (step 4a).
  const existingTerminalCache = new Map();
  {
    const existingChildren = buildChildrenMap(itemStore);
    function checkExistingTerminal(id) {
      if (existingTerminalCache.has(id)) return existingTerminalCache.get(id);
      const records  = dispositionStore.get(id) || [];
      const eff      = getEffectiveDisposition(records);
      const children = existingChildren.get(id) || [];
      const result   = isTerminal(eff, children, checkExistingTerminal);
      existingTerminalCache.set(id, result);
      return result;
    }
    for (const id of itemStore.keys()) checkExistingTerminal(id);
  }

  // ── Steps 1-6: mint all items first (no dispositions yet) ─────────────────
  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];

    // 2. Normalize
    const normalizedText = normalizeTextV1(raw.title + " " + raw.detail);

    // 3. Mint ID
    const id         = mintCritiqueId(proposalId, role, round, normalizedText);
    const dispId     = displayId(id);

    // 4a. Validate derived_from existence
    const derivedFrom = raw.derived_from || null;
    if (derivedFrom) {
      for (const parentId of derivedFrom) {
        const inCanonical = itemStore.has(parentId);
        const inResponse  = mintedThisResponse.has(parentId);
        if (!inCanonical && !inResponse) {
          errors.push(`Item "${dispId}": derived_from "${parentId.slice(0,12)}" not found in store or this response`);
          continue;
        }
        // 4b. Closed-ID re-activation guard: reject derived_from on terminal items.
        // If a concern re-emerges, mint a new root item (optionally linking via
        // derived_from to preserve lineage context, but only if parent is active).
        if (inCanonical && existingTerminalCache.get(parentId)) {
          const eff = getEffectiveDisposition(dispositionStore.get(parentId) || []);
          errors.push(
            `Item "${dispId}": derived_from "${parentId.slice(0,12)}" is already resolved` +
            ` (${eff?.decision || "terminal"} at round ${eff?.round ?? "?"}) — mint a new root item if the concern re-emerges`
          );
          continue;
        }
        // 4c. Same-response ordering: parent must appear earlier
        if (inResponse && !inCanonical) {
          const parentIdx = mintedThisResponse.get(parentId);
          if (parentIdx >= i) {
            errors.push(`Item "${dispId}": derived_from "${parentId.slice(0,12)}" appears later in same response (forward ref)`);
          }
        }
      }
    }

    // 5. Compute root_ids
    let rootIds;
    if (!derivedFrom || !derivedFrom.length) {
      rootIds = [id]; // self is the root
    } else {
      const parentRoots = new Set();
      for (const parentId of derivedFrom) {
        const parentItem = itemStore.get(parentId) || mintedItems.find(m => m.id === parentId);
        if (parentItem?.root_ids) {
          for (const r of parentItem.root_ids) parentRoots.add(r);
        } else {
          parentRoots.add(parentId); // fallback: treat parent as root
        }
      }
      rootIds = [...parentRoots];
    }

    // 6. Similarity warn (only for new roots, not derived items)
    let similarityWarn = null;
    if (!derivedFrom || !derivedFrom.length) {
      const warns = computeSimilarityWarn(normalizedText, closedItems);
      if (warns.length) {
        similarityWarn = warns;
        warnings.push(`Item "${dispId}": similar to closed item(s) ${warns.map(w => w.slice(0,12)).join(", ")}`);
      }
    }

    const item = {
      id,
      display_id:   dispId,
      proposal_id:  proposalId,
      role,
      round,
      severity:     raw.severity || "important",
      title:        raw.title,
      detail:       raw.detail || "",
      normalized_text:            normalizedText,
      normalization_spec_version: NORMALIZATION_VERSION,
      derived_from:  derivedFrom,
      root_ids:      rootIds,
      root_severity: computeRootSeverity(rootIds, itemStore),
      similarity_warn: similarityWarn,
      minted_at:    new Date().toISOString(),
      minted_by:    "host",
    };

    mintedItems.push(item);
    mintedThisResponse.set(id, i);
  }

  // 7. Insert items (immutable) — only if no hard errors
  if (errors.length === 0 && insertItems) {
    insertItems(mintedItems);
    // Merge into itemStore for child_ids computation below
    for (const item of mintedItems) itemStore.set(item.id, item);
  }

  // 8-10. Process dispositions
  for (const item of mintedItems) {
    const raw = rawItems.find(r => {
      const normalized = normalizeTextV1(r.title + " " + r.detail);
      return mintCritiqueId(proposalId, role, round, normalized) === item.id;
    });
    if (!raw?.disposition) continue;

    const disp = raw.disposition;

    // 8. Compute child_ids host-side (items that list this item in derived_from)
    const childIds = mintedItems
      .filter(m => m.derived_from?.includes(item.id))
      .map(m => m.id);

    // 9. Validate disposition
    const decision = disp.decision;
    if (!["accepted","rejected","deferred","transformed","pending_transformation"].includes(decision)) {
      errors.push(`Item "${item.display_id}": unknown disposition "${decision}"`);
      continue;
    }

    // transformed requires child_ids
    if (decision === "transformed" && !childIds.length) {
      errors.push(`Item "${item.display_id}": disposition "transformed" requires at least one child item`);
      continue;
    }

    // Blocking items cannot be deferred
    if (decision === "deferred" && item.severity === "blocking") {
      errors.push(`Item "${item.display_id}": blocking item may not be deferred`);
      continue;
    }

    // Severity downgrade gate
    let finalDecision = decision;
    let proposedSeverityDowngrade = false;
    if (disp.severity_downgrade_to) {
      const fromRank = SEV_RANK[item.severity] || 0;
      const toRank   = SEV_RANK[disp.severity_downgrade_to] || 0;
      if (toRank < fromRank) {
        // Open the ⚑ gate
        finalDecision = "pending_transformation";
        proposedSeverityDowngrade = true;
        warnings.push(`Item "${item.display_id}": severity downgrade proposed — ⚑ gate opened, requires host resolution`);
      }
    }

    const isTerminalDecision = ["accepted","rejected","deferred"].includes(finalDecision);
    const now = new Date().toISOString();

    const transformation = (decision === "transformed" || proposedSeverityDowngrade)
      ? {
          child_ids: childIds,
          rationale: disp.rationale || "",
          proposed_severity_downgrade: proposedSeverityDowngrade || undefined,
        }
      : null;

    const record = {
      disposition_id: randomUUID(),
      proposal_id:    proposalId,
      item_id:        item.id,
      round,
      decided_by:     role,
      decision:       finalDecision,
      rationale:      disp.rationale || "",
      transformation,
      proposed_at:    now,
      terminal_at:    isTerminalDecision ? now : null,
    };

    dispositionRecords.push(record);
  }

  // 10. Insert disposition records
  if (errors.length === 0 && insertDispositions && dispositionRecords.length) {
    insertDispositions(dispositionRecords);
  }

  return { mintedItems, dispositionRecords, warnings, errors };
}

// ── 9. Lineage card builder ───────────────────────────────────────────────────

/**
 * Build lineage cards for the synthesis prompt.
 * One card per item in the active set. Each card contains:
 *   - item metadata (id, title, severity, root_severity)
 *   - lineage entries per root_id:
 *       minimum two-entry rule (root + immediate parent)
 *       full chain only if unbranched
 *   - superseded labeling per Amendment 2
 *
 * @param {object}  opts
 * @param {string|number} opts.proposalId
 * @param {number}  opts.round
 * @param {string[]} opts.activeSet          item IDs
 * @param {Map<string,object>}   opts.itemStore
 * @param {Map<string,object[]>} opts.dispositions  id → DispositionRecord[]
 *
 * @returns {object[]}  lineage cards
 */
export function buildLineageCards({ proposalId, round, activeSet, itemStore, dispositions }) {
  const cards = [];

  for (const leafId of activeSet) {
    const leaf = itemStore.get(leafId);
    if (!leaf) continue;

    const lineageByRoot = [];

    for (const rootId of leaf.root_ids) {
      const entries = buildRootSpine(leafId, rootId, itemStore, dispositions, round);
      lineageByRoot.push({ root_id: rootId, entries });
    }

    cards.push({
      id:            leaf.id,
      display_id:    leaf.display_id,
      round:         leaf.round,
      severity:      leaf.severity,
      root_severity: leaf.root_severity,
      title:         leaf.title,
      lineage:       lineageByRoot,
    });
  }

  return cards;
}

/**
 * Build the spine entries for one root_id of a leaf.
 * Applies: two-entry minimum rule + superseded labeling.
 *
 * @param {string} leafId
 * @param {string} rootId
 * @param {Map<string,object>}   itemStore
 * @param {Map<string,object[]>} dispositions
 * @returns {object[]}  LineageEntry[]
 */
function buildRootSpine(leafId, rootId, itemStore, dispositions, currentRound) {
  // Find the ancestor chain from root to leaf on this root_id's path
  const chain = traceChain(leafId, rootId, itemStore);

  let selectedIds;

  if (chain === null) {
    // Could not trace — fall back to minimum: [root, leaf]
    selectedIds = rootId === leafId ? [leafId] : [rootId, leafId];
  } else if (isSingleChain(chain, itemStore)) {
    // Unbranched path — emit full chain
    selectedIds = chain;
  } else {
    // Branching graph — minimum two-entry rule
    if (rootId === leafId) {
      selectedIds = [leafId];
    } else {
      const directParent = findDirectParent(leafId, rootId, itemStore);
      selectedIds = directParent ? [rootId, directParent, leafId] : [rootId, leafId];
      // Dedupe
      selectedIds = [...new Set(selectedIds)];
    }
  }

  return selectedIds.map(id => toLineageEntry(id, itemStore, dispositions, currentRound));
}

/**
 * Trace the ancestor chain from root to leaf along rootId's path.
 * Returns ordered [root, ..., leaf] or null if untraceable.
 */
function traceChain(leafId, rootId, itemStore) {
  if (leafId === rootId) return [leafId];

  // Walk up derived_from, keeping only ancestors that share rootId
  const visited = new Set();
  const chain   = [leafId];
  let   current = leafId;

  while (current !== rootId) {
    if (visited.has(current)) return null; // cycle guard
    visited.add(current);
    const item = itemStore.get(current);
    if (!item) return null;
    const parents = (item.derived_from || []).filter(pid => {
      const p = itemStore.get(pid);
      return p && p.root_ids.includes(rootId);
    });
    if (!parents.length) return null;
    if (parents.length > 1) {
      // Multiple parents on this root's path — pick the one closest to root
      // (lowest round), but signal that this is a branching graph
      current = parents[0];
    } else {
      current = parents[0];
    }
    chain.push(current);
    if (chain.length > 1000) return null; // safety
  }

  return chain.reverse();
}

/**
 * A chain is "single" (unbranched) if no item in the chain has more than
 * one child that shares rootId and also appears in the chain.
 */
function isSingleChain(chain, itemStore) {
  const chainSet = new Set(chain);
  for (const id of chain) {
    const item = itemStore.get(id);
    if (!item) continue;
    // Count how many chain members list this item as a direct parent
    let childCount = 0;
    for (const cid of chainSet) {
      const child = itemStore.get(cid);
      if (child?.derived_from?.includes(id)) childCount++;
    }
    if (childCount > 1) return false;
  }
  return true;
}

/** Find the immediate ancestor of leafId on rootId's path. */
function findDirectParent(leafId, rootId, itemStore) {
  const leaf = itemStore.get(leafId);
  if (!leaf) return null;
  const parents = (leaf.derived_from || []).filter(pid => {
    const p = itemStore.get(pid);
    return p && p.root_ids.includes(rootId);
  });
  return parents[0] || null;
}

/**
 * Convert a CritiqueItem to a LineageEntry, applying superseded labeling.
 * Amendment 2: if effective disposition is human/host, model records are
 * labeled superseded; effective record has superseded: false.
 */
function toLineageEntry(id, itemStore, dispositions, currentRound) {
  const item    = itemStore.get(id);
  const records = dispositions.get(id) || [];
  const eff     = getEffectiveDisposition(records);

  const effIsHumanOrHost = eff && (eff.decided_by === "human" || eff.decided_by === "host");

  // Stall-tracking audit signals (read-only; no enforcement)
  const deferredCount = records.filter(r => r.decision === "deferred").length;
  const roundsActive  = item ? Math.max(0, (currentRound ?? 0) - (item.round ?? 0)) : 0;

  // Build the entry for the effective disposition
  const entry = {
    id,
    display_id:    item?.display_id || id.slice(0, 12),
    round:         item?.round ?? 0,
    by:            item?.role || "host",
    title:         item?.title || "",
    decision:      eff?.decision ?? null,
    rationale:     eff?.rationale ?? null,
    superseded:    false,
    deferred_count: deferredCount,
    rounds_active:  roundsActive,
  };

  // If there are model records that were superseded by human/host, attach them
  if (effIsHumanOrHost) {
    const supersededRecords = records.filter(r =>
      (r.decided_by === "gpt" || r.decided_by === "claude") && r !== eff
    );
    if (supersededRecords.length) {
      entry.superseded_model_records = supersededRecords.map(r => ({
        decided_by:  r.decided_by,
        decision:    r.decision,
        rationale:   r.rationale,
        proposed_at: r.proposed_at,
        superseded:  { by: eff.decided_by, at: eff.proposed_at },
      }));
    }
  }

  return entry;
}

// ── 10. Synthesis gap detection ────────────────────────────────────────────────

/**
 * Identify blocking active-set items not addressed in the synthesis plan.
 * Replaces the fragile text-fingerprint approach in checkSynthesisConvergence.
 *
 * Matching order (first match wins):
 *   1. display_id appears literally in accepted_suggestions or rejected_suggestions
 *   2. Normalized title (first 50 chars) appears in those same fields
 *
 * Validators MUST call this against canonical stores, not compressed summaries.
 *
 * @param {string[]}            activeSet    item IDs
 * @param {Map<string,object>}  itemStore
 * @param {object|null}         synthesisPlan  parsed synthesis JSON
 * @returns {Array<{id,display_id,title,severity,round}>}  unaddressed blocking items
 */
export function computeSynthesisGaps(activeSet, itemStore, synthesisPlan) {
  const blockingActive = activeSet
    .map(id => itemStore.get(id))
    .filter(item => item && item.severity === "blocking");

  if (!blockingActive.length) return [];

  const addressedRaw  = [
    ...(synthesisPlan?.accepted_suggestions || []),
    ...(synthesisPlan?.rejected_suggestions || []),
  ].join("\n").toLowerCase();
  const addressedNorm = addressedRaw.replace(/[^a-z0-9\s]/g, "");

  return blockingActive.filter(item => {
    // 1. Exact display_id match — check raw text to preserve underscores in blk_XXXX
    if (addressedRaw.includes(item.display_id.toLowerCase())) return false;
    // 2. Normalized title match (first 50 meaningful chars)
    const titleNorm = (item.title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim()
      .slice(0, 50);
    if (titleNorm.length > 8 && addressedNorm.includes(titleNorm)) return false;
    return true;
  }).map(item => ({
    id:         item.id,
    display_id: item.display_id,
    title:      item.title,
    severity:   item.severity,
    round:      item.round,
  }));
}

// ── Utility: build childrenMap from itemStore ─────────────────────────────────

/**
 * Build a Map<itemId, childId[]> from the item store.
 * A child is any item whose derived_from includes the parent.
 *
 * @param {Map<string,object>} itemStore
 * @returns {Map<string,string[]>}
 */
export function buildChildrenMap(itemStore) {
  const map = new Map();
  for (const [id] of itemStore) map.set(id, []);
  for (const [id, item] of itemStore) {
    for (const parentId of (item.derived_from || [])) {
      if (map.has(parentId)) map.get(parentId).push(id);
    }
  }
  return map;
}
