/**
 * crucible — staging.js
 *
 * Manages the per-proposal file staging workflow:
 *
 *  1. Claude reads the final plan and infers which files will be created/modified
 *  2. For each file: show current content (if any), generate proposed content
 *  3. User reviews each file — approve, skip, or edit the prompt and regenerate
 *  4. Approved files are written to disk
 *  5. All approved files are staged with `git add` as a batch
 *  6. Commit via the existing approval-gate flow in cli.js
 */

import { existsSync, readFileSync, writeFileSync,
         mkdirSync }                                   from "fs";
import { join, dirname, relative, extname }            from "path";
import * as DB                                         from "./db.js";
import { validateStagingPath, gitq }                   from "./safety.js";
import { getAnthropic }                                from "./providers.js";
import { CLAUDE_FALLBACK }                             from "./models.js";

async function askClaude(messages, maxTokens = 3000, model = process.env.CLAUDE_MODEL || CLAUDE_FALLBACK) {
  const res = await getAnthropic().messages.create({
    model,
    max_tokens: maxTokens,
    messages,
  });
  return res.content[0].text;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function ensureStagedFilesTable() {
  const db = DB.getDB();
  db.exec(`
    CREATE TABLE IF NOT EXISTS staged_files (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id  INTEGER NOT NULL REFERENCES proposals(id),
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      repo_path    TEXT    NOT NULL,
      file_path    TEXT    NOT NULL,   -- relative to repo root
      action       TEXT    NOT NULL DEFAULT 'modify',  -- create | modify | delete
      content      TEXT,               -- proposed file content
      original     TEXT,               -- original file content (if existed)
      status       TEXT    NOT NULL DEFAULT 'pending', -- pending | approved | skipped | written | staged
      note         TEXT                -- optional note about why this file is affected
    );
    CREATE INDEX IF NOT EXISTS idx_staged_proposal ON staged_files(proposal_id);
  `);
}

function saveStagedFile(proposalId, repoPath, filePath, { action, content, original, note }) {
  const db = DB.getDB();
  const existing = db.prepare(
    `SELECT id FROM staged_files WHERE proposal_id=? AND file_path=?`
  ).get(proposalId, filePath);

  if (existing) {
    db.prepare(`
      UPDATE staged_files SET action=?, content=?, original=?, note=?, updated_at=datetime('now')
      WHERE id=?
    `).run(action||"modify", content||null, original||null, note||null, existing.id);
    return existing.id;
  } else {
    return db.prepare(`
      INSERT INTO staged_files (proposal_id, repo_path, file_path, action, content, original, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(proposalId, repoPath, filePath, action||"modify", content||null, original||null, note||null)
      .lastInsertRowid;
  }
}

function updateStagedFileStatus(id, status) {
  DB.getDB().prepare(
    `UPDATE staged_files SET status=?, updated_at=datetime('now') WHERE id=?`
  ).run(status, id);
}

function getStagedFiles(proposalId) {
  return DB.getDB().prepare(
    `SELECT * FROM staged_files WHERE proposal_id=? ORDER BY file_path ASC`
  ).all(proposalId);
}

// ── Step 1: Infer affected files from plan ────────────────────────────────────

export async function inferAffectedFiles(plan, repoPath, repoUnderstanding, claudeModel) {
  const model = claudeModel || process.env.CLAUDE_MODEL || CLAUDE_FALLBACK;
  const contextSection = repoUnderstanding
    ? `\nRepo understanding:\n${repoUnderstanding.slice(0, 3000)}\n`
    : "";

  const prompt = `You are analysing a technical plan to identify exactly which files will need to be created or modified to implement it.

${contextSection}
Plan:
${plan}

Repo root: ${repoPath}

Return ONLY a JSON array. Each element must have:
  - "path": file path relative to repo root (e.g. "src/auth/login.js")
  - "action": "create" | "modify" | "delete"
  - "note": one sentence explaining why this file is affected

Rules:
- Only include files directly required by the plan
- Use the actual file paths that exist or would logically exist in this repo
- Do not include test files unless the plan explicitly mentions them
- Do not include package.json, lock files, or config files unless the plan explicitly changes them
- Max 12 files

Respond with ONLY the JSON array, no markdown fences, no explanation.`;

  const raw = await askClaude([{ role: "user", content: prompt }], 1000, model);

  try {
    // Strip any accidental fences
    const cleaned = raw.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim();
    const files = JSON.parse(cleaned);
    if (!Array.isArray(files)) throw new Error("Not an array");
    // Validate every path before trusting Claude's output
    return files.filter(f => {
      if (!f.path || !f.action) return false;
      try {
        validateStagingPath(repoPath, f.path);
        return true;
      } catch (e) {
        process.stderr.write(`[staging] Rejected path from model: ${e.message}\n`);
        return false;
      }
    });
  } catch {
    return [];
  }
}

// ── Step 2: Generate file content ─────────────────────────────────────────────

export async function generateFileContent(filePath, action, note, plan, repoPath, repoUnderstanding, existingContent, claudeModel) {
  const model = claudeModel || process.env.CLAUDE_MODEL || CLAUDE_FALLBACK;
  const hasExisting = !!existingContent;
  const ext = extname(filePath);

  const contextSection = repoUnderstanding
    ? `\nRepo understanding:\n${repoUnderstanding.slice(0, 2000)}\n`
    : "";

  const existingSection = hasExisting
    ? `\nExisting file content:\n\`\`\`\n${existingContent.slice(0, 3000)}\n\`\`\``
    : "\nThis file does not exist yet — create it from scratch.";

  const prompt = `You are implementing part of a technical plan. Generate the complete content for a single file.

File: ${filePath}
Action: ${action}
Why: ${note}
${contextSection}${existingSection}

Plan (for context):
${plan.slice(0, 4000)}

Rules:
- Return ONLY the raw file content. No markdown fences, no explanation, no preamble.
- If modifying an existing file, preserve everything not touched by the plan.
- Write production-quality code — proper error handling, consistent style with the existing codebase.
- Do not add placeholder comments like "// TODO: implement this".`;

  return askClaude([{ role: "user", content: prompt }], 4000, model);
}

// ── Step 3: Interactive review per file ───────────────────────────────────────

// Passed in from cli.js to avoid circular dependency
let _ask, _confirm, _colours;
export function setInteractiveHelpers(ask, confirm, colours) {
  _ask     = ask;
  _confirm = confirm;
  _colours = colours;
}

function diffPreview(original, proposed) {
  if (!original) return null;
  const origLines = original.split("\n");
  const propLines = proposed.split("\n");
  const added     = propLines.filter(l => l.trim() && !origLines.includes(l));
  const removed   = origLines.filter(l => l.trim() && !propLines.includes(l));
  return { added: added.slice(0, 8), removed: removed.slice(0, 8) };
}

// ── Main export: runStagingFlow ───────────────────────────────────────────────

/**
 * runStagingFlow({ proposalId, repoPath, repoUrl, plan, repoUnderstanding, onStatus })
 *
 * Full interactive staging workflow.
 * Returns { staged: string[], skipped: string[] }
 */
export async function runStagingFlow({
  proposalId,
  repoPath,
  plan,
  repoUnderstanding,
  onStatus,
  claudeModel,
}) {
  const model = claudeModel || process.env.CLAUDE_MODEL || CLAUDE_FALLBACK;
  ensureStagedFilesTable();

  const say    = onStatus || (m => console.log(`  ${m}`));
  const { bold, dim, cyan, green, yellow, red, blue, hr } = _colours;

  // ── Infer files ─────────────────────────────────────────────────────────────

  say("Analysing plan to identify affected files...");
  let affectedFiles = await inferAffectedFiles(plan, repoPath, repoUnderstanding, model);

  if (!affectedFiles.length) {
    say("Claude couldn't identify specific files — you can add them manually.");
  }

  // ── Let user review / add / remove the file list ───────────────────────────

  console.log("");
  console.log(bold(cyan("  Files this plan will touch:")));
  console.log("");

  if (affectedFiles.length) {
    affectedFiles.forEach((f, i) => {
      const exists   = existsSync(join(repoPath, f.path));
      const tag      = f.action === "create" ? green("create") : f.action === "delete" ? red("delete") : yellow("modify");
      const presence = exists ? dim("(exists)") : dim("(new)");
      console.log(`  ${dim(String(i + 1).padStart(2))}  [${tag}]  ${f.path}  ${presence}`);
      console.log(`       ${dim(f.note)}`);
    });
  } else {
    console.log(dim("  (none inferred — add manually below)"));
  }

  console.log("");
  console.log(`  ${cyan("a")}  Add a file manually`);
  console.log(`  ${cyan("r")}  Remove a file from the list`);
  console.log(`  ${cyan("Enter")}  Continue to review & generate`);
  console.log(`  ${cyan("0")}  Skip staging entirely`);
  console.log("");

  while (true) {
    const ans = (await _ask("  ›")).trim().toLowerCase();

    if (ans === "0") return { staged: [], skipped: [] };

    if (ans === "a") {
      const p    = (await _ask("  File path (relative to repo root):\n  ›")).trim();
      const act  = (await _ask("  Action [create/modify/delete] (default: modify):\n  ›")).trim() || "modify";
      const note = (await _ask("  Why is this file affected?\n  ›")).trim();
      if (p) {
        try {
          validateStagingPath(repoPath, p);
          affectedFiles.push({ path: p, action: act, note });
        } catch (e) {
          console.log(_colours.red(`  Path rejected: ${e.message}`));
        }
      }
      continue;
    }

    if (ans === "r") {
      if (!affectedFiles.length) { console.log(dim("  Nothing to remove.")); continue; }
      affectedFiles.forEach((f, i) => console.log(`  ${cyan(String(i + 1))}  ${f.path}`));
      const n = parseInt((await _ask("  Remove which? ›")).trim()) - 1;
      if (n >= 0 && n < affectedFiles.length) {
        console.log(yellow(`  Removed: ${affectedFiles[n].path}`));
        affectedFiles.splice(n, 1);
      }
      continue;
    }

    break;  // Enter or any other key → proceed
  }

  if (!affectedFiles.length) {
    say("No files to stage.");
    return { staged: [], skipped: [] };
  }

  // ── Per-file review loop ───────────────────────────────────────────────────

  const staged  = [];
  const skipped = [];

  for (let i = 0; i < affectedFiles.length; i++) {
    const f         = affectedFiles[i];
    const fullPath  = join(repoPath, f.path);
    const hasFile   = existsSync(fullPath);
    const original  = hasFile ? readFileSync(fullPath, "utf8") : null;

    console.log("");
    console.log(hr("═"));
    console.log(bold(cyan(`\n  File ${i + 1}/${affectedFiles.length}: ${f.path}\n`)));
    console.log(`  ${dim("Action:")} ${f.action}    ${dim("Status:")} ${hasFile ? "exists" : "new file"}`);
    console.log(`  ${dim("Why:")}    ${f.note}`);
    console.log("");

    if (f.action === "delete") {
      if (!hasFile) { say(`File doesn't exist — skipping delete.`); skipped.push(f.path); continue; }
      console.log(red(`  This will DELETE ${f.path}`));
      const confirmed = await _confirm("  Delete this file?");
      if (confirmed) {
        const id = saveStagedFile(proposalId, repoPath, f.path, { action: "delete", original, note: f.note });
        updateStagedFileStatus(id, "approved");
        staged.push({ ...f, id, content: null, original });
      } else {
        skipped.push(f.path);
      }
      continue;
    }

    // Generate content
    say(`Generating content for ${f.path}...`);
    let proposed = await generateFileContent(
      f.path, f.action, f.note, plan, repoPath, repoUnderstanding, original, model
    );

    // Review loop for this file
    let accepted = false;
    while (!accepted) {
      // Show diff or full content
      if (original) {
        const diff = diffPreview(original, proposed);
        if (diff && (diff.added.length || diff.removed.length)) {
          console.log(bold("\n  Changes:"));
          diff.removed.forEach(l => console.log(red(`    − ${l.trim()}`)));
          diff.added.forEach(l => console.log(green(`    + ${l.trim()}`)));
        } else {
          console.log(dim("\n  (No diff detected — file content unchanged or fully replaced)"));
        }
      } else {
        // New file — show first 40 lines
        const preview = proposed.split("\n").slice(0, 40).join("\n");
        console.log(bold("\n  Proposed content (first 40 lines):"));
        console.log("");
        preview.split("\n").forEach(l => console.log(`    ${l}`));
        if (proposed.split("\n").length > 40) console.log(dim(`    ... (${proposed.split("\n").length - 40} more lines)`));
      }

      console.log("");
      console.log(`  ${cyan("y")}  Approve — write this file`);
      console.log(`  ${cyan("f")}  Show full file content`);
      console.log(`  ${cyan("e")}  Edit prompt and regenerate`);
      console.log(`  ${cyan("s")}  Skip this file`);
      console.log(`  ${cyan("0")}  Stop staging entirely`);
      console.log("");

      const ans = (await _ask("  ›")).trim().toLowerCase();

      if (ans === "y") {
        const id = saveStagedFile(proposalId, repoPath, f.path, {
          action: f.action, content: proposed, original, note: f.note,
        });
        updateStagedFileStatus(id, "approved");
        staged.push({ ...f, id, content: proposed, original });
        console.log(green(`\n  ✔ Approved: ${f.path}`));
        accepted = true;
      }

      else if (ans === "f") {
        console.log(bold(`\n  Full content of ${f.path}:\n`));
        proposed.split("\n").forEach((l, n) => console.log(`  ${dim(String(n + 1).padStart(4))}  ${l}`));
        console.log("");
      }

      else if (ans === "e") {
        const extra = await _ask("\n  Additional instruction for regeneration:\n  ›");
        say("Regenerating...");
        proposed = await generateFileContent(
          f.path, f.action,
          `${f.note}. Additional instruction: ${extra}`,
          plan, repoPath, repoUnderstanding, original, model
        );
      }

      else if (ans === "s") {
        skipped.push(f.path);
        console.log(yellow(`\n  Skipped: ${f.path}`));
        accepted = true;
      }

      else if (ans === "0") {
        say("Staging stopped early.");
        return { staged: staged.map(s => s.path), skipped };
      }
    }
  }

  // ── Write approved files to disk ───────────────────────────────────────────

  console.log("");
  console.log(hr("═"));

  if (!staged.length) {
    say("No files approved — nothing to write.");
    return { staged: [], skipped };
  }

  console.log(bold(cyan(`\n  Ready to write ${staged.length} file(s):\n`)));
  staged.forEach(f => {
    const tag = f.action === "create" ? green("create") : f.action === "delete" ? red("delete") : yellow("modify");
    console.log(`    [${tag}]  ${f.path}`);
  });
  console.log("");

  const writeConfirmed = await _confirm("  Write these files to disk and stage them?");
  if (!writeConfirmed) {
    say("Write cancelled — approvals saved in DB, come back with `crucible stage`.");
    return { staged: [], skipped };
  }

  const writtenPaths = [];
  for (const f of staged) {
    // Final defence-in-depth path check before any disk or git operation
    let fullPath;
    try {
      fullPath = validateStagingPath(repoPath, f.path);
    } catch (e) {
      say(`Skipping ${f.path}: ${e.message}`);
      continue;
    }

    if (f.action === "delete") {
      // git rm handles both the fs delete and staging
      gitq(repoPath, ["rm", "-f", f.path]);
      updateStagedFileStatus(f.id, "staged");
      console.log(red(`  ✔ Deleted and staged: ${f.path}`));
    } else {
      // Ensure directory exists
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      writeFileSync(fullPath, f.content, "utf8");
      gitq(repoPath, ["add", f.path]);
      updateStagedFileStatus(f.id, "staged");
      console.log(green(`  ✔ Written and staged: ${f.path}`));
    }

    writtenPaths.push(f.path);
    DB.logAction(f.proposalId || null, null, "stage", `Staged ${f.path}`, { file: f.path, action: f.action });
  }

  console.log("");
  say(`${writtenPaths.length} file(s) written and staged. Ready to commit.`);

  return { staged: writtenPaths, skipped };
}

// ── Standalone: show staged files for a proposal ──────────────────────────────

export function listStagedFiles(proposalId) {
  ensureStagedFilesTable();
  return getStagedFiles(proposalId);
}

// ── Re-stage already-approved files (for resume flows) ───────────────────────

export async function restageApproved(proposalId, repoPath, colours) {
  ensureStagedFilesTable();
  const { green, red, yellow, dim } = colours;
  const files = getStagedFiles(proposalId).filter(f => f.status === "approved");

  if (!files.length) {
    console.log(dim("  No approved-but-unwritten files found."));
    return [];
  }

  const written = [];
  for (const f of files) {
    let fullPath;
    try {
      fullPath = validateStagingPath(repoPath, f.file_path);
    } catch (e) {
      console.log(`  Skipping ${f.file_path}: ${e.message}`);
      continue;
    }
    if (f.action === "delete") {
      gitq(repoPath, ["rm", "-f", f.file_path]);
    } else if (f.content) {
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, f.content, "utf8");
      gitq(repoPath, ["add", f.file_path]);
    }
    updateStagedFileStatus(f.id, "staged");
    console.log(green(`  ✔ Re-staged: ${f.file_path}`));
    written.push(f.file_path);
  }
  return written;
}
