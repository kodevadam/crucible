#!/usr/bin/env bash
# run_trial.sh — run each benchmark task under each arm and emit a metrics CSV
#
# Usage:
#   bash analysis/benchmark/run_trial.sh [OPTIONS]
#
# Options:
#   --tasks  PATH    path to tasks.json         (default: same dir as this script)
#   --arms   LIST    space-separated arm labels  (default: "full no-critique")
#   --out    PATH    output CSV path             (default: trial_<timestamp>.csv)
#   --db     PATH    crucible SQLite database    (default: ~/.crucible/crucible.db)
#   --seed   N       shuf seed for reproducible ordering (default: $RANDOM)
#   --dry-run        print planned runs without executing
#   --print-run-plan print shuffled run order + proposal window, then exit
#
# Dependencies: jq, sqlite3, crucible (in PATH)
#
# Each run calls:
#   crucible plan "<prompt>" --arm <arm> --task-class <class> --batch
#
# --batch suppresses Phase 0 clarification and post-synthesis staging prompts.
# The full Phase 1a → 2 → 3 pipeline (grounding, critique, synthesis) still runs.
#
# Output CSV columns:
#   task_id, arm, task_class, recall, recall_per_1k_tokens,
#   total_gpt_tokens, total_claude_tokens, blocking_survival_rate,
#   converged_naturally, rounds_completed, partition_residual, proposal_id

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASKS_JSON="${SCRIPT_DIR}/tasks.json"
DB="${HOME}/.crucible/crucible.db"
ARMS="full no-critique"
OUT="${SCRIPT_DIR}/trial_$(date +%Y%m%d_%H%M%S).csv"
SEED="${RANDOM}"
DRY_RUN=false
PRINT_RUN_PLAN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tasks)          TASKS_JSON="$2"; shift 2 ;;
    --arms)           ARMS="$2";       shift 2 ;;
    --out)            OUT="$2";        shift 2 ;;
    --db)             DB="$2";         shift 2 ;;
    --seed)           SEED="$2";       shift 2 ;;
    --dry-run)        DRY_RUN=true;    shift   ;;
    --print-run-plan) PRINT_RUN_PLAN=true; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# ── Dependency checks ──────────────────────────────────────────────────────────
for cmd in jq sqlite3 crucible; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Required dependency not found: $cmd" >&2; exit 1; }
done
[[ -f "$TASKS_JSON" ]] || { echo "tasks.json not found: $TASKS_JSON" >&2; exit 1; }
[[ -f "$DB"         ]] || { echo "crucible DB not found: $DB (run crucible at least once)" >&2; exit 1; }

# ── Build randomized run list ──────────────────────────────────────────────────
read -ra ARM_LIST <<< "$ARMS"
mapfile -t TASK_IDS < <(jq -r '.tasks[].id' "$TASKS_JSON")

pairs=()
for task_id in "${TASK_IDS[@]}"; do
  for arm in "${ARM_LIST[@]}"; do
    pairs+=("${task_id}:::${arm}")
  done
done

# Shuffle with fixed seed for reproducibility
mapfile -t shuffled < <(printf '%s\n' "${pairs[@]}" | shuf --random-source=<(openssl enc -aes-256-ctr -pass pass:"${SEED}" -nosalt /dev/zero 2>/dev/null))

total="${#shuffled[@]}"

# ── --print-run-plan: show metadata and exit ───────────────────────────────────
if [[ "$PRINT_RUN_PLAN" == "true" ]]; then
  max_id="$(sqlite3 "$DB" 'SELECT COALESCE(MAX(id), 0) FROM proposals' 2>/dev/null || echo '?')"
  win_lo=$((max_id + 1))
  win_hi=$((max_id + total))
  git_rev="$(git -C "${SCRIPT_DIR}" rev-parse HEAD 2>/dev/null || echo 'not-a-git-repo')"
  tasks_hash="$(sha256sum "${TASKS_JSON}" 2>/dev/null | cut -c1-16 || md5 -q "${TASKS_JSON}" 2>/dev/null | cut -c1-16 || echo '?')"
  echo "Run plan"
  echo "  seed        : ${SEED}"
  echo "  git_rev     : ${git_rev}"
  echo "  tasks       : ${TASKS_JSON}"
  echo "  tasks_hash  : ${tasks_hash}  (sha256 prefix — detects task edits since this plan was printed)"
  echo "  arms        : ${ARMS}"
  echo "  total runs  : ${total}"
  echo "  output      : ${OUT}"
  echo "  db          : ${DB}"
  echo "  planned window: ${win_lo}–${win_hi}  (proposals with id > ${max_id})"
  echo ""
  echo "  #   task_id              arm"
  echo "  ─────────────────────────────────────────"
  n=0
  for pair in "${shuffled[@]}"; do
    n=$((n + 1))
    tid="${pair%%:::*}"
    arm="${pair##*:::}"
    tc="$(jq -r --arg id "$tid" '.tasks[] | select(.id == $id) | .class' "$TASKS_JSON")"
    printf "  %-3d %-20s %-16s (%s)\n" "$n" "$tid" "$arm" "$tc"
  done
  echo ""
  echo "  Verify completion after run (copy-paste into sqlite3):"
  echo ""
  echo "    SELECT id, status FROM proposals"
  echo "    WHERE id BETWEEN ${win_lo} AND ${win_hi} ORDER BY id;"
  echo ""
  echo "    SELECT COUNT(*) AS rows, SUM(status='complete') AS complete,"
  echo "           MIN(id) AS observed_lo, MAX(id) AS observed_hi"
  echo "    FROM proposals WHERE id BETWEEN ${win_lo} AND ${win_hi};"
  exit 0
