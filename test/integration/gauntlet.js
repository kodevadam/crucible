/**
 * test/integration/gauntlet.js — end-to-end conductor gauntlet
 *
 * The "real fix" scenario: the conductor must discover, plan, and apply a
 * multi-file refactor that requires all of:
 *
 *   1. CREATE  src/core/precision.js   — new module with correct Math.round
 *   2. UPDATE  src/formatter.js        — re-point import to ./core/precision.js
 *   3. DELETE  src/numutils.js         — obsolete file removed
 *   4. Run typecheck and test commands  — two different run_command kinds
 *   5. Converge inside turn / tool budgets, stay in worktree, clean diff
 *   6. Approval writes exactly what the diff showed
 *
 * Two modes — automatic selection:
 *
 *   REPLAY mode (no API key needed)
 *     A ReplayClient feeds the conductor a deterministic two-turn transcript:
 *       Turn 1 → read_file("src/formatter.js")  (exercises tool dispatch path)
 *       Turn 2 → submit_ops(REPLAY_OPS)          (correct three-op fix)
 *     Validates the entire pipeline (worktree, apply, diff, write-back,
 *     cleanup) without any network call or token spend.
 *     Runs automatically in CI.
 *
 *   LIVE mode (requires ANTHROPIC_API_KEY or crucible keychain entry)
 *     Uses model="claude-haiku-4-5-20251001".  Same 10 assertions as replay.
 *     Run to verify real model behaviour.
 *
 * Usage:
 *   node test/integration/gauntlet.js               # replay (always works)
 *   ANTHROPIC_API_KEY=sk-ant-... node test/integration/gauntlet.js  # live
 */

import { mkdtempSync, writeFileSync, readFileSync,
         existsSync, rmSync, cpSync }                from "fs";
import { join, dirname }                             from "path";
import { fileURLToPath }                             from "url";
import { tmpdir }                                    from "os";
import { spawnSync }                                 from "child_process";

// ── Colour helpers ─────────────────────────────────────────────────────────────

const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET  = "\x1b[0m";

const bold   = s => `${BOLD}${s}${RESET}`;
const dim    = s => `${DIM}${s}${RESET}`;
const green  = s => `${GREEN}${s}${RESET}`;
const red    = s => `${RED}${s}${RESET}`;
const yellow = s => `${YELLOW}${s}${RESET}`;
const cyan   = s => `\x1b[36m${s}${RESET}`;

// ── Paths ──────────────────────────────────────────────────────────────────────

const __dirname    = dirname(fileURLToPath(import.meta.url));
const CRUCIBLE_SRC = join(__dirname, "..", "..", "src");
const FIXTURE_DIR  = join(__dirname, "..", "fixtures", "gauntlet");

// ── Git helper (no signing, no hooks) ─────────────────────────────────────────

function git(cwd, args) {
  const r = spawnSync(
    "git",
    ["-C", cwd,
     "-c", "core.hooksPath=/dev/null",
     "-c", "commit.gpgsign=false",
     "-c", "tag.gpgsign=false",
     ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false,
      env: { ...process.env } }
  );
  if (r.error) throw r.error;
  return { stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), status: r.status };
}

// ── Fixture repo setup ─────────────────────────────────────────────────────────

function createFixtureRepo() {
  const repoDir = mkdtempSync(join(tmpdir(), "crucible-gauntlet-"));
  git(repoDir, ["init", "--initial-branch=main"]);
  git(repoDir, ["config", "user.email", "gauntlet@crucible"]);
  git(repoDir, ["config", "user.name",  "Crucible Gauntlet"]);
  cpSync(FIXTURE_DIR, repoDir, { recursive: true });
  git(repoDir, ["add", "."]);
  const r = git(repoDir, ["commit", "-m", "initial broken state"]);
  if (r.status !== 0) throw new Error(`Initial commit failed: ${r.stderr}`);
  return repoDir;
}

