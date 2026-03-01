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

ORIG_ARGS=("$@")

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

# ── Shared metadata (used by both --print-run-plan and live run) ───────────────
tasks_sha256_raw="$(sha256sum "${TASKS_JSON}" 2>/dev/null | cut -c1-16 \
  || shasum -a 256 "${TASKS_JSON}" 2>/dev/null | cut -c1-16 \
  || echo '?')"
git_rev="$(git -C "${SCRIPT_DIR}" rev-parse HEAD 2>/dev/null || echo 'nogit')"
max_id_before="$(sqlite3 "$DB" 'SELECT COALESCE(MAX(id), 0) FROM proposals' 2>/dev/null || echo 0)"
win_lo=$((max_id_before + 1))
win_hi=$((max_id_before + total))
RUN_TS="$(date +%Y%m%d_%H%M%S)"
RUN_ID="${RUN_TS}_seed${SEED}_${tasks_sha256_raw:0:8}_${git_rev:0:7}"

# ── --print-run-plan: show metadata and exit ───────────────────────────────────
if [[ "$PRINT_RUN_PLAN" == "true" ]]; then
  echo "Run plan"
  echo "  run_id           : ${RUN_ID}"
  echo "  invocation       : $0${ORIG_ARGS[*]:+ ${ORIG_ARGS[*]}}"
  echo "  seed             : ${SEED}"
  echo "  git_rev          : ${git_rev}"
  echo "  tasks            : ${TASKS_JSON}"
  echo "  tasks_sha256_raw : ${tasks_sha256_raw}  (sha256 of raw bytes on disk — not parsed/canonicalized)"
  echo "  arms             : ${ARMS}"
  echo "  total runs       : ${total}"
  echo "  output           : ${OUT}"
  echo "  db               : ${DB}"
  echo "  planned window   : ${win_lo}–${win_hi}  (proposals with id > ${max_id_before})"
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
  echo "    -- 1. Row-level status"
  echo "    SELECT id, status FROM proposals"
  echo "    WHERE id BETWEEN ${win_lo} AND ${win_hi} ORDER BY id;"
  echo ""
  echo "    -- 2. Aggregate: counts + observed window (planned vs observed)"
  echo "    SELECT COUNT(*) AS rows, SUM(status='complete') AS complete,"
  echo "           MIN(id) AS observed_lo, MAX(id) AS observed_hi"
  echo "    FROM proposals WHERE id BETWEEN ${win_lo} AND ${win_hi};"
  echo ""
  echo "    -- 3. Task/arm breakdown — catches 'completed but wrong task set'"
  echo "    SELECT task_id, arm, COUNT(*) AS n"
  echo "    FROM proposals"
  echo "    WHERE id BETWEEN ${win_lo} AND ${win_hi}"
  echo "    GROUP BY task_id, arm ORDER BY task_id, arm;"
  echo ""
  echo "    -- 4. Full join: proposals ← run_attempts (run_attempt_id is the bridge)"
  echo "    SELECT ra.n, ra.task_id, ra.arm, ra.run_attempt_id,"
  echo "           p.id AS proposal_id, p.status AS proposal_status, ra.status AS attempt_status"
  echo "    FROM run_attempts ra"
  echo "    LEFT JOIN proposals p ON p.run_attempt_id = ra.run_attempt_id"
  echo "    WHERE ra.run_id = '${RUN_ID}' ORDER BY ra.n;"
  echo ""
  echo "    -- 5. Trial registry header"
  echo "    SELECT run_id, started_at, finished_at, total_runs, failed_runs"
  echo "    FROM runs WHERE run_id = '${RUN_ID}';"
  echo ""
  echo "    -- 6. Per-attempt status (started → complete | failed)"
  echo "    SELECT n, task_id, arm, status, proposal_id"
  echo "    FROM run_attempts WHERE run_id = '${RUN_ID}' ORDER BY n;"
  exit 0
fi

# ── CSV header ─────────────────────────────────────────────────────────────────
echo "task_id,arm,task_class,recall,recall_per_1k_tokens,total_gpt_tokens,total_claude_tokens,blocking_survival_rate,converged_naturally,rounds_completed,partition_residual,proposal_id,run_id" \
  > "$OUT"

echo "Trial: ${total} runs  |  arms: ${ARMS}  |  seed: ${SEED}  |  run_id: ${RUN_ID}  |  out: ${OUT}" >&2
echo "  invocation: $0${ORIG_ARGS[*]:+ ${ORIG_ARGS[*]}}" >&2
echo "" >&2

# ── Trial registry ──────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" != "true" ]]; then
  # Escape single quotes for SQL embedding (paths or arms could theoretically
  # contain them; invocation especially might from quoted flag values).
  _invocation="$0${ORIG_ARGS[*]:+ ${ORIG_ARGS[*]}}"
  _inv_sql="${_invocation//\'/\'\'}"
  _arms_sql="${ARMS//\'/\'\'}"
  _tasks_sql="${TASKS_JSON//\'/\'\'}"
  _out_sql="${OUT//\'/\'\'}"

  sqlite3 "$DB" "
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS runs (
  run_id           TEXT PRIMARY KEY,
  started_at       TEXT,
  finished_at      TEXT,
  git_rev          TEXT,
  tasks_sha256_raw TEXT,
  seed             INTEGER,
  arms             TEXT,
  planned_lo       INTEGER,
  planned_hi       INTEGER,
  invocation       TEXT,
  tasks_path       TEXT,
  output_path      TEXT,
  total_runs       INTEGER,
  failed_runs      INTEGER
);
CREATE TABLE IF NOT EXISTS run_attempts (
  run_attempt_id TEXT PRIMARY KEY,   -- '{RUN_ID}_n{NNN}'; append '_a{K}' for retries
  run_id         TEXT NOT NULL REFERENCES runs(run_id),
  n              INTEGER NOT NULL,
  task_id        TEXT,
  arm            TEXT,
  proposal_id    INTEGER,
  status         TEXT,
  UNIQUE (run_id, n)
);
INSERT OR IGNORE INTO runs
  (run_id, started_at, git_rev, tasks_sha256_raw, seed, arms,
   planned_lo, planned_hi, invocation, tasks_path, output_path, total_runs)