fi

# ── CSV header ─────────────────────────────────────────────────────────────────
echo "task_id,arm,task_class,recall,recall_per_1k_tokens,total_gpt_tokens,total_claude_tokens,blocking_survival_rate,converged_naturally,rounds_completed,partition_residual,proposal_id" \
  > "$OUT"

echo "Trial: ${total} runs  |  arms: ${ARMS}  |  seed: ${SEED}  |  out: ${OUT}" >&2
echo "" >&2

# ── Run loop ───────────────────────────────────────────────────────────────────
# Snapshot proposal id ceiling before any run — used in failure breadcrumbs.
max_id_start="$(sqlite3 "$DB" 'SELECT COALESCE(MAX(id), 0) FROM proposals' 2>/dev/null || echo 0)"
win_lo=$((max_id_start + 1))
win_hi=$((max_id_start + total))

n=0
failed=0
for pair in "${shuffled[@]}"; do
  task_id="${pair%%:::*}"
  arm="${pair##*:::}"
  n=$((n + 1))

  prompt="$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .prompt' "$TASKS_JSON")"
  task_class="$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .class' "$TASKS_JSON")"

  printf "[%d/%d] %-20s  arm=%-14s  class=%s\n" \
    "$n" "$total" "$task_id" "$arm" "$task_class" >&2

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  DRY RUN — would run: crucible plan \"${prompt:0:60}...\" --arm \"$arm\" --task-class \"$task_class\" --batch" >&2
    echo "${task_id},${arm},${task_class},dry-run,dry-run,dry-run,dry-run,dry-run,dry-run,dry-run,dry-run,dry-run" >> "$OUT"
    continue
  fi

  # Snapshot max proposal id before run so we can identify the new row exactly
  max_before="$(sqlite3 "$DB" 'SELECT COALESCE(MAX(id), 0) FROM proposals' 2>/dev/null || echo 0)"

  # Execute — pipe /dev/null to handle any residual readline reads
  crucible plan "$prompt" --arm "$arm" --task-class "$task_class" --batch \
    < /dev/null \
    2>&1 | grep -v "^$" | sed 's/^/  /' >&2 \
    || true   # capture exit; errors are surfaced via partition_residual != 0

  # Query the proposal created by this run
  metrics="$(sqlite3 -separator ',' "$DB" "
