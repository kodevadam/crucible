-- Crucible experiment queries
-- SQLite; run with: sqlite3 ~/.crucible/crucible.db < analysis/experiment_queries.sql
--
-- Each query joins three message rows per proposal (one per phase):
--
--   g  →  phase='context_request', role='host'  (Phase 1a grounding stats)
--   c  →  phase='critique',        role='host'  (Phase 2 critique final stats)
--   s  →  phase='synthesis',       role='host'  (Phase 3 synthesis outcome)
--
-- JSON field locations:
--   grounding  →  json_extract(g.content, '$.groundingStats.<field>')
--   critique   →  json_extract(c.content, '$.<field>')
--   synthesis  →  json_extract(s.content, '$.<field>')
--
-- Three failure channels are kept orthogonal by design:
--   Grounding failure       →  divergence_rate, cap_hit_rate_*, overlap_uncapped_count
--   Negotiation failure     →  rounds_completed, converged_naturally
--   Constraint satisfaction →  blocking_unresolved_count            (semantic)
--   Structural hygiene      →  convergence_violations               (schema / format)
--
-- The conservation laws that must hold per run (use Q4 sanity check to verify):
--   blocking_active_going_in = blocking_resolved_count + blocking_unresolved_count
--   blocking_minted_total    = blocking_collapsed_dedup
--                            + blocking_pre_accepted + blocking_pre_rejected
--                            + blocking_pre_deferred + blocking_downgraded
--                            + blocking_active_going_in


-- ─── Q1: Full experiment table ────────────────────────────────────────────────
--
-- One row per completed proposal with every predictor and outcome field.
-- Paste into pandas / R for regression; filter by arm label when A/B testing.
--
-- recall_per_1k_tokens is the Pareto axis: quality / cost.
-- Computed via CTE so it can reference recall and the token sums cleanly.
--
-- Usage:
--   sqlite3 ~/.crucible/crucible.db ".mode csv" ".headers on" \
--     ".read analysis/experiment_queries.sql" | head -n 1   -- just Q1 headers

