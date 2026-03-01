/**
 * crucible — critique_schema.js
 *
 * Zod schemas for the canonical debate data model.
 * Import these to validate at IO boundaries (DB reads, model output parse).
 *
 * Sections:
 *   A. Disposition enum + helpers
 *   B. CritiqueItem — host-minted, immutable
 *   C. DispositionRecord — one model/human/host decision on one item
 *   D. RoundArtifact — post-round computed state
 *   E. CritiqueItemStore and DispositionStore record shapes (for DB row IO)
 */

import { z } from "zod";

// ── A. Disposition enum ────────────────────────────────────────────────────────

export const DISPOSITIONS = [
  "accepted",
  "rejected",
  "deferred",
  "transformed",          // split/merged into child items
  "pending_transformation", // severity downgrade gate: ⚑ open
] ;

export const DispositionEnum = z.enum([
  "accepted",
  "rejected",
  "deferred",
  "transformed",
  "pending_transformation",
]);

export const RoleEnum = z.enum(["gpt", "claude", "human", "host"]);

export const SeverityEnum = z.enum(["blocking", "important", "minor"]);

export const CritiqueRoleEnum = z.enum(["gpt", "claude"]);

// ── B. CritiqueItem ────────────────────────────────────────────────────────────

export const CritiqueItemSchema = z.object({
  id:           z.string().regex(/^blk_[0-9a-f]{64}$/, "id must be blk_<sha256 64hex>"),
  display_id:   z.string(),
  proposal_id:  z.string().or(z.number()),
  role:         CritiqueRoleEnum,                  // which model produced it
  round:        z.number().int().positive(),
  severity:     SeverityEnum,
  title:        z.string().min(1),
  detail:       z.string(),
  normalized_text:            z.string(),
  normalization_spec_version: z.string(),          // e.g. "v1"
  derived_from:  z.array(z.string()).nullable(),   // item IDs, or null
  root_ids:      z.array(z.string()),              // always ≥1; self if root
  root_severity: SeverityEnum.nullable(),          // computed from root_ids
  similarity_warn: z.array(z.string()).nullable(), // display_ids of near-matches
  minted_at:    z.string(),                        // ISO 8601
  minted_by:    z.literal("host"),
});

// ── C. DispositionRecord ───────────────────────────────────────────────────────

export const TransformationSchema = z.object({
  child_ids:                 z.array(z.string()),    // IDs of successor items
  rationale:                 z.string(),
  proposed_severity_downgrade: z.boolean().optional(), // true when ⚑ gate open
});

export const DispositionRecordSchema = z.object({
  disposition_id:  z.string(),              // uuid
  proposal_id:     z.string().or(z.number()),
  item_id:         z.string(),              // references CritiqueItem.id
  round:           z.number().int().nonnegative(),
  decided_by:      RoleEnum,
  decision:        DispositionEnum,
  rationale:       z.string(),
  transformation:  TransformationSchema.nullable(),
  proposed_at:     z.string(),             // ISO 8601
  terminal_at:     z.string().nullable(),  // ISO 8601 or null if not terminal
});

// ── D. RoundArtifact ──────────────────────────────────────────────────────────

export const ConvergenceStateEnum = z.enum(["open", "closed"]);

export const RoundArtifactSchema = z.object({
  proposal_id:             z.string().or(z.number()),
  round:                   z.number().int().positive(),
  artifact_id:             z.string(),                  // uuid
  produced_at:             z.string(),                  // ISO 8601
  gpt_plan:                z.string(),                  // raw JSON string
  claude_plan:             z.string(),                  // raw JSON string
  gpt_critique_ids:        z.array(z.string()),
  claude_critique_ids:     z.array(z.string()),
  dispositions:            z.record(z.array(DispositionRecordSchema)),
  normalization_spec_version: z.string(),
  active_set:              z.array(z.string()),         // item IDs
  pending_flags:           z.array(z.string()),         // item IDs with ⚑ open
  convergence_state:       ConvergenceStateEnum,
  dag_validated:           z.boolean(),
  dag_validated_at:        z.string().nullable(),
});

// ── E. DB row shapes (for reading back from SQLite) ────────────────────────────
// SQLite stores JSON arrays/objects as TEXT; these schemas describe the parsed shape.

export const CritiqueItemRowSchema = CritiqueItemSchema.extend({
  derived_from:    z.array(z.string()).or(z.null()),
  root_ids:        z.array(z.string()),
  similarity_warn: z.array(z.string()).or(z.null()),
});

export const DispositionRowSchema = DispositionRecordSchema.extend({
  transformation: TransformationSchema.or(z.null()),
});

// ── Lineage entry shape (built at synthesis time) ─────────────────────────────

export const LineageEntrySchema = z.object({
  id:          z.string(),
  display_id:  z.string(),
  round:       z.number().int().nonnegative(),
  by:          RoleEnum,
  title:       z.string(),
  decision:    DispositionEnum.nullable(),
  rationale:   z.string().nullable(),
  superseded:  z.union([
    z.literal(false),
    z.object({ by: z.enum(["human", "host"]), at: z.string() }),
  ]),
});