// ── ReplayClient ───────────────────────────────────────────────────────────────
//
// Implements the same interface the conductor calls on the Anthropic SDK client:
//   client.messages.create({ model, max_tokens, tools, messages })
//
// Returns a fixed two-turn transcript:
//   Turn 1: read_file("src/formatter.js")  — exercises the tool dispatch path
//   Turn 2: submit_ops(<correct three ops>) — terminal action
//
// The correct ops are computed from the known fixture content, so they apply
// cleanly without any anchor-mismatch recovery.

const REPLAY_OPS = [
  {
    op:      "create",
    path:    "src/core/precision.js",
    content: "/**\n * precision.js — correct rounding utility\n *\n * Replaces numutils.js. Uses Math.round (round-half-up) instead of Math.trunc.\n */\n\nexport function roundTo(value, decimals) {\n  const factor = 10 ** decimals;\n  return Math.round(value * factor) / factor;\n}\n",
  },
  {
    op:  "replace",
    path: "src/formatter.js",
    // Exact text from test/fixtures/gauntlet/src/formatter.js
    old: "import { roundTo } from \"./numutils.js\";",
    new: "import { roundTo } from \"./core/precision.js\";",
  },
  {
    op:   "delete_file",
    path: "src/numutils.js",
  },
];

// Two-turn transcript: read_file first (realistic), then submit_ops.
const REPLAY_TURNS = [
  {
    // Turn 1: model reads formatter.js to get the exact import text
    stop_reason: "tool_use",
    content: [
      {
        type:  "tool_use",
        id:    "replay_read_1",
        name:  "read_file",
        input: { path: "src/formatter.js" },
      },
    ],
  },
  {
    // Turn 2: model submits the correct ops
    stop_reason: "tool_use",
    content: [
      {
        type:  "tool_use",
        id:    "replay_submit_2",
        name:  "submit_ops",
        input: { ops: REPLAY_OPS },
      },
    ],
  },
];

class ReplayClient {
  constructor(turns) {
    this.turns = turns;
    this.idx   = 0;
  }

  get messages() {
    const self = this;
    return {
      async create(params) {
        // rewriteFullFile (Phase B2) calls messages.create without tools.
        // If we hit it, the replay ops have an anchor bug — fail loudly.
        if (!params.tools) {
          throw new Error(
            "[ReplayClient] unexpected non-tool call (B2 rewrite path triggered). " +
            "Check that REPLAY_OPS match the fixture content exactly."
          );
        }
        if (self.idx >= self.turns.length) {
          throw new Error(
            `[ReplayClient] call ${self.idx + 1} exceeds the ${self.turns.length}-turn script. ` +
            "The conductor made more model calls than expected."
          );
        }
        return self.turns[self.idx++];
      },
    };
  }
}

// ── Assertion helper ──────────────────────────────────────────────────────────