WITH run_data AS (
  SELECT
    p.id                                                               AS proposal_id,
    p.title,
    p.rounds,
    datetime(p.created_at)                                             AS created_at,
    -- ── Experiment arm / stratification ──────────────────────────────────────
    ses.arm                                                            AS arm,
    ses.task_class                                                     AS task_class,
    -- ── Phase 1a grounding predictors ────────────────────────────────────────
    json_extract(g.content, '$.groundingStats.divergence_rate')        AS divergence_rate,
    json_extract(g.content, '$.groundingStats.overlap_uncapped_count') AS overlap_uncapped_count,
    json_extract(g.content, '$.groundingStats.overlap_rate')           AS overlap_rate,
    json_extract(g.content, '$.groundingStats.cap_hit_rate_gpt')       AS cap_hit_rate_gpt,
    json_extract(g.content, '$.groundingStats.cap_hit_rate_claude')    AS cap_hit_rate_claude,
    json_extract(g.content, '$.groundingStats.union_count')            AS union_count,
    json_extract(g.content, '$.groundingStats.overlap_capped_count')   AS overlap_capped_count,
    json_extract(g.content, '$.groundingStats.gpt_capped')             AS gpt_capped,
    json_extract(g.content, '$.groundingStats.claude_capped')          AS claude_capped,
    json_extract(g.content, '$.tokens_gpt_in')                         AS draft_tokens_gpt_in,
    json_extract(g.content, '$.tokens_gpt_out')                        AS draft_tokens_gpt_out,
    json_extract(g.content, '$.tokens_claude_in')                      AS draft_tokens_claude_in,
    json_extract(g.content, '$.tokens_claude_out')                     AS draft_tokens_claude_out,
    -- ── Phase 2 negotiation mediators ────────────────────────────────────────
    json_extract(c.content, '$.rounds_completed')                      AS rounds_completed,
    json_extract(c.content, '$.converged_naturally')                   AS converged_naturally,
    json_extract(c.content, '$.reason')                                AS convergence_reason,
    json_extract(c.content, '$.blocking_minted')                       AS blocking_minted_phase2,
    json_extract(c.content, '$.important_minted')                      AS important_minted,
    json_extract(c.content, '$.minor_minted')                          AS minor_minted,
    json_extract(c.content, '$.tokens_gpt_in')                         AS critique_tokens_gpt_in,
    json_extract(c.content, '$.tokens_gpt_out')                        AS critique_tokens_gpt_out,
    json_extract(c.content, '$.tokens_claude_in')                      AS critique_tokens_claude_in,
    json_extract(c.content, '$.tokens_claude_out')                     AS critique_tokens_claude_out,
    -- ── Phase 3 outcome ──────────────────────────────────────────────────────
    json_extract(s.content, '$.blocking_active_going_in')              AS blocking_active_going_in,
    json_extract(s.content, '$.blocking_resolved_count')               AS blocking_resolved_count,
    json_extract(s.content, '$.blocking_unresolved_count')             AS blocking_unresolved_count,
    json_extract(s.content, '$.blocking_minted_total')                 AS blocking_minted_total,
    json_extract(s.content, '$.blocking_survival_rate')                AS blocking_survival_rate,
    json_extract(s.content, '$.blocking_registered')                   AS blocking_registered,
    json_extract(s.content, '$.blocking_collapsed_dedup')              AS blocking_collapsed_dedup,
    json_extract(s.content, '$.blocking_pre_accepted')                 AS blocking_pre_accepted,
    json_extract(s.content, '$.blocking_pre_rejected')                 AS blocking_pre_rejected,
    json_extract(s.content, '$.blocking_pre_deferred')                 AS blocking_pre_deferred,
    json_extract(s.content, '$.blocking_downgraded')                   AS blocking_downgraded,
    json_extract(s.content, '$.convergence_violations')                AS convergence_violations,
    json_extract(s.content, '$.deferred_count')                        AS deferred_count,
    json_extract(s.content, '$.synthesis_steps')                       AS synthesis_steps,
    json_extract(s.content, '$.tokens_gpt_in')                         AS synthesis_tokens_gpt_in,
    json_extract(s.content, '$.tokens_gpt_out')                        AS synthesis_tokens_gpt_out,
    json_extract(s.content, '$.tokens_claude_in')                      AS synthesis_tokens_claude_in,
    json_extract(s.content, '$.tokens_claude_out')                     AS synthesis_tokens_claude_out,
    -- ── Derived: recall ──────────────────────────────────────────────────────
    CASE
      WHEN json_extract(s.content, '$.blocking_active_going_in') > 0
      THEN ROUND(
        json_extract(s.content, '$.blocking_resolved_count') * 1.0
        / json_extract(s.content, '$.blocking_active_going_in'), 3)
      ELSE NULL
    END                                                                AS recall,
    CASE
      WHEN json_extract(s.content, '$.blocking_minted_total') > 0
      THEN ROUND(
        json_extract(s.content, '$.blocking_active_going_in') * 1.0
        / json_extract(s.content, '$.blocking_minted_total'), 3)
      ELSE NULL
    END                                                                AS computed_survival_rate,
    -- ── Derived: total tokens (cross-phase sums) ─────────────────────────────
    COALESCE(json_extract(g.content, '$.tokens_gpt_in'),    0)
    + COALESCE(json_extract(g.content, '$.tokens_gpt_out'),  0)
    + COALESCE(json_extract(c.content, '$.tokens_gpt_in'),   0)
    + COALESCE(json_extract(c.content, '$.tokens_gpt_out'),  0)
    + COALESCE(json_extract(s.content, '$.tokens_gpt_in'),   0)
    + COALESCE(json_extract(s.content, '$.tokens_gpt_out'),  0)                AS total_gpt_tokens,
    COALESCE(json_extract(g.content, '$.tokens_claude_in'),  0)
    + COALESCE(json_extract(g.content, '$.tokens_claude_out'),0)
    + COALESCE(json_extract(c.content, '$.tokens_claude_in'), 0)
    + COALESCE(json_extract(c.content, '$.tokens_claude_out'),0)
    + COALESCE(json_extract(s.content, '$.tokens_claude_in'), 0)
    + COALESCE(json_extract(s.content, '$.tokens_claude_out'),0)               AS total_claude_tokens
  FROM proposals p
  JOIN sessions ses ON ses.id = p.session_id
  JOIN messages g ON g.proposal_id = p.id AND g.phase = 'context_request' AND g.role = 'host'
  JOIN messages c ON c.proposal_id = p.id AND c.phase = 'critique'        AND c.role = 'host'
  JOIN messages s ON s.proposal_id = p.id AND s.phase = 'synthesis'       AND s.role = 'host'
  WHERE p.status = 'complete'
  -- To filter by arm:        AND ses.arm = 'full'
  -- To filter by task class: AND ses.task_class = 'bugfix'
  -- To lock dataset:         AND p.created_at >= '2026-01-01' AND p.created_at < '2026-02-01'
)
SELECT
  *,
  -- recall_per_1k_tokens: primary Pareto axis — quality / cost
  -- Compare arms: does full Crucible improve recall per dollar, or just add cost?
  CASE
    WHEN recall IS NOT NULL AND (total_gpt_tokens + total_claude_tokens) > 0
    THEN ROUND(
      recall / ((total_gpt_tokens + total_claude_tokens) / 1000.0), 6)
    ELSE NULL
  END                                                                  AS recall_per_1k_tokens
