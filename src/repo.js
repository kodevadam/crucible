/**
 * crucible — repo.js
 *
 * Persistent per-repo codebase intelligence.
 *
 * First visit:  deep scan → Claude synthesises full understanding → stored in DB
 * Return visit: diff commits since last visit → Claude updates understanding
 *               with delta → each new commit logged to repo_changes
 */

import { execSync }                            from "child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, extname, relative }             from "path";
import Anthropic                               from "@anthropic-ai/sdk";
import * as DB                                 from "./db.js";
import { retrieveKey, SERVICE_ANTHROPIC }      from "./keys.js";

// Lazy Anthropic client
let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) {
    const key = retrieveKey(SERVICE_ANTHROPIC) || "";
    _anthropic = new Anthropic({ apiKey: key });
  }
  return _anthropic;
}

// Token/size budget constants
const MAX_SNAPSHOT_FILES   = 200;   // Max source files included in raw snapshot
const MAX_FILE_BYTES       = 200_000; // Max bytes read per file
const MAX_SNAPSHOT_CHARS   = 6_000; // Max aggregate chars for context injection
const DIVERGENCE_THRESHOLD = 50;    // Warn when >N unprocessed commits

// ── Shell helpers ─────────────────────────────────────────────────────────────

function shq(cmd) {
  try { return execSync(cmd, { encoding: "utf8", stdio: "pipe" }).trim(); }
  catch { return ""; }
}

// ── Language detection ────────────────────────────────────────────────────────

const LANG_MAP = {
  ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".ts": "TypeScript", ".tsx": "TypeScript",
  ".py": "Python", ".rb": "Ruby", ".go": "Go",
  ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
  ".cs": "C#", ".cpp": "C++", ".c": "C",
  ".php": "PHP", ".swift": "Swift", ".ex": "Elixir",
};

function detectLanguage(repoPath) {
  const counts = {};
  function walk(dir, depth = 0) {
    if (depth > 3) return;
    try {
      for (const f of readdirSync(dir)) {
        if (["node_modules", ".git", "dist", "build", "__pycache__", ".next", "vendor"].includes(f)) continue;
        const full = join(dir, f);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) walk(full, depth + 1);
          else {
            const lang = LANG_MAP[extname(f).toLowerCase()];
            if (lang) counts[lang] = (counts[lang] || 0) + 1;
          }
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip unreadable dir */ }
  }
  walk(repoPath);
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || "Unknown";
}

// ── Raw context builder ───────────────────────────────────────────────────────

const IGNORE_DIRS  = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", "vendor", ".cache", "coverage"]);
const SOURCE_EXTS  = new Set([".js", ".mjs", ".ts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".cs", ".php", ".swift", ".ex", ".exs", ".vue", ".svelte"]);
const CONFIG_FILES = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "composer.json", "Gemfile", "requirements.txt", "tsconfig.json", ".env.example"];

function buildFileTree(repoPath, maxDepth = 3) {
  const lines = [];
  function walk(dir, depth, prefix = "") {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir).filter(f => !f.startsWith(".") || f === ".env.example"); }
    catch { return; }
    entries = entries.filter(f => !IGNORE_DIRS.has(f)).sort();
    entries.forEach((f, i) => {
      const full = join(dir, f);
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      let stat;
      try { stat = statSync(full); } catch { return; }
      lines.push(prefix + connector + f + (stat.isDirectory() ? "/" : ""));
      if (stat.isDirectory()) walk(full, depth + 1, prefix + (isLast ? "    " : "│   "));
    });
  }
  lines.push(repoPath.split("/").pop() + "/");
  walk(repoPath, 0);
  return lines.join("\n");
}

