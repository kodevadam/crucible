/**
 * test/integration/gauntlet.js — end-to-end conductor gauntlet
 *
 * Three deterministic scenarios run always (no API key required).
 * A live smoke run is appended when ANTHROPIC_API_KEY / keychain is present.
 *
 *  Scenario 1 — happy path
 *    Two-turn replay: read_file then submit correct ops.
 *    Validates: worktree isolation, apply, diff, write-back, cleanup.
 *
 *  Scenario 2 — stall then bail
 *    Replay returns ops that apply cleanly but leave tests failing.
 *    Iteration 2 sees delta="same" → bail_same.
 *    Validates: multi-iteration loop, evaluate/bail events, "0"-abort path,
 *               no write-back on abort, worktree cleanup on failure path.
 *
 *  Scenario 3 — anchor mismatch → B1 regeneration
 *    First call returns one bad-anchor replace op; applyPatchOpsToWorktree
 *    throws patch_anchor_not_found; tryApplyWithRecovery fires B1, calls
 *    generateMultiFileOps again; second call returns correct ops → tests pass.
 *    Validates: anchor_retry event, B1 regen, recovery ladder, approval.
 *
 * Usage:
 *   node test/integration/gauntlet.js               # replay (always works)
 *   ANTHROPIC_API_KEY=sk-ant-... node test/integration/gauntlet.js  # + live smoke
 */

import { mkdtempSync, readFileSync, existsSync, rmSync, cpSync } from "fs";
import { join, dirname }                                          from "path";
import { fileURLToPath }                                          from "url";
import { tmpdir }                                                 from "os";
import { spawnSync }                                              from "child_process";

// ── Colour helpers ─────────────────────────────────────────────────────────────

const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED   = "\x1b[31m";
const RESET = "\x1b[0m";

const bold   = s => `${BOLD}${s}${RESET}`;
const dim    = s => `${DIM}${s}${RESET}`;
const green  = s => `${GREEN}${s}${RESET}`;
const red    = s => `${RED}${s}${RESET}`;
const yellow = s => `\x1b[33m${s}${RESET}`;
const cyan   = s => `\x1b[36m${s}${RESET}`;

// ── Paths ──────────────────────────────────────────────────────────────────────

const __dirname    = dirname(fileURLToPath(import.meta.url));
const CRUCIBLE_SRC = join(__dirname, "..", "..", "src");
const FIXTURE_DIR  = join(__dirname, "..", "fixtures", "gauntlet");

// ── Git helper ─────────────────────────────────────────────────────────────────

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