FROM run_data
ORDER BY created_at DESC;


-- ─── Q2: Hypothesis 1 — does divergence predict recall? ──────────────────────
--
-- Bucketed view: low/mid/high divergence vs. mean recall + mean overlap.
-- Look for an inverted-U: moderate divergence should help, extreme may hurt.
-- If it's flat: the divergence signal isn't predictive for this task set.

WITH exp AS (
  SELECT
    CAST(json_extract(g.content, '$.groundingStats.divergence_rate')        AS REAL) AS divergence_rate,
    CAST(json_extract(g.content, '$.groundingStats.overlap_uncapped_count') AS REAL) AS overlap_uncapped,
    CAST(json_extract(s.content, '$.blocking_active_going_in')              AS REAL) AS active_going_in,
    CAST(json_extract(s.content, '$.blocking_resolved_count')               AS REAL) AS resolved
  FROM proposals p
  JOIN messages g ON g.proposal_id = p.id AND g.phase = 'context_request' AND g.role = 'host'
  JOIN messages s ON s.proposal_id = p.id AND s.phase = 'synthesis'        AND s.role = 'host'
  WHERE p.status = 'complete'
    AND json_extract(s.content, '$.blocking_active_going_in') > 0
)
SELECT
  CASE
    WHEN divergence_rate < 0.33 THEN '1_low   (<0.33)'
    WHEN divergence_rate < 0.67 THEN '2_mid   (0.33–0.67)'
    ELSE                             '3_high  (>0.67)'
  END                                           AS divergence_bucket,
  COUNT(*)                                      AS n,
  ROUND(AVG(resolved / active_going_in), 3)     AS mean_recall,
  ROUND(MIN(resolved / active_going_in), 3)     AS min_recall,
  ROUND(MAX(resolved / active_going_in), 3)     AS max_recall,
  ROUND(AVG(divergence_rate), 3)                AS mean_divergence_rate,
  ROUND(AVG(overlap_uncapped), 1)               AS mean_overlap_uncapped
FROM exp
GROUP BY divergence_bucket
ORDER BY divergence_bucket;


-- ─── Q3: Hypothesis 2 — does cap pressure drive round bloat and survival erosion? ──
--
-- Buckets runs by max cap_hit_rate across both models.
-- Expected signals if hypothesis is true:
--   - higher cap bucket → more rounds_completed
--   - higher cap bucket → lower converged_naturally rate
--   - higher cap bucket → lower blocking_survival_rate (more noise minted and pruned)