function readKeyFiles(repoPath) {
  const parts = [];

  // README
  for (const name of ["README.md", "README.txt", "readme.md"]) {
    const p = join(repoPath, name);
    if (existsSync(p)) {
      parts.push(`=== ${name} ===\n${readFileSync(p, "utf8").slice(0, 4000)}`);
      break;
    }
  }

  // Config files
  for (const name of CONFIG_FILES) {
    const p = join(repoPath, name);
    if (existsSync(p)) {
      parts.push(`=== ${name} ===\n${readFileSync(p, "utf8").slice(0, 2000)}`);
    }
  }

  // Entry points — look for common patterns
  const entryPoints = ["src/index.js", "src/main.js", "src/app.js", "src/index.ts", "src/main.ts",
    "index.js", "main.js", "app.js", "main.py", "app.py", "main.go", "src/main.rs"];
  for (const rel of entryPoints) {
    const p = join(repoPath, rel);
    if (existsSync(p)) {
      parts.push(`=== ${rel} (entry point) ===\n${readFileSync(p, "utf8").slice(0, 3000)}`);
      break;
    }
  }

  // Top-level source files (up to MAX_SNAPSHOT_FILES, up to MAX_FILE_BYTES each)
  let srcCount = 0;
  function scanSrc(dir, depth = 0) {
    if (depth > 2 || srcCount >= MAX_SNAPSHOT_FILES) return;
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const f of entries.sort()) {
      if (srcCount >= MAX_SNAPSHOT_FILES) break;
      if (IGNORE_DIRS.has(f)) continue;
      const full = join(dir, f);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) { scanSrc(full, depth + 1); continue; }
      if (!SOURCE_EXTS.has(extname(f).toLowerCase())) continue;
      // Skip entry points already captured
      const rel = relative(repoPath, full);
      if (entryPoints.includes(rel)) continue;
      try {
        // Cap individual file size
        const maxChars = Math.min(1500, MAX_FILE_BYTES);
        const content = readFileSync(full, "utf8").slice(0, maxChars);
        parts.push(`=== ${rel} ===\n${content}`);
        srcCount++;
      } catch { /* skip */ }
    }
  }
  const srcDir = join(repoPath, "src");
  if (existsSync(srcDir)) scanSrc(srcDir);
  else scanSrc(repoPath);

  return parts.join("\n\n");
}

function buildRawSnapshot(repoPath) {
  const tree    = buildFileTree(repoPath);
  const files   = readKeyFiles(repoPath);
  const gitLog  = shq(`git -C "${repoPath}" log --oneline -20 2>/dev/null`);
  const branches = shq(`git -C "${repoPath}" branch -a --format='%(refname:short)' 2>/dev/null | head -15`);
  const remotes  = shq(`git -C "${repoPath}" remote -v 2>/dev/null | head -4`);

  return [
    `=== FILE TREE ===\n${tree}`,
    files,
    gitLog   ? `=== RECENT COMMITS ===\n${gitLog}`   : "",
    branches ? `=== BRANCHES ===\n${branches}`        : "",
    remotes  ? `=== REMOTES ===\n${remotes}`           : "",
  ].filter(Boolean).join("\n\n");
}

// ── Count files ───────────────────────────────────────────────────────────────

function countSourceFiles(repoPath) {
  const result = shq(`find "${repoPath}" -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/__pycache__/*" 2>/dev/null | wc -l`);
  return parseInt(result) || 0;
}

// ── Claude calls ──────────────────────────────────────────────────────────────

async function askClaude(prompt, maxTokens = 2000) {
  const res = await getAnthropic().messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  return res.content[0].text;
}

async function synthesiseUnderstanding(repoPath, rawSnapshot) {
  // Cap snapshot to avoid huge token bills; MAX_SNAPSHOT_CHARS*2 gives headroom
  // for the prompt itself while staying within model context limits.
  const snapshotForPrompt = rawSnapshot.slice(0, Math.max(12000, MAX_SNAPSHOT_CHARS * 2));

  const prompt = `You are analysing a software repository to build a persistent understanding of it.
Based on the snapshot below, produce a structured understanding covering:

1. **Purpose** — what this project does and who it's for
2. **Architecture** — how it's structured, key modules/layers, patterns used
3. **Tech stack** — languages, frameworks, databases, infrastructure
4. **Entry points** — where execution begins, main flows
5. **Key abstractions** — the most important files, classes, or modules and what they do
6. **Current state** — how complete/mature it seems, any obvious gaps or TODOs
7. **Conventions** — coding style, naming patterns, anything notable about how code is organised

Be specific and technical. Use the actual file names, module names, and terms from the codebase.
Keep it dense and factual — this will be used as context for future planning sessions.

Repository: ${repoPath}

${snapshotForPrompt}`;

  return askClaude(prompt, 2500);
}

async function updateUnderstanding(repoPath, existingUnderstanding, deltaContext) {
  const prompt = `You have an existing understanding of a codebase. New changes have been made since you last analysed it.
Update your understanding to reflect what has changed, been added, or been removed.
Keep everything that is still accurate. Remove or correct anything outdated. Add new details from the changes.
Return the complete updated understanding in the same structured format.

Repository: ${repoPath}

EXISTING UNDERSTANDING:
${existingUnderstanding}

CHANGES SINCE LAST ANALYSIS:
${deltaContext}`;

  return askClaude(prompt, 2500);
}