// ── Shared plan ────────────────────────────────────────────────────────────────

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
`;

const AFFECTED_FILES = [
  { path: "src/formatter.js",      action: "modify",
    note: "Change import: ./numutils.js → ./core/precision.js" },
  { path: "src/core/precision.js", action: "create",
    note: "New file — export roundTo using Math.round (correct rounding)" },
  { path: "src/numutils.js",       action: "modify",
    note: "DELETE this file; it is obsolete once precision.js is in place" },
];

// ── Ops constants ──────────────────────────────────────────────────────────────

// The three ops that produce a correct, passing state.
const CORRECT_OPS = [
  {
    op:      "create",
    path:    "src/core/precision.js",
    content:
      "/**\n * precision.js — correct rounding utility\n *\n" +
      " * Replaces numutils.js. Uses Math.round (round-half-up) instead of Math.trunc.\n */\n\n" +
      "export function roundTo(value, decimals) {\n" +
      "  const factor = 10 ** decimals;\n" +
      "  return Math.round(value * factor) / factor;\n}\n",
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

// Ops that apply cleanly but leave the bug intact (Math.trunc still used).
const STALL_OPS = [
  {
    op:      "create",
    path:    "src/core/precision.js",
    content:
      "// precision.js — NOTE: still uses Math.trunc (bug not fixed)\n" +
      "export function roundTo(value, decimals) {\n" +
      "  const factor = 10 ** decimals;\n" +
      "  return Math.trunc(value * factor) / factor;\n}\n",
  },
  {
    op:  "replace",
    path: "src/formatter.js",
    old: "import { roundTo } from \"./numutils.js\";",
    new: "import { roundTo } from \"./core/precision.js\";",
  },
  {
    op:   "delete_file",
    path: "src/numutils.js",
  },
];

// Single op with a bad anchor — triggers patch_anchor_not_found on first apply.
// Has no create/delete_file so the worktree is unmodified when B1 fires.
const BAD_ANCHOR_OPS = [
  {
    op:  "replace",
    path: "src/formatter.js",
    // This text does NOT appear in the file — deliberate anchor mismatch.
    old: "import { roundTo } from \"./wrong-file-that-does-not-exist.js\";",
    new: "import { roundTo } from \"./core/precision.js\";",
  },
];

// ── ReplayClient ───────────────────────────────────────────────────────────────
//
// Implements the client interface the conductor calls:
//   client.messages.create({ model, max_tokens, tools, messages })
//
// Returns turns in declaration order.  Throws loudly when:
//   - all turns are exhausted (unexpected extra call)
//   - called without `tools` (unexpected B2 rewrite path)

class ReplayClient {
  constructor(turns) {
    this.turns = turns;
    this.idx   = 0;
  }

  get messages() {
    const self = this;
    return {
      async create(params) {
        if (!params.tools) {
          throw new Error(
            "[ReplayClient] unexpected non-tool call (B2 rewrite path triggered). " +
            "Check that replay ops have correct anchors or that BAD_ANCHOR_OPS has no " +
            "preceding create/delete_file ops that leave the worktree partially modified."
          );
        }
        if (self.idx >= self.turns.length) {
          throw new Error(
            `[ReplayClient] call ${self.idx + 1} exceeds the ${self.turns.length}-turn script.`
          );
        }
        return self.turns[self.idx++];
      },
    };
  }
}

// ── Assertion helper ──────────────────────────────────────────────────────────

let _assertionCount = 0;

function assert(condition, message) {
  _assertionCount++;
  if (!condition) {
    console.error(red(`    ✗ FAIL [${_assertionCount}]: ${message}`));
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(green(`    ✔ [${_assertionCount}] ${message}`));
}

// ── Scenario runner ───────────────────────────────────────────────────────────

async function runScenario(label, {
  replayTurns,
  maxIterations = 3,
  assertFn,
  _setAnthropicForTest,
  runConductor,
}) {
  console.log(bold(`\n  ▶ ${label}\n`));

  const repoDir = createFixtureRepo();
  console.log(dim(`    Fixture repo: ${repoDir}`));

  _setAnthropicForTest(new ReplayClient(replayTurns));

  const events     = [];
  let diffCaptured = "";
  let loopPassed   = false;

  let result;
  try {
    result = await runConductor({
      repoPath:      repoDir,
      plan:          PLAN,
      testCmd:       "node --test test/formatter.test.js",
      model:         "claude-haiku-4-5-20251001",
      maxIterations,
      affectedFiles: AFFECTED_FILES,
      ask:           async () => loopPassed ? "y" : "0",
      colours:       { bold, green, red, yellow, dim, cyan },
      onEvent: ev => {
        events.push(ev);
        if (ev.type === "diff_ready") {
          diffCaptured = ev.diff ?? "";
          loopPassed   = ev.pass;
        }
      },
    });
  } catch (e) {
    _setAnthropicForTest(null);
    rmSync(repoDir, { recursive: true, force: true });
    console.error(red(`\n    ✗ runConductor threw: ${e.message}`));
    if (e.stack) console.error(dim(e.stack));
    throw e;
  }

  _setAnthropicForTest(null);

  try {
    await assertFn({ result, events, diffCaptured, repoDir });
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }

  console.log(bold(green(`\n    ✔ "${label}" passed.\n`)));
}

// ── Scenario 1: happy path ─────────────────────────────────────────────────────

// Turn 1: model reads formatter.js to get exact import text.
// Turn 2: model submits the three correct ops.
const HAPPY_TURNS = [
  {
    stop_reason: "tool_use",
    content: [{
      type: "tool_use", id: "h1_read", name: "read_file",
      input: { path: "src/formatter.js" },
    }],
  },
  {
    stop_reason: "tool_use",
    content: [{
      type: "tool_use", id: "h2_ops", name: "submit_ops",
      input: { ops: CORRECT_OPS },
    }],
  },
];

async function assertHappyPath({ result, events, diffCaptured, repoDir }) {
  console.log(dim("    Assertions:"));

  assert(result.outcome === "approved",
    `outcome === "approved" (got "${result.outcome}")`);
  assert(result.iterations <= 3,
    `converged in ≤ 3 iterations (used ${result.iterations})`);

  const ap = result.approvedPaths;
  assert(ap.includes("src/formatter.js"),      `approvedPaths includes src/formatter.js`);
  assert(ap.includes("src/core/precision.js"), `approvedPaths includes src/core/precision.js`);
  assert(ap.includes("src/numutils.js"),       `approvedPaths includes src/numutils.js`);

  const formatterSrc = readFileSync(join(repoDir, "src/formatter.js"), "utf8");
  assert( formatterSrc.includes("./core/precision.js"), `formatter.js imports ./core/precision.js`);
  assert(!formatterSrc.includes("./numutils.js"),       `formatter.js no longer imports ./numutils.js`);

  assert(existsSync(join(repoDir, "src/core/precision.js")),
    `src/core/precision.js was created`);
  const precSrc = readFileSync(join(repoDir, "src/core/precision.js"), "utf8");
  assert(precSrc.includes("Math.round"), `precision.js uses Math.round (not Math.trunc)`);

  assert(!existsSync(join(repoDir, "src/numutils.js")), `src/numutils.js was deleted`);

  assert(diffCaptured.length > 0,           `unified diff is non-empty`);
  assert(diffCaptured.includes("@@"),       `unified diff contains @@ hunk headers`);

  const postRun = spawnSync(
    "node", ["--test", "test/formatter.test.js"],
    { cwd: repoDir, encoding: "utf8", stdio: "pipe" }
  );
  assert(postRun.status === 0, `all tests pass in approved state`);

  const wtList = git(repoDir, ["worktree", "list"]).stdout;
  assert(!wtList.includes(".crucible"), `worktree cleaned up`);

  const opsGen     = events.filter(e => e.type === "ops_generated").length;
  const testsDone  = events.filter(e => e.type === "tests_complete").length;
  assert(opsGen  >= 1, `ops_generated event fired (${opsGen}×)`);
  assert(testsDone >= 1, `tests_complete event fired (${testsDone}×)`);
}

// ── Scenario 2: stall then bail ───────────────────────────────────────────────

// Iteration 1: submit_ops → STALL_OPS (apply OK, tests still fail)
// Iteration 2: submit_ops → STALL_OPS again (same result, bail_same)
const STALL_TURNS = [
  {
    stop_reason: "tool_use",
    content: [{
      type: "tool_use", id: "st_iter1", name: "submit_ops",
      input: { ops: STALL_OPS },
    }],
  },
  {
    stop_reason: "tool_use",
    content: [{
      type: "tool_use", id: "st_iter2", name: "submit_ops",
      input: { ops: STALL_OPS },
    }],
  },
];

async function assertStallBail({ result, events, diffCaptured, repoDir }) {
  console.log(dim("    Assertions:"));

  // Outcome: ask() returned "0" because loopPassed = false
  assert(result.outcome === "aborted",
    `outcome === "aborted" (got "${result.outcome}")`);
  assert(result.iterations === 2,
    `used exactly 2 iterations (got ${result.iterations})`);

  // evaluate event shows bail_same
  const evalEv = events.find(e => e.type === "evaluate" && e.decision === "bail_same");
  assert(evalEv !== undefined,
    `evaluate event with decision="bail_same" fired`);
  assert(evalEv.delta === "same",
    `delta === "same" (got "${evalEv.delta}")`);

  // bail event
  const bailEv = events.find(e => e.type === "bail");
  assert(bailEv !== undefined, `bail event fired`);
  assert(bailEv.reason === "bail_same",
    `bail reason === "bail_same" (got "${bailEv.reason}")`);

  // Both iterations ran ops generation and tests
  const opsGen    = events.filter(e => e.type === "ops_generated");
  const testsDone = events.filter(e => e.type === "tests_complete");
  assert(opsGen.length === 2,    `ops_generated fired 2× (once per iteration)`);
  assert(testsDone.length === 2, `tests_complete fired 2× (once per iteration)`);
  assert(testsDone.every(e => e.result.exitCode !== 0),
    `both test runs failed (bug not fixed by stall ops)`);

  // Partial diff exists (ops were applied in last iteration) but nothing written back
  assert(diffCaptured.length > 0,     `partial diff is non-empty (stall ops produced changes)`);
  assert(diffCaptured.includes("@@"), `partial diff has @@ hunk headers`);

  // Nothing written back to main tree (aborted)
  assert(existsSync(join(repoDir, "src/numutils.js")),
    `numutils.js still present in main tree (not written back after abort)`);
  assert(!existsSync(join(repoDir, "src/core/precision.js")),
    `precision.js not in main tree (not written back after abort)`);

  // Worktree cleaned up even though loop bailed
  const wtList = git(repoDir, ["worktree", "list"]).stdout;
  assert(!wtList.includes(".crucible"), `worktree cleaned up despite bail`);
}

// ── Scenario 3: anchor mismatch → B1 regeneration ────────────────────────────

// Call 1 (initial generateMultiFileOps, iteration 1):
//   submit_ops with a single bad-anchor replace.
//   applyPatchOpsToWorktree throws patch_anchor_not_found.
//   BAD_ANCHOR_OPS has no create/delete_file, so worktree stays at HEAD.
//
// Call 2 (B1 inside tryApplyWithRecovery, same iteration 1):
//   submit_ops with correct three ops.
//   B1 succeeds; tests pass.
const ANCHOR_TURNS = [
  {
    stop_reason: "tool_use",
    content: [{
      type: "tool_use", id: "an_bad", name: "submit_ops",
      input: { ops: BAD_ANCHOR_OPS },
    }],
  },
  {
    stop_reason: "tool_use",
    content: [{
      type: "tool_use", id: "an_good", name: "submit_ops",
      input: { ops: CORRECT_OPS },
    }],
  },
];

async function assertAnchorRecovery({ result, events, diffCaptured, repoDir }) {
  console.log(dim("    Assertions:"));

  assert(result.outcome === "approved",
    `outcome === "approved" (got "${result.outcome}")`);
  assert(result.iterations === 1,
    `converged in 1 iteration (B1 recovery is within the same iteration)`);

  // anchor_retry event (B1 triggered)
  const retryEv = events.find(e => e.type === "anchor_retry");
  assert(retryEv !== undefined, `anchor_retry event fired (B1 triggered)`);
  assert(retryEv.attempt === 1,
    `B1 retry attempt=1 (got ${retryEv.attempt})`);
  assert(retryEv.path === "src/formatter.js",
    `anchor failure on src/formatter.js (got "${retryEv.path}")`);

  // apply_complete after B1
  const applyEv = events.find(e => e.type === "apply_complete");
  assert(applyEv !== undefined, `apply_complete event fired (B1 ops applied)`);

  // Tests passed on first iteration
  const testsDone = events.filter(e => e.type === "tests_complete");
  assert(testsDone.length === 1, `tests_complete fired once`);
  assert(testsDone[0].result.exitCode === 0,
    `tests passed after B1 recovery (exitCode 0)`);

  // Final state in main tree
  const ap = result.approvedPaths;
  assert(ap.includes("src/formatter.js"),      `approvedPaths includes src/formatter.js`);
  assert(ap.includes("src/core/precision.js"), `approvedPaths includes src/core/precision.js`);
  assert(ap.includes("src/numutils.js"),       `approvedPaths includes src/numutils.js`);

  const formatterSrc = readFileSync(join(repoDir, "src/formatter.js"), "utf8");
  assert( formatterSrc.includes("./core/precision.js"), `formatter.js imports ./core/precision.js`);
  assert(!formatterSrc.includes("./numutils.js"),       `formatter.js no longer imports ./numutils.js`);

  assert(existsSync(join(repoDir, "src/core/precision.js")),
    `src/core/precision.js was created`);
  const precSrc = readFileSync(join(repoDir, "src/core/precision.js"), "utf8");
  assert(precSrc.includes("Math.round"), `precision.js uses Math.round`);

  assert(!existsSync(join(repoDir, "src/numutils.js")), `src/numutils.js was deleted`);

  const postRun = spawnSync(
    "node", ["--test", "test/formatter.test.js"],
    { cwd: repoDir, encoding: "utf8", stdio: "pipe" }
  );
  assert(postRun.status === 0, `all tests pass in approved state`);

  const wtList = git(repoDir, ["worktree", "list"]).stdout;
  assert(!wtList.includes(".crucible"), `worktree cleaned up`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(bold("\n╔══════════════════════════════════════════════════════════╗"));
  console.log(bold(  "║         crucible — end-to-end gauntlet (3 scenarios)    ║"));
  console.log(bold(  "╚══════════════════════════════════════════════════════════╝"));

  // ── Load conductor + providers ─────────────────────────────────────────────
  const [{ runConductor }, { _setAnthropicForTest }] = await Promise.all([
    import(`${CRUCIBLE_SRC}/conductor.js`),
    import(`${CRUCIBLE_SRC}/providers.js`),
  ]);

  const shared = { _setAnthropicForTest, runConductor };

  // ── Pre-flight: confirm fixture is broken ──────────────────────────────────
  {
    const tmp = createFixtureRepo();
    const pre = spawnSync("node", ["--test", "test/formatter.test.js"],
      { cwd: tmp, encoding: "utf8", stdio: "pipe" });
    rmSync(tmp, { recursive: true, force: true });
    if (pre.status === 0) {
      console.error(red("\n  ✗ Fixture tests unexpectedly PASS — check fixture files."));
      process.exit(1);
    }
    console.log(dim("\n  Pre-flight: fixture fails correctly before any fix.\n"));
  }

  const startCount = _assertionCount;

  // ── Scenario 1: happy path ─────────────────────────────────────────────────
  await runScenario("Scenario 1 — happy path (replay)", {
    replayTurns:  HAPPY_TURNS,
    maxIterations: 3,
    assertFn:     assertHappyPath,
    ...shared,
  });

  // ── Scenario 2: stall then bail ────────────────────────────────────────────
  await runScenario("Scenario 2 — stall then bail (replay)", {
    replayTurns:  STALL_TURNS,
    maxIterations: 3,
    assertFn:     assertStallBail,
    ...shared,
  });

  // ── Scenario 3: anchor mismatch → B1 recovery ─────────────────────────────
  await runScenario("Scenario 3 — anchor mismatch → B1 recovery (replay)", {
    replayTurns:  ANCHOR_TURNS,
    maxIterations: 3,
    assertFn:     assertAnchorRecovery,
    ...shared,
  });

  const replayAssertions = _assertionCount - startCount;

  // ── Live smoke (optional) ──────────────────────────────────────────────────
  let liveKey = process.env.ANTHROPIC_API_KEY || null;
  if (!liveKey) {
    try {
      const { retrieveKey, SERVICE_ANTHROPIC } = await import(`${CRUCIBLE_SRC}/keys.js`);
      liveKey = retrieveKey(SERVICE_ANTHROPIC) || null;
    } catch { /* keys.js unavailable */ }
  }

  if (liveKey) {
    console.log(bold("\n  ▶ Scenario 1 — happy path (LIVE model)\n"));
    console.log(dim("    (No ReplayClient — uses real Anthropic API)\n"));

    const liveStartCount = _assertionCount;
    const liveRepoDir = createFixtureRepo();
    const liveEvents  = [];
    let liveDiff      = "";
    let livePassed    = false;

    try {
      const liveResult = await runConductor({
        repoPath:      liveRepoDir,
        plan:          PLAN,
        testCmd:       "node --test test/formatter.test.js",
        model:         "claude-haiku-4-5-20251001",
        maxIterations: 3,
        affectedFiles: AFFECTED_FILES,
        ask:           async () => livePassed ? "y" : "0",
        colours:       { bold, green, red, yellow, dim, cyan },
        onEvent: ev => {
          liveEvents.push(ev);
          if (ev.type === "diff_ready") { liveDiff = ev.diff ?? ""; livePassed = ev.pass; }
        },
      });
      await assertHappyPath({
        result: liveResult, events: liveEvents,
        diffCaptured: liveDiff, repoDir: liveRepoDir,
      });
      console.log(bold(green(`\n    ✔ "Scenario 1 — happy path (LIVE)" passed.\n`)));
    } catch (e) {
      rmSync(liveRepoDir, { recursive: true, force: true });
      console.error(red(`\n    ✗ Live smoke failed: ${e.message}`));
      process.exit(1);
    }
    rmSync(liveRepoDir, { recursive: true, force: true });

    const liveAssertions = _assertionCount - liveStartCount;
    console.log(dim(`    Live assertions: ${liveAssertions}`));
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const liveNote = liveKey ? " + live smoke" : " (replay only — set ANTHROPIC_API_KEY for live smoke)";
  console.log(bold(`\n${"═".repeat(62)}`));
  console.log(green(bold(`  ✔ ALL GAUNTLET SCENARIOS PASSED${liveNote}`)));
  console.log(dim(`    replay assertions : ${replayAssertions}`));
  console.log(dim(`    scenarios         : 3 (happy path · stall-bail · anchor-B1)`));
  console.log(bold(`${"═".repeat(62)}\n`));
}

main().catch(e => {
  console.error(red(`\n  ✗ Unhandled error: ${e.message}`));
  if (e.stack) console.error(dim(e.stack));
  process.exit(1);
});