WITH exp AS (
  SELECT
    MAX(
      COALESCE(CAST(json_extract(g.content, '$.groundingStats.cap_hit_rate_gpt')    AS REAL), 0),
      COALESCE(CAST(json_extract(g.content, '$.groundingStats.cap_hit_rate_claude') AS REAL), 0)
    )                                                                      AS cap_hit_max,
    CAST(json_extract(c.content, '$.rounds_completed')     AS INTEGER)    AS rounds_completed,
    CAST(json_extract(c.content, '$.converged_naturally')  AS INTEGER)    AS converged_naturally,
    CAST(json_extract(c.content, '$.blocking_minted')      AS REAL)       AS blocking_minted,
    CAST(json_extract(s.content, '$.blocking_survival_rate')  AS REAL)    AS survival_rate,
    CAST(json_extract(s.content, '$.blocking_collapsed_dedup') AS REAL)   AS collapsed_dedup
  FROM proposals p
  JOIN messages g ON g.proposal_id = p.id AND g.phase = 'context_request' AND g.role = 'host'
  JOIN messages c ON c.proposal_id = p.id AND c.phase = 'critique'        AND c.role = 'host'
  JOIN messages s ON s.proposal_id = p.id AND s.phase = 'synthesis'       AND s.role = 'host'
  WHERE p.status = 'complete'
)
SELECT
  CASE
    WHEN cap_hit_max = 0 OR cap_hit_max IS NULL THEN '0_none  (0)'
    WHEN cap_hit_max < 0.40                     THEN '1_low   (<0.40)'
    WHEN cap_hit_max < 0.70                     THEN '2_mid   (0.40–0.70)'
    ELSE                                             '3_high  (>0.70)'
  END                                                       AS cap_pressure_bucket,
  COUNT(*)                                                  AS n,
  ROUND(AVG(rounds_completed), 2)                           AS mean_rounds,
  ROUND(100.0 * SUM(converged_naturally) / COUNT(*), 1)     AS pct_converged_naturally,
  ROUND(AVG(blocking_minted), 1)                            AS mean_minted,
  ROUND(AVG(survival_rate), 3)                              AS mean_survival_rate,
  ROUND(AVG(collapsed_dedup), 1)                            AS mean_collapsed_dedup
FROM exp
GROUP BY cap_pressure_bucket
ORDER BY cap_pressure_bucket;


-- ─── Q4: Fate distribution — where do minted blockers end up? ────────────────
--
-- Aggregate lifecycle breakdown across all completed proposals.
-- The last column (mean_partition_residual) is a sanity check:
--   it should be 0.0 if the conservation law holds in all rows.
-- A non-zero residual means a fate category is missing or double-counted.
--
-- Read the columns left-to-right: this is the funnel from mint to resolution.

SELECT
  COUNT(*)                                                              AS n_proposals,
  -- Top of funnel
  ROUND(AVG(CAST(json_extract(s.content, '$.blocking_minted_total')    AS REAL)), 1)  AS mean_minted,
  -- Collapsed before canonical store (duplicate / normalisation collapse)
  ROUND(AVG(CAST(json_extract(s.content, '$.blocking_collapsed_dedup') AS REAL)), 1)  AS mean_collapsed_dedup,
  -- Closed during critique without reaching synthesis
  ROUND(AVG(CAST(json_extract(s.content, '$.blocking_downgraded')      AS REAL)), 1)  AS mean_downgraded,
  ROUND(AVG(CAST(json_extract(s.content, '$.blocking_pre_accepted')    AS REAL)), 1)  AS mean_pre_accepted,
  ROUND(AVG(CAST(json_extract(s.content, '$.blocking_pre_rejected')    AS REAL)), 1)  AS mean_pre_rejected,
  ROUND(AVG(CAST(json_extract(s.content, '$.blocking_pre_deferred')    AS REAL)), 1)  AS mean_pre_deferred,
  -- Reached synthesis
  ROUND(AVG(CAST(json_extract(s.content, '$.blocking_active_going_in') AS REAL)), 1)  AS mean_survived_to_synthesis,
  -- Synthesis disposition
  ROUND(AVG(CAST(json_extract(s.content, '$.blocking_resolved_count')  AS REAL)), 1)  AS mean_resolved_by_synthesis,
  ROUND(AVG(CAST(json_extract(s.content, '$.blocking_unresolved_count')AS REAL)), 1)  AS mean_left_unresolved,
  -- Sanity check: conservation law residual (must be 0.0)
  ROUND(AVG(
    COALESCE(CAST(json_extract(s.content, '$.blocking_minted_total')    AS REAL), 0)
    - COALESCE(CAST(json_extract(s.content, '$.blocking_collapsed_dedup') AS REAL), 0)
    - COALESCE(CAST(json_extract(s.content, '$.blocking_downgraded')      AS REAL), 0)
    - COALESCE(CAST(json_extract(s.content, '$.blocking_pre_accepted')    AS REAL), 0)
    - COALESCE(CAST(json_extract(s.content, '$.blocking_pre_rejected')    AS REAL), 0)
    - COALESCE(CAST(json_extract(s.content, '$.blocking_pre_deferred')    AS REAL), 0)
    - COALESCE(CAST(json_extract(s.content, '$.blocking_active_going_in') AS REAL), 0)
  ), 2)                                                                               AS mean_partition_residual
