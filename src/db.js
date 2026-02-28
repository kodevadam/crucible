/**
 * crucible — db.js
 * SQLite persistence layer.
 * Tables: sessions, proposals, messages, actions, repo_knowledge, repo_changes
 */

import Database from "better-sqlite3";
import { join }  from "path";
import { mkdirSync, existsSync } from "fs";

const DB_DIR  = join(process.env.HOME, ".local", "share", "crucible");
const DB_PATH = join(DB_DIR, "crucible.db");

if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    ended_at        TEXT,
    project         TEXT,
    repo_path       TEXT,
    repo_url        TEXT,
    gpt_model       TEXT,
    claude_model    TEXT,
    provider_gpt    TEXT,
    provider_claude TEXT,
    prompt_hash     TEXT,
    config_snapshot TEXT
  );

  CREATE TABLE IF NOT EXISTS proposals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES sessions(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    title       TEXT    NOT NULL,
    description TEXT,
    status      TEXT    NOT NULL DEFAULT 'active',
    final_plan  TEXT,
    rounds      INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL REFERENCES proposals(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    role        TEXT    NOT NULL,
    phase       TEXT,
    round       INTEGER,
    content     TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS actions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER REFERENCES proposals(id),
    session_id  INTEGER REFERENCES sessions(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    type        TEXT    NOT NULL,
    description TEXT,
    details     TEXT,
    status      TEXT    NOT NULL DEFAULT 'pending',
    executed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS repo_knowledge (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_path        TEXT    NOT NULL UNIQUE,
    repo_url         TEXT,
    first_seen       TEXT    NOT NULL DEFAULT (datetime('now')),
    last_accessed    TEXT    NOT NULL DEFAULT (datetime('now')),
    last_commit_hash TEXT,
    last_commit_date TEXT,
    understanding    TEXT,
    raw_snapshot     TEXT,
    file_count       INTEGER,
    primary_language TEXT,
    stack_summary    TEXT
  );

  CREATE TABLE IF NOT EXISTS repo_changes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_path     TEXT    NOT NULL,
    recorded_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    commit_hash   TEXT    NOT NULL,
    commit_date   TEXT,
    author        TEXT,
    message       TEXT,
    files_changed TEXT,
    diff_summary  TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_changes_unique ON repo_changes(repo_path, commit_hash);
  CREATE INDEX IF NOT EXISTS idx_repo_changes_path ON repo_changes(repo_path);

  CREATE TABLE IF NOT EXISTS chat_turns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES sessions(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    turn_num    INTEGER NOT NULL,
    speaker     TEXT    NOT NULL,
    content     TEXT    NOT NULL,
    model       TEXT,
    provider    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_chat_turns_session ON chat_turns(session_id);
`);

// ── Schema migrations — idempotent ALTER TABLE additions ──────────────────────
// Each migration is attempted individually so a partially-upgraded database
// continues to work. "duplicate column" errors are silently swallowed;
// any other error is re-thrown.
for (const col of [
  "ALTER TABLE sessions ADD COLUMN provider_gpt    TEXT",
  "ALTER TABLE sessions ADD COLUMN provider_claude TEXT",
  "ALTER TABLE sessions ADD COLUMN prompt_hash     TEXT",
  "ALTER TABLE sessions ADD COLUMN config_snapshot TEXT",
]) {
  try { db.exec(col); } catch (e) {
    if (!e.message.includes("duplicate column")) throw e;
  }
}

const stmts = {
  createSession:       db.prepare(`INSERT INTO sessions (project, repo_path, repo_url, gpt_model, claude_model, provider_gpt, provider_claude, prompt_hash, config_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateSession:       db.prepare(`UPDATE sessions SET project=?, repo_path=?, repo_url=?, gpt_model=?, claude_model=?, provider_gpt=?, provider_claude=?, prompt_hash=?, config_snapshot=?, ended_at=datetime('now') WHERE id=?`),
  endSession:          db.prepare(`UPDATE sessions SET ended_at=datetime('now') WHERE id=?`),
  getSession:          db.prepare(`SELECT * FROM sessions WHERE id=?`),
  listSessions:        db.prepare(`SELECT * FROM sessions ORDER BY started_at DESC LIMIT 20`),
  createProposal:      db.prepare(`INSERT INTO proposals (session_id, title, description) VALUES (?, ?, ?)`),
  updateProposal:      db.prepare(`UPDATE proposals SET title=?, description=?, status=?, final_plan=?, rounds=?, updated_at=datetime('now') WHERE id=?`),
  getProposal:         db.prepare(`SELECT * FROM proposals WHERE id=?`),
  listProposals:       db.prepare(`SELECT * FROM proposals WHERE session_id=? ORDER BY created_at DESC`),
  allProposals:        db.prepare(`SELECT p.*, s.project, s.repo_path FROM proposals p JOIN sessions s ON p.session_id=s.id ORDER BY p.created_at DESC LIMIT 30`),
  addMessage:          db.prepare(`INSERT INTO messages (proposal_id, role, phase, round, content) VALUES (?, ?, ?, ?, ?)`),
  getMessages:         db.prepare(`SELECT * FROM messages WHERE proposal_id=? ORDER BY created_at ASC`),
  addAction:           db.prepare(`INSERT INTO actions (proposal_id, session_id, type, description, details, status) VALUES (?, ?, ?, ?, ?, ?)`),
  executeAction:       db.prepare(`UPDATE actions SET status='executed', executed_at=datetime('now') WHERE id=?`),
  skipAction:          db.prepare(`UPDATE actions SET status='skipped' WHERE id=?`),
  listActions:         db.prepare(`SELECT * FROM actions WHERE proposal_id=? ORDER BY created_at DESC`),
  allActions:          db.prepare(`SELECT a.*, p.title as proposal_title, s.project FROM actions a LEFT JOIN proposals p ON a.proposal_id=p.id LEFT JOIN sessions s ON a.session_id=s.id ORDER BY a.created_at DESC LIMIT 50`),
  getRepoKnowledge:    db.prepare(`SELECT * FROM repo_knowledge WHERE repo_path=?`),
  insertRepoKnowledge: db.prepare(`INSERT INTO repo_knowledge (repo_path, repo_url, last_commit_hash, last_commit_date, understanding, raw_snapshot, file_count, primary_language, stack_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateRepoKnowledge: db.prepare(`UPDATE repo_knowledge SET repo_url=?, last_accessed=datetime('now'), last_commit_hash=?, last_commit_date=?, understanding=?, raw_snapshot=?, file_count=?, primary_language=?, stack_summary=? WHERE repo_path=?`),
  touchRepoAccess:     db.prepare(`UPDATE repo_knowledge SET last_accessed=datetime('now') WHERE repo_path=?`),
  insertRepoChange:    db.prepare(`INSERT OR IGNORE INTO repo_changes (repo_path, commit_hash, commit_date, author, message, files_changed, diff_summary) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  getRepoChanges:      db.prepare(`SELECT * FROM repo_changes WHERE repo_path=? ORDER BY commit_date DESC LIMIT ?`),
  countRepoChanges:    db.prepare(`SELECT COUNT(*) as n FROM repo_changes WHERE repo_path=?`),
  hasCommit:           db.prepare(`SELECT id FROM repo_changes WHERE repo_path=? AND commit_hash=?`),
  deleteRepoKnowledge: db.prepare(`DELETE FROM repo_knowledge WHERE repo_path=?`),
  addChatTurn:         db.prepare(`INSERT INTO chat_turns (session_id, turn_num, speaker, content, model, provider) VALUES (?, ?, ?, ?, ?, ?)`),
  getChatTurns:        db.prepare(`SELECT * FROM chat_turns WHERE session_id=? ORDER BY turn_num ASC`),
};

export function createSession({ project, repoPath, repoUrl, gptModel, claudeModel,
                                providerGpt, providerClaude, promptHash, configSnapshot } = {}) {
  return stmts.createSession.run(
    project||null, repoPath||null, repoUrl||null, gptModel||null, claudeModel||null,
    providerGpt||null, providerClaude||null, promptHash||null,
    configSnapshot ? JSON.stringify(configSnapshot) : null
  ).lastInsertRowid;
}
export function updateSession(id, fields) {
  const s = stmts.getSession.get(id);
  stmts.updateSession.run(
    fields.project        ?? s.project,
    fields.repoPath       ?? s.repo_path,
    fields.repoUrl        ?? s.repo_url,
    fields.gptModel       ?? s.gpt_model,
    fields.claudeModel    ?? s.claude_model,
    fields.providerGpt    ?? s.provider_gpt,
    fields.providerClaude ?? s.provider_claude,
    fields.promptHash     ?? s.prompt_hash,
    fields.configSnapshot !== undefined
      ? JSON.stringify(fields.configSnapshot)
      : s.config_snapshot,
    id
  );
}
export function endSession(id)  { stmts.endSession.run(id); }
export function listSessions()  { return stmts.listSessions.all(); }
export function createProposal(sid, title, desc) {
  return stmts.createProposal.run(sid, title, desc||null).lastInsertRowid;
}
export function updateProposal(id, fields) {
  const p = stmts.getProposal.get(id);
  stmts.updateProposal.run(fields.title??p.title, fields.description??p.description, fields.status??p.status, fields.finalPlan??p.final_plan, fields.rounds??p.rounds, id);
}
export function getProposal(id)         { return stmts.getProposal.get(id); }
export function listProposals(sid)      { return stmts.listProposals.all(sid); }
export function allProposals()          { return stmts.allProposals.all(); }
export function logMessage(pid, role, content, { phase, round } = {}) {
  stmts.addMessage.run(pid, role, phase||null, round||null, content);
}
export function getMessages(pid) { return stmts.getMessages.all(pid); }
export function logAction(pid, sid, type, desc, details={}) {
  return stmts.addAction.run(pid||null, sid||null, type, desc||null, JSON.stringify(details), "pending").lastInsertRowid;
}
export function executeAction(id) { stmts.executeAction.run(id); }
export function skipAction(id)    { stmts.skipAction.run(id); }
export function listActions(pid)  { return stmts.listActions.all(pid); }
export function allActions()      { return stmts.allActions.all(); }
export function getRepoKnowledge(repoPath) {
  return stmts.getRepoKnowledge.get(repoPath) || null;
}
export function saveRepoKnowledge(repoPath, fields) {
  const existing = stmts.getRepoKnowledge.get(repoPath);
  if (existing) {
    stmts.updateRepoKnowledge.run(
      fields.repoUrl         ?? existing.repo_url,
      fields.lastCommitHash  ?? existing.last_commit_hash,
      fields.lastCommitDate  ?? existing.last_commit_date,
      fields.understanding   ?? existing.understanding,
      fields.rawSnapshot     ?? existing.raw_snapshot,
      fields.fileCount       ?? existing.file_count,
      fields.primaryLanguage ?? existing.primary_language,
      fields.stackSummary    ?? existing.stack_summary,
      repoPath
    );
  } else {
    stmts.insertRepoKnowledge.run(
      repoPath,
      fields.repoUrl         || null,
      fields.lastCommitHash  || null,
      fields.lastCommitDate  || null,
      fields.understanding   || null,
      fields.rawSnapshot     || null,
      fields.fileCount       || null,
      fields.primaryLanguage || null,
      fields.stackSummary    || null
    );
  }
}
export function touchRepoAccess(repoPath) { stmts.touchRepoAccess.run(repoPath); }
export function logRepoChange(repoPath, { commitHash, commitDate, author, message, filesChanged, diffSummary }) {
  stmts.insertRepoChange.run(repoPath, commitHash, commitDate||null, author||null, message||null,
    filesChanged ? JSON.stringify(filesChanged) : null, diffSummary||null);
}
export function hasCommit(repoPath, commitHash) {
  return !!stmts.hasCommit.get(repoPath, commitHash);
}
export function getRepoChanges(repoPath, limit=50) {
  return stmts.getRepoChanges.all(repoPath, limit);
}
export function countRepoChanges(repoPath) {
  return stmts.countRepoChanges.get(repoPath)?.n || 0;
}
export function deleteRepoKnowledge(repoPath) {
  stmts.deleteRepoKnowledge.run(repoPath);
}
export function getDB() { return db; }
export function logChatTurn(sessionId, { turnNum, speaker, content, model, provider }) {
  stmts.addChatTurn.run(sessionId, turnNum, speaker, content, model||null, provider||null);
}
export function getChatTurns(sessionId) {
  return stmts.getChatTurns.all(sessionId);
}