function assert(condition, message) {
  if (!condition) {
    console.error(red(`  ✗ FAIL: ${message}`));
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(green(`  ✔ ${message}`));
}

// ── Plan ──────────────────────────────────────────────────────────────────────

const PLAN = `\
Refactor the number-formatting utility to fix a rounding bug.

Background
----------
src/numutils.js exports roundTo(value, decimals) but uses Math.trunc (truncation)
instead of Math.round (round-half-up).  The test suite at test/formatter.test.js
asserts:
  - format(1.565, 2) === "1.57"  (gives "1.56" — WRONG, trunc truncates)
  - format(2.7,   0) === "3"     (gives "2"    — WRONG, trunc drops .7)

Required changes (three ops, one iteration)
-------------------------------------------
1. CREATE src/core/precision.js — new module with correct implementation:
     export function roundTo(value, decimals) {
       const factor = 10 ** decimals;
       return Math.round(value * factor) / factor;
     }

2. UPDATE src/formatter.js — change the import from:
     import { roundTo } from "./numutils.js";
   to:
     import { roundTo } from "./core/precision.js";

3. DELETE src/numutils.js — it is now obsolete; no other files import it.

Verification
------------
After applying your ops:
  - run_command(kind="typecheck") to confirm formatter.js syntax is clean
  - run_command(kind="test") to verify all three tests pass
`;

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(bold("\n╔══════════════════════════════════════════════════════════╗"));
  console.log(bold(  "║         crucible — end-to-end gauntlet                  ║"));
  console.log(bold(  "╚══════════════════════════════════════════════════════════╝\n"));

  // ── Mode selection ─────────────────────────────────────────────────────────
  let liveKey = process.env.ANTHROPIC_API_KEY || null;
  if (!liveKey) {
    try {
      const { retrieveKey, SERVICE_ANTHROPIC } = await import(`${CRUCIBLE_SRC}/keys.js`);
      liveKey = retrieveKey(SERVICE_ANTHROPIC) || null;
    } catch { /* keys.js unavailable — use replay */ }
  }

  const mode = liveKey ? "live" : "replay";
  console.log(dim(`  Mode: ${mode === "live" ? "LIVE (real model)" : "REPLAY (deterministic, no API key needed)"}\n`));

  // ── Create fixture repo ────────────────────────────────────────────────────
  let repoDir;
  try {
    repoDir = createFixtureRepo();
    console.log(dim(`  Fixture repo: ${repoDir}\n`));
  } catch (e) {
    console.error(red(`  ✗ Failed to create fixture repo: ${e.message}`));
    process.exit(1);
  }

  // ── Verify fixture is broken (pre-flight) ─────────────────────────────────
  const preRun = spawnSync("node", ["--test", "test/formatter.test.js"],
    { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
  if (preRun.status === 0) {
    console.error(red("  ✗ Fixture tests unexpectedly PASS before the fix — check fixture files."));
    rmSync(repoDir, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(dim("  Pre-flight: fixture fails correctly (2 of 3 tests fail before fix).\n"));

  // ── Load conductor + providers ─────────────────────────────────────────────
  const [{ runConductor }, { _setAnthropicForTest }] = await Promise.all([
    import(`${CRUCIBLE_SRC}/conductor.js`),
    import(`${CRUCIBLE_SRC}/providers.js`),
  ]);

  // ── Inject ReplayClient when no live key ──────────────────────────────────
  if (mode === "replay") {
    _setAnthropicForTest(new ReplayClient(REPLAY_TURNS));
  }

  // ── Event / diff capture ───────────────────────────────────────────────────
  const events       = [];
  let   diffCaptured = "";
  let   loopPassed   = false; // set from diff_ready event, used by ask()

  // ── Run conductor ──────────────────────────────────────────────────────────
  console.log(bold("  Running conductor…\n"));
  let result;
  try {
    result = await runConductor({
      repoPath:      repoDir,
      plan:          PLAN,
      testCmd:       "node --test test/formatter.test.js",
      model:         "claude-haiku-4-5-20251001",
      maxIterations: 3,
      affectedFiles: [
        { path: "src/formatter.js",      action: "modify",
          note: "Change import: ./numutils.js → ./core/precision.js" },
        { path: "src/core/precision.js", action: "create",
          note: "New file — export roundTo using Math.round (correct rounding)" },
        { path: "src/numutils.js",       action: "modify",
          note: "DELETE this file; it is obsolete once precision.js is in place" },
      ],
      // Auto-approve only when loop passed and there are files to write.
      // Return "0" (abort) if the loop bailed — otherwise the conductor loops
      // forever asking for "y" with modifiedPaths === [].
      ask:     async () => loopPassed ? "y" : "0",
      colours: { bold, green, red, yellow, dim, cyan },
      onEvent: ev => {
        events.push(ev);
        if (ev.type === "diff_ready") {
          diffCaptured = ev.diff ?? "";
          loopPassed   = ev.pass;
        }
      },
    });
  } catch (e) {
    console.error(red(`\n  ✗ runConductor threw: ${e.message}`));
    if (e.stack) console.error(dim(e.stack));
    rmSync(repoDir, { recursive: true, force: true });
    process.exit(1);
  } finally {
    // Always reset the singleton so live tests after replay don't see the mock
    if (mode === "replay") _setAnthropicForTest(null);
  }

  // ── 10 assertions ─────────────────────────────────────────────────────────
  console.log(bold("\n  Assertions\n  ─────────────────────────────────────────\n"));

  // 1. Outcome
  assert(result.outcome === "approved",
    `outcome === "approved" (got "${result.outcome}")`);

  // 2. Budget
  assert(result.iterations <= 3,
    `converged in ≤ 3 iterations (used ${result.iterations})`);

  // 3. All three paths returned
  const ap = result.approvedPaths;
  assert(ap.includes("src/formatter.js"),
    `approvedPaths includes src/formatter.js`);
  assert(ap.includes("src/core/precision.js"),
    `approvedPaths includes src/core/precision.js (created)`);
  assert(ap.includes("src/numutils.js"),
    `approvedPaths includes src/numutils.js (deleted)`);

  // 4–5. formatter.js import updated
  const formatterSrc = readFileSync(join(repoDir, "src/formatter.js"), "utf8");
  assert(formatterSrc.includes("./core/precision.js"),
    `formatter.js now imports from ./core/precision.js`);
  assert(!formatterSrc.includes("./numutils.js"),
    `formatter.js no longer imports ./numutils.js`);

  // 6. precision.js exists and uses Math.round
  assert(existsSync(join(repoDir, "src/core/precision.js")),
    `src/core/precision.js was created`);
  const precisionSrc = readFileSync(join(repoDir, "src/core/precision.js"), "utf8");
  assert(precisionSrc.includes("Math.round"),
    `precision.js uses Math.round (not Math.trunc)`);

  // 7. numutils.js is gone
  assert(!existsSync(join(repoDir, "src/numutils.js")),
    `src/numutils.js was deleted`);

  // 8. Diff is real (non-empty, has hunk headers)
  assert(diffCaptured.length > 0,
    `unified diff is non-empty`);
  assert(diffCaptured.includes("@@"),
    `unified diff contains @@ hunk headers`);

  // 9. Tests pass in the approved state
  const postRun = spawnSync("node", ["--test", "test/formatter.test.js"],
    { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
  assert(postRun.status === 0,
    `all tests pass in approved state (exit 0)`);

  // 10. Worktree cleaned up
  const wtList = git(repoDir, ["worktree", "list"]).stdout;
  assert(!wtList.includes(".crucible"),
    `worktree cleaned up (no .crucible entry)`);

  // ── Mode-specific bonus check ──────────────────────────────────────────────
  if (mode === "replay") {
    // Verify the ReplayClient was called the expected number of times
    // (events: ops_generated fires once per iteration, tests_complete once per iteration)
    const opsGenerated    = events.filter(e => e.type === "ops_generated").length;
    const testsCompleted  = events.filter(e => e.type === "tests_complete").length;
    assert(opsGenerated   >= 1, `ops_generated event fired (${opsGenerated} time(s))`);
    assert(testsCompleted >= 1, `tests_complete event fired (${testsCompleted} time(s))`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const modeLabel = mode === "replay" ? " (replay — deterministic)" : " (live model)";
  console.log(bold(`\n${"═".repeat(60)}`));
  console.log(green(bold(`  ✔ GAUNTLET PASSED${modeLabel}`)));
  console.log(dim(`    iterations   : ${result.iterations}`));
  console.log(dim(`    approvedPaths: ${ap.join(", ")}`));
  console.log(dim(`    diff lines   : ${diffCaptured.split("\n").length}`));
  console.log(bold(`${"═".repeat(60)}\n`));

  // ── Cleanup ────────────────────────────────────────────────────────────────
  rmSync(repoDir, { recursive: true, force: true });
  process.exit(0);
}

main().catch(e => {
  console.error(red(`\n  ✗ Unhandled error: ${e.message}`));
  if (e.stack) console.error(dim(e.stack));
  process.exit(1);
});