FROM proposals p
JOIN messages s ON s.proposal_id = p.id AND s.phase = 'synthesis' AND s.role = 'host'
WHERE p.status = 'complete';


-- ─── Q5: Survival rate as a leading indicator for recall ─────────────────────
--
-- One row per proposal — paste directly into a scatter plot (x=survival_rate, y=recall).
-- Also includes rounds_completed and converged_naturally to check for confounding
-- (high survival from short/easy runs might inflate the correlation).
--
-- noise_rate = 1 - survival_rate: fraction of minted items that collapsed or were
-- pruned before reaching synthesis. High noise_rate + high recall means the critique
-- loop is doing good filtering work. Low noise_rate + low recall means items that
-- survived were still not addressed — a synthesis quality problem, not a debate problem.

SELECT
  p.id                                                               AS proposal_id,
  p.title,
  ROUND(CAST(json_extract(s.content, '$.blocking_survival_rate')  AS REAL), 3)  AS survival_rate,
  ROUND(1.0 - COALESCE(
    CAST(json_extract(s.content, '$.blocking_survival_rate') AS REAL), 0), 3)   AS noise_rate,
  CAST(json_extract(s.content, '$.blocking_minted_total')         AS INTEGER)   AS minted_total,
  CAST(json_extract(s.content, '$.blocking_active_going_in')      AS INTEGER)   AS active_going_in,
  CAST(json_extract(s.content, '$.blocking_resolved_count')       AS INTEGER)   AS resolved_count,
  CASE
    WHEN json_extract(s.content, '$.blocking_active_going_in') > 0
    THEN ROUND(
      CAST(json_extract(s.content, '$.blocking_resolved_count')  AS REAL)
      / CAST(json_extract(s.content, '$.blocking_active_going_in') AS REAL), 3)
    ELSE NULL
  END                                                                            AS recall,
  CAST(json_extract(s.content, '$.blocking_collapsed_dedup')  AS INTEGER)       AS collapsed_dedup,
  CAST(json_extract(s.content, '$.blocking_downgraded')       AS INTEGER)       AS downgraded,
  CAST(json_extract(s.content, '$.blocking_pre_accepted')     AS INTEGER)       AS pre_accepted,
  CAST(json_extract(s.content, '$.blocking_pre_rejected')     AS INTEGER)       AS pre_rejected,
  CAST(json_extract(c.content, '$.rounds_completed')          AS INTEGER)       AS rounds_completed,
  CAST(json_extract(c.content, '$.converged_naturally')       AS INTEGER)       AS converged_naturally
FROM proposals p
JOIN messages s ON s.proposal_id = p.id AND s.phase = 'synthesis' AND s.role = 'host'
JOIN messages c ON c.proposal_id = p.id AND c.phase = 'critique'   AND c.role = 'host'
WHERE p.status = 'complete'
  AND json_extract(s.content, '$.blocking_active_going_in') > 0
ORDER BY survival_rate DESC;