VALUES
  ('${RUN_ID}', datetime('now'), '${git_rev}', '${tasks_sha256_raw}', ${SEED},
   '${_arms_sql}', ${win_lo}, ${win_hi}, '${_inv_sql}', '${_tasks_sql}',
   '${_out_sql}', ${total});
" 2>/dev/null || true

  # proposals is managed by crucible; add run_attempt_id as a side-channel column.
  # Fails silently if the column already exists — safe to run repeatedly.
  sqlite3 "$DB" "ALTER TABLE proposals ADD COLUMN run_attempt_id TEXT;" 2>/dev/null || true
fi

# ── Run loop ───────────────────────────────────────────────────────────────────
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
    echo "${task_id},${arm},${task_class},dry-run,dry-run,dry-run,dry-run,dry-run,dry-run,dry-run,dry-run,dry-run,${RUN_ID}" >> "$OUT"
    continue
  fi

  # Snapshot max proposal id before run so we can identify the new row exactly
  max_before="$(sqlite3 "$DB" 'SELECT COALESCE(MAX(id), 0) FROM proposals' 2>/dev/null || echo 0)"

  # Surrogate key: '{RUN_ID}_n{NNN}' — append '_a{K}' if retry logic is ever added
  RUN_ATTEMPT_ID="${RUN_ID}_n$(printf '%03d' "${n}")"

  # Register attempt as 'started'.  FK enforced: run_id must exist in runs.
  # Failure here means the bookkeeping layer is compromised — abort the trial
  # rather than executing runs whose provenance cannot be recorded.
  if ! sqlite3 "$DB" "PRAGMA foreign_keys = ON;
INSERT OR REPLACE INTO run_attempts
  (run_attempt_id, run_id, n, task_id, arm, status)
  VALUES ('${RUN_ATTEMPT_ID}', '${RUN_ID}', ${n}, '${task_id}', '${arm}', 'started');" >&2; then
    echo "ABORT: run_attempts INSERT failed at run ${n}/${total}" >&2
    echo "  run_attempt_id : ${RUN_ATTEMPT_ID}" >&2
    echo "  run_id         : ${RUN_ID}" >&2
    echo "  Likely cause: runs row missing (FK violation) or DB locked." >&2
    exit 1
  fi

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
  pid,
  '${RUN_ID}'
FROM rd;
" 2>/dev/null)"

  if [[ -z "$metrics" ]]; then
    last_pid="$(sqlite3 "$DB" 'SELECT COALESCE(MAX(id), "?") FROM proposals' 2>/dev/null || echo '?')"
    echo "  FAILED: no completed proposal found (run ${n}/${total}, proposal_id=${last_pid}, planned window ${win_lo}–${win_hi})" >&2
    echo "${task_id},${arm},${task_class},no_proposal,no_proposal,0,0,null,null,null,null,null,${RUN_ID}" >> "$OUT"
    sqlite3 "$DB" "UPDATE run_attempts SET status='failed'
      WHERE run_attempt_id='${RUN_ATTEMPT_ID}';" 2>/dev/null || true
    failed=$((failed + 1))
  else
    echo "$metrics" >> "$OUT"
    pid="$(echo "$metrics" | cut -d',' -f12)"
    sqlite3 "$DB" "
      UPDATE run_attempts SET status='complete', proposal_id=${pid}
        WHERE run_attempt_id='${RUN_ATTEMPT_ID}';
      UPDATE proposals SET run_attempt_id='${RUN_ATTEMPT_ID}'
        WHERE id=${pid};" 2>/dev/null || true
    # Surface non-zero residual as a warning (conservation law violation)
    residual="$(echo "$metrics" | cut -d',' -f11)"
    if [[ "$residual" != "0" && "$residual" != "null" ]]; then
      echo "  WARN: partition_residual=${residual} — conservation law violated; check fate counts" >&2
    fi
  fi

  echo "" >&2
done

# ── Summary ────────────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" != "true" ]]; then
  sqlite3 "$DB" "UPDATE runs SET finished_at=datetime('now'), failed_runs=${failed}
    WHERE run_id='${RUN_ID}';" 2>/dev/null || true
fi

observed="$(sqlite3 -separator ' ' "$DB" \
  "SELECT COUNT(*), SUM(status='complete'), COALESCE(MIN(id),'—'), COALESCE(MAX(id),'—')
   FROM proposals WHERE id BETWEEN ${win_lo} AND ${win_hi};" 2>/dev/null || echo "? ? ? ?")"
read -r obs_rows obs_complete obs_lo obs_hi <<< "$observed"

echo "Done: ${total} runs, ${failed} failed  →  ${OUT}" >&2
echo "" >&2
echo "  planned window : ${win_lo}–${win_hi} (${total} rows expected)" >&2
echo "  observed window: ${obs_lo}–${obs_hi} (${obs_rows} rows, ${obs_complete} complete)" >&2
echo "  run_id         : ${RUN_ID}" >&2
if [[ "$failed" -gt 0 ]]; then
  echo "" >&2
  echo "  Check failed rows (no_proposal) — crucible may have exited before synthesis." >&2
fi