WITH new_run AS (
  SELECT p.id
  FROM proposals p
  JOIN sessions ses ON ses.id = p.session_id
  WHERE p.id > ${max_before}
    AND p.status = 'complete'
    AND ses.arm = '${arm}'
  ORDER BY p.created_at DESC
  LIMIT 1
),
rd AS (
  SELECT
    p.id                                                                 AS pid,
    ses.arm,
    ses.task_class,
    CAST(json_extract(s.content, '$.blocking_active_going_in') AS REAL)  AS active,
    CAST(json_extract(s.content, '$.blocking_resolved_count')  AS REAL)  AS resolved,
    json_extract(s.content, '$.blocking_survival_rate')                  AS survival_rate,
    json_extract(c.content, '$.rounds_completed')                        AS rounds,
    json_extract(c.content, '$.converged_naturally')                     AS converged,
    COALESCE(json_extract(g.content, '$.tokens_gpt_in'),    0)
      + COALESCE(json_extract(g.content, '$.tokens_gpt_out'),  0)
      + COALESCE(json_extract(c.content, '$.tokens_gpt_in'),   0)
      + COALESCE(json_extract(c.content, '$.tokens_gpt_out'),  0)
      + COALESCE(json_extract(s.content, '$.tokens_gpt_in'),   0)
      + COALESCE(json_extract(s.content, '$.tokens_gpt_out'),  0)        AS gpt_tok,
    COALESCE(json_extract(g.content, '$.tokens_claude_in'),  0)
      + COALESCE(json_extract(g.content, '$.tokens_claude_out'), 0)
      + COALESCE(json_extract(c.content, '$.tokens_claude_in'),  0)
      + COALESCE(json_extract(c.content, '$.tokens_claude_out'), 0)
      + COALESCE(json_extract(s.content, '$.tokens_claude_in'),  0)
      + COALESCE(json_extract(s.content, '$.tokens_claude_out'), 0)      AS claude_tok,
    COALESCE(json_extract(s.content, '$.blocking_minted_total'),      0)
      - COALESCE(json_extract(s.content, '$.blocking_collapsed_dedup'),0)
      - COALESCE(json_extract(s.content, '$.blocking_downgraded'),     0)
      - COALESCE(json_extract(s.content, '$.blocking_pre_accepted'),   0)
      - COALESCE(json_extract(s.content, '$.blocking_pre_rejected'),   0)
      - COALESCE(json_extract(s.content, '$.blocking_pre_deferred'),   0)
      - COALESCE(json_extract(s.content, '$.blocking_active_going_in'),0) AS residual
  FROM proposals p
  JOIN new_run       ON new_run.id    = p.id
  JOIN sessions ses  ON ses.id        = p.session_id
  JOIN messages g    ON g.proposal_id = p.id AND g.phase = 'context_request' AND g.role = 'host'
  JOIN messages c    ON c.proposal_id = p.id AND c.phase = 'critique'        AND c.role = 'host'
  JOIN messages s    ON s.proposal_id = p.id AND s.phase = 'synthesis'       AND s.role = 'host'
)
SELECT
  '${task_id}',
  arm,
  task_class,
  CASE WHEN active > 0
       THEN ROUND(resolved / active, 3)
       ELSE 'null' END,
  CASE WHEN active > 0 AND (gpt_tok + claude_tok) > 0
       THEN ROUND(resolved / active / ((gpt_tok + claude_tok) / 1000.0), 6)
       ELSE 'null' END,
  gpt_tok,
  claude_tok,
  COALESCE(ROUND(CAST(survival_rate AS REAL), 3), 'null'),
  COALESCE(converged, 'null'),
  COALESCE(rounds, 'null'),
  residual,
  pid
FROM rd;
" 2>/dev/null)"

  if [[ -z "$metrics" ]]; then
    last_pid="$(sqlite3 "$DB" 'SELECT COALESCE(MAX(id), "?") FROM proposals' 2>/dev/null || echo '?')"
    echo "  FAILED: no completed proposal found (run ${n}/${total}, proposal_id=${last_pid}, planned window ${win_lo}–${win_hi})" >&2
    echo "${task_id},${arm},${task_class},no_proposal,no_proposal,0,0,null,null,null,null,null" >> "$OUT"
    failed=$((failed + 1))
  else
    echo "$metrics" >> "$OUT"
    # Surface non-zero residual as a warning (conservation law violation)
    residual="$(echo "$metrics" | cut -d',' -f11)"
    if [[ "$residual" != "0" && "$residual" != "null" ]]; then
      echo "  WARN: partition_residual=${residual} — conservation law violated; check fate counts" >&2
    fi
  fi

  echo "" >&2
done

# ── Summary ────────────────────────────────────────────────────────────────────
observed="$(sqlite3 -separator ' ' "$DB" \
  "SELECT COUNT(*), SUM(status='complete'), COALESCE(MIN(id),'—'), COALESCE(MAX(id),'—')
   FROM proposals WHERE id BETWEEN ${win_lo} AND ${win_hi};" 2>/dev/null || echo "? ? ? ?")"
read -r obs_rows obs_complete obs_lo obs_hi <<< "$observed"

echo "Done: ${total} runs, ${failed} failed  →  ${OUT}" >&2
echo "" >&2
echo "  planned window : ${win_lo}–${win_hi} (${total} rows expected)" >&2
echo "  observed window: ${obs_lo}–${obs_hi} (${obs_rows} rows, ${obs_complete} complete)" >&2
if [[ "$failed" -gt 0 ]]; then
  echo "" >&2
  echo "  Check failed rows (no_proposal) — crucible may have exited before synthesis." >&2
fi
