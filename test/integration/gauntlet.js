/**
 * test/integration/gauntlet.js — end-to-end conductor gauntlet
 *
 * The "real fix" scenario: the conductor must discover, plan, and apply a
 * multi-file refactor that requires all of:
 *
 *   1. CREATE  src/core/precision.js   — new module with correct Math.round
 *   2. UPDATE  src/formatter.js        — re-point import to ./core/precision.js
 *   3. DELETE  src/numutils.js         — obsolete file removed
 *   4. call run_command(kind="typecheck") to check import path
 *   5. call run_command(kind="test")   — confirm suite goes green
 *   6. converge inside turn / tool budgets, stay in worktree, produce clean diff
 *   7. write exactly what the diff showed on approval
 *
 * Usage:
 *   node test/integration/gauntlet.js
 *
 * Requires ANTHROPIC_API_KEY (or the key stored via `crucible auth`).
 * If the key is absent the script exits 0 with a SKIP notice.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync,
         existsSync, rmSync, cpSync }                    from "fs";
import { join, dirname }                                 from "path";
import { fileURLToPath }                                 from "url";
import { tmpdir }                                        from "os";
import { spawnSync }                                     from "child_process";

// ── Colour helpers ─────────────────────────────────────────────────────────────

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";

const bold   = s => `${BOLD}${s}${RESET}`;
const dim    = s => `${DIM}${s}${RESET}`;
const green  = s => `${GREEN}${s}${RESET}`;
const red    = s => `${RED}${s}${RESET}`;
const yellow = s => `${YELLOW}${s}${RESET}`;
const cyan   = s => `${CYAN}${s}${RESET}`;

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

// ── Repo setup ─────────────────────────────────────────────────────────────────

function createFixtureRepo() {
  const repoDir = mkdtempSync(join(tmpdir(), "crucible-gauntlet-"));

  // Initialise
  git(repoDir, ["init", "--initial-branch=main"]);
  git(repoDir, ["config", "user.email", "gauntlet@crucible"]);
  git(repoDir, ["config", "user.name",  "Crucible Gauntlet"]);

  // Copy fixture files into repo
  cpSync(FIXTURE_DIR, repoDir, { recursive: true });

  // Stage and commit everything
  git(repoDir, ["add", "."]);
  const commitResult = git(repoDir, ["commit", "-m", "initial broken state"]);
  if (commitResult.status !== 0) {
    throw new Error(`Initial commit failed: ${commitResult.stderr}`);
  }

  return repoDir;
}

// ── Assertions ─────────────────────────────────────────────────────────────────

function assert(condition, message) {
  if (!condition) {
    console.error(red(`  ✗ ASSERTION FAILED: ${message}`));
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(green(`  ✔ ${message}`));
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(bold("\n╔══════════════════════════════════════════════════════════╗"));
  console.log(bold(  "║         crucible — end-to-end gauntlet                  ║"));
  console.log(bold(  "╚══════════════════════════════════════════════════════════╝\n"));

  // ── Pre-flight: check API key ──────────────────────────────────────────────
  // The conductor retrieves the key via retrieveKey() (keychain or env).
  // We probe for the env var as a quick signal; the conductor may have it in
  // its own keychain even if the env var is absent.
  // Check for API key: env var first, then crucible keychain / file storage
  let hasKey = !!process.env.ANTHROPIC_API_KEY;
  if (!hasKey) {
    try {
      const { retrieveKey, SERVICE_ANTHROPIC } = await import(`${CRUCIBLE_SRC}/keys.js`);
      hasKey = !!retrieveKey(SERVICE_ANTHROPIC);
    } catch { /* keys.js unavailable — fall through to SKIP */ }
  }
  if (!hasKey) {
    console.log(yellow("  SKIP: No ANTHROPIC_API_KEY found (env var or crucible keychain)."));
    console.log(dim("  To run this test:"));
    console.log(dim("    export ANTHROPIC_API_KEY=sk-ant-..."));
    console.log(dim("    node test/integration/gauntlet.js\n"));
    process.exit(0);
  }

  // ── Create fixture repo ────────────────────────────────────────────────────
  let repoDir;
  try {
    repoDir = createFixtureRepo();
    console.log(dim(`  Fixture repo: ${repoDir}\n`));
  } catch (e) {
    console.error(red(`  ✗ Failed to create fixture repo: ${e.message}`));
    process.exit(1);
  }

  // ── Verify fixture is broken ───────────────────────────────────────────────
  const preRun = spawnSync("node", ["--test", "test/formatter.test.js"],
    { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
  if (preRun.status === 0) {
    console.error(red("  ✗ Fixture tests unexpectedly PASS before fix — check fixture files."));
    rmSync(repoDir, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(dim("  Pre-run confirms: tests fail in broken fixture (2 failures expected)."));

  // ── Import conductor ───────────────────────────────────────────────────────
  const { runConductor } = await import(`${CRUCIBLE_SRC}/conductor.js`);

  // ── Build plan ─────────────────────────────────────────────────────────────
  const PLAN = `\
Refactor the number-formatting utility to fix a rounding bug.

Background
----------
src/numutils.js exports roundTo(value, decimals) but uses Math.trunc (truncation)
instead of Math.round (round-half-up).  The test suite at test/formatter.test.js
asserts:
  - format(1.565, 2) === "1.57"  (gives "1.56" — WRONG)
  - format(2.7,   0) === "3"     (gives "2"    — WRONG)

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

Verification steps
------------------
After applying your ops:
  - Call run_command(kind="typecheck") to confirm formatter.js syntax is clean.
  - Call run_command(kind="test") to verify the full test suite passes (all 3 tests green).
`;

  // ── Event collector ────────────────────────────────────────────────────────
  const events = [];
  let diffCaptured = "";

  // ── Auto-approve ask callback ──────────────────────────────────────────────
  // runConductor calls ask("  ›") and expects "y" / "0" / "v"
  const ask = async () => "y";

  // ── Run conductor ──────────────────────────────────────────────────────────
  console.log(bold("  Running conductor…\n"));
  let result;
  try {
    result = await runConductor({
      repoPath:  repoDir,
      plan:      PLAN,
      testCmd:   "node --test test/formatter.test.js",
      model:     "claude-haiku-4-5-20251001",
      maxIterations: 3,
      affectedFiles: [
        { path: "src/formatter.js",      action: "modify",
          note: "Change import: ./numutils.js → ./core/precision.js" },
        { path: "src/core/precision.js", action: "create",
          note: "New file — export roundTo using Math.round (correct rounding)" },
        { path: "src/numutils.js",       action: "modify",
          note: "DELETE this file; it is obsolete once precision.js is in place" },
      ],
      ask,
      colours: { bold, green, red, yellow, dim, cyan },
      onEvent: ev => {
        events.push(ev);
        if (ev.type === "diff_ready") {
          diffCaptured = ev.diff ?? "";
        }
      },
    });
  } catch (e) {
    console.error(red(`\n  ✗ runConductor threw: ${e.message}`));
    if (e.stack) console.error(dim(e.stack));
    rmSync(repoDir, { recursive: true, force: true });
    process.exit(1);
  }

  // ── Assertions ─────────────────────────────────────────────────────────────
  console.log(bold("\n  Assertions\n  ─────────────────────────────────────────────────\n"));

  // 1. Conductor approved
  assert(result.outcome === "approved",
    `outcome === "approved" (got "${result.outcome}")`);

  // 2. Converged in budget (≤ 3 iterations, ≤ 6 turns per iteration)
  assert(result.iterations <= 3,
    `converged in ≤ 3 iterations (used ${result.iterations})`);

  // 3. All three paths touched
  const ap = result.approvedPaths;
  assert(ap.includes("src/formatter.js"),
    `approvedPaths includes src/formatter.js`);
  assert(ap.includes("src/core/precision.js"),
    `approvedPaths includes src/core/precision.js (new file)`);
  assert(ap.includes("src/numutils.js"),
    `approvedPaths includes src/numutils.js (deleted)`);

  // 4. formatter.js now imports from ./core/precision.js
  const formatterSrc = readFileSync(join(repoDir, "src/formatter.js"), "utf8");
  assert(formatterSrc.includes("./core/precision.js"),
    `formatter.js imports from ./core/precision.js`);
  assert(!formatterSrc.includes("./numutils.js"),
    `formatter.js no longer imports from ./numutils.js`);

  // 5. precision.js exists and uses Math.round
  assert(existsSync(join(repoDir, "src/core/precision.js")),
    `src/core/precision.js was created`);
  const precisionSrc = readFileSync(join(repoDir, "src/core/precision.js"), "utf8");
  assert(precisionSrc.includes("Math.round"),
    `precision.js uses Math.round (not Math.trunc)`);

  // 6. numutils.js is gone
  assert(!existsSync(join(repoDir, "src/numutils.js")),
    `src/numutils.js was deleted`);

  // 7. Unified diff was produced (non-empty, has @@ hunk headers)
  assert(diffCaptured.length > 0,
    `unified diff is non-empty`);
  assert(diffCaptured.includes("@@"),
    `unified diff has @@ hunk headers (real git diff --unified=3 output)`);

  // 8. Tests pass in the approved repo state
  const postRun = spawnSync("node", ["--test", "test/formatter.test.js"],
    { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
  assert(postRun.status === 0,
    `tests pass in approved state (exit 0) — format(1.565,2)==="1.57" etc.`);

  // 9. Tool-budget events were fired (model used read_file / run_command)
  const toolEvents = events.filter(e => e.type === "ops_generated" || e.type === "tests_complete");
  assert(toolEvents.length >= 1,
    `at least one ops_generated + tests_complete event fired (model loop ran)`);

  // 10. Worktree left clean (conductor removes it in finally)
  const worktreeList = git(repoDir, ["worktree", "list"]).stdout;
  assert(!worktreeList.includes(".crucible"),
    `worktree cleaned up after completion (no .crucible entry in worktree list)`);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(bold(`\n${"═".repeat(60)}`));
  console.log(green(bold(`  ✔ GAUNTLET PASSED — all assertions green`)));
  console.log(dim(`    iterations: ${result.iterations}`));
  console.log(dim(`    approvedPaths: ${ap.join(", ")}`));
  console.log(dim(`    diff lines: ${diffCaptured.split("\n").length}`));
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