async function summariseCommitDelta(repoPath, commits) {
  // For each batch of commits, ask Claude for a plain-English summary
  const commitText = commits.map(c => `${c.hash.slice(0,8)} ${c.date} ${c.author}: ${c.message}\n  Files: ${c.files.slice(0,8).join(", ")}`).join("\n");

  const prompt = `Summarise these git commits from the repository at ${repoPath} in 2-3 plain-English sentences describing what changed overall. Be specific about what was added, modified, or removed.\n\n${commitText}`;

  try {
    return await askClaude(prompt, 300);
  } catch {
    return commits.map(c => c.message).join("; ");
  }
}

async function detectStackSummary(rawSnapshot) {
  const prompt = `Given this repository snapshot, produce a short one-line tech stack summary (e.g. "Node/Express + Postgres + React" or "Python/FastAPI + SQLite + Alpine.js"). Be brief — max 60 chars.\n\n${rawSnapshot.slice(0, 3000)}`;
  try {
    const s = await askClaude(prompt, 80);
    return s.trim().replace(/^["']|["']$/g, "");
  } catch {
    return "Unknown stack";
  }
}

// ── Delta detection ───────────────────────────────────────────────────────────

function getNewCommits(repoPath, sinceHash) {
  // Get all commits newer than sinceHash
  const range = sinceHash ? `${sinceHash}..HEAD` : "HEAD~20..HEAD";
  const log   = shq(`git -C "${repoPath}" log ${range} --format="%H|%ai|%an|%s" 2>/dev/null`);
  if (!log) return [];

  return log.split("\n").filter(Boolean).map(line => {
    const [hash, date, author, ...msgParts] = line.split("|");
    const message  = msgParts.join("|");
    const files    = shq(`git -C "${repoPath}" diff-tree --no-commit-id -r --name-only ${hash} 2>/dev/null`).split("\n").filter(Boolean);
    return { hash, date, author, message, files };
  });
}

function getCurrentHead(repoPath) {
  return shq(`git -C "${repoPath}" rev-parse HEAD 2>/dev/null`);
}

function getHeadDate(repoPath) {
  return shq(`git -C "${repoPath}" log -1 --format="%ai" 2>/dev/null`);
}

// ── Main public function ──────────────────────────────────────────────────────

/**
 * analyseRepo(repoPath, repoUrl, { claudeModel, onStatus })
 *
 * - First visit:  full scan + Claude understanding → stored
 * - Return visit: delta commits → Claude updates understanding → changes logged
 *
 * Returns { understanding, stackSummary, isFirstVisit, newCommitCount }
 */
export async function analyseRepo(repoPath, repoUrl, { claudeModel, onStatus } = {}) {
  if (claudeModel) process.env.CLAUDE_MODEL = claudeModel;

  const status = onStatus || (msg => process.stderr.write(`[repo] ${msg}\n`));

  const existing    = DB.getRepoKnowledge(repoPath);
  const currentHead = getCurrentHead(repoPath);
  const headDate    = getHeadDate(repoPath);
  const language    = detectLanguage(repoPath);
  const fileCount   = countSourceFiles(repoPath);

  // ── First visit ─────────────────────────────────────────────────────────────

  if (!existing) {
    status("First visit — building full understanding of this codebase...");

    const rawSnapshot  = buildRawSnapshot(repoPath);
    status("Reading files...");
    const [understanding, stackSummary] = await Promise.all([
      synthesiseUnderstanding(repoPath, rawSnapshot),
      detectStackSummary(rawSnapshot),
    ]);
    status("Understanding built.");

    DB.saveRepoKnowledge(repoPath, {
      repoUrl,
      lastCommitHash:  currentHead,
      lastCommitDate:  headDate,
      understanding,
      rawSnapshot,
      fileCount,
      primaryLanguage: language,
      stackSummary,
    });

    // Log all recent commits as baseline
    const recentCommits = getNewCommits(repoPath, null);
    for (const c of recentCommits) {
      if (!DB.hasCommit(repoPath, c.hash)) {
        DB.logRepoChange(repoPath, {
          commitHash:   c.hash,
          commitDate:   c.date,
          author:       c.author,
          message:      c.message,
          filesChanged: c.files,
          diffSummary:  null,
        });
      }
    }

    return { understanding, stackSummary, isFirstVisit: true, newCommitCount: recentCommits.length };
  }

  // ── Return visit ─────────────────────────────────────────────────────────────

  DB.touchRepoAccess(repoPath);

  // Check if HEAD has moved
  if (existing.last_commit_hash === currentHead) {
    status("No new commits since last visit — using cached understanding.");
    return {
      understanding:  existing.understanding,
      stackSummary:   existing.stack_summary,
      isFirstVisit:   false,
      newCommitCount: 0,
    };
  }

  // Get commits we haven't processed yet
  const newCommits = getNewCommits(repoPath, existing.last_commit_hash).filter(
    c => !DB.hasCommit(repoPath, c.hash)
  );

  // Warn if the repo has diverged significantly from the indexed state
  if (newCommits.length > DIVERGENCE_THRESHOLD) {
    status(
      `⚠️  ${newCommits.length} unprocessed commits since last index ` +
      `(threshold: ${DIVERGENCE_THRESHOLD}). Understanding may be stale. ` +
      `Run: crucible repo refresh`
    );
  }

  if (!newCommits.length) {
    status("No unprocessed commits — using cached understanding.");
    DB.saveRepoKnowledge(repoPath, { lastCommitHash: currentHead, lastCommitDate: headDate });
    return {
      understanding:  existing.understanding,
      stackSummary:   existing.stack_summary,
      isFirstVisit:   false,
      newCommitCount: 0,
    };
  }

  status(`${newCommits.length} new commit(s) since last visit — updating understanding...`);

  // Summarise the delta
  const deltaSummary = await summariseCommitDelta(repoPath, newCommits);

  // Build delta context
  const changedFiles  = [...new Set(newCommits.flatMap(c => c.files))];
  const deltaSnippets = [];
  for (const f of changedFiles.slice(0, 8)) {
    const full = join(repoPath, f);
    if (existsSync(full) && SOURCE_EXTS.has(extname(f).toLowerCase())) {
      try {
        deltaSnippets.push(`=== ${f} (updated) ===\n${readFileSync(full, "utf8").slice(0, 1000)}`);
      } catch { /* skip */ }
    }
  }

  const deltaContext = [
    `Commits: ${newCommits.length}`,
    `Period: ${newCommits[newCommits.length-1]?.date} → ${newCommits[0]?.date}`,
    `Authors: ${[...new Set(newCommits.map(c => c.author))].join(", ")}`,
    `Summary: ${deltaSummary}`,
    `Changed files (${changedFiles.length}): ${changedFiles.slice(0,15).join(", ")}`,
    deltaSnippets.join("\n\n"),
  ].join("\n");

  // Update understanding
  const updatedUnderstanding = await updateUnderstanding(
    repoPath,
    existing.understanding,
    deltaContext
  );

  // Refresh raw snapshot
  const rawSnapshot = buildRawSnapshot(repoPath);
  const stackSummary = existing.stack_summary || await detectStackSummary(rawSnapshot);

  DB.saveRepoKnowledge(repoPath, {
    repoUrl:         repoUrl || existing.repo_url,
    lastCommitHash:  currentHead,
    lastCommitDate:  headDate,
    understanding:   updatedUnderstanding,
    rawSnapshot,
    fileCount,
    primaryLanguage: language,
    stackSummary,
  });

  // Log each new commit individually
  for (const c of newCommits) {
    DB.logRepoChange(repoPath, {
      commitHash:   c.hash,
      commitDate:   c.date,
      author:       c.author,
      message:      c.message,
      filesChanged: c.files,
      diffSummary:  deltaSummary,
    });
  }

  status(`Understanding updated. ${newCommits.length} commit(s) logged.`);

  return {
    understanding:  updatedUnderstanding,
    stackSummary,
    isFirstVisit:   false,
    newCommitCount: newCommits.length,
  };
}

/**
 * getRepoSummary(repoPath)
 * Quick accessor for cached understanding — no API calls.
 */
export function getRepoSummary(repoPath) {
  const k = DB.getRepoKnowledge(repoPath);
  if (!k) return null;
  return {
    understanding:   k.understanding,
    stackSummary:    k.stack_summary,
    primaryLanguage: k.primary_language,
    lastAccessed:    k.last_accessed,
    lastCommitHash:  k.last_commit_hash,
    fileCount:       k.file_count,
    changeCount:     DB.countRepoChanges(repoPath),
  };
}

/**
 * getChangeLog(repoPath, limit)
 * Returns the stored change log for a repo.
 */
export function getChangeLog(repoPath, limit = 50) {
  return DB.getRepoChanges(repoPath, limit).map(r => ({
    ...r,
    filesChanged: r.files_changed ? JSON.parse(r.files_changed) : [],
  }));
}

/**
 * clearRepoKnowledge(repoPath)
 * Delete all cached understanding for a repo, forcing a full re-analysis on
 * the next analyseRepo() call.
 */
export function clearRepoKnowledge(repoPath) {
  DB.deleteRepoKnowledge(repoPath);
}
