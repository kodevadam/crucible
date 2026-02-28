/**
 * crucible — keys.js
 *
 * Secure API key storage and retrieval.
 *
 * Priority order for storage:
 *   1. Session-only mode (CRUCIBLE_SESSION_ONLY=1): memory only, never written to disk
 *   2. OS keychain: macOS Keychain (security), Linux libsecret (secret-tool)
 *   3. File fallback: ~/.config/crucible/keys/ (dir 700, files 600, atomic rename)
 *
 * Priority order for retrieval:
 *   cache → env vars → OS keychain → file fallback
 *
 * Redaction:
 *   redactKeys(text) replaces all loaded key values in a string with [REDACTED].
 */

import { execFileSync, spawnSync }                              from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync,
         renameSync, chmodSync, statSync, unlinkSync }          from "fs";
import { join }                                                  from "path";
import os                                                        from "os";

export const SERVICE_OPENAI    = "crucible-openai";
export const SERVICE_ANTHROPIC = "crucible-anthropic";

const KEYS_DIR     = join(os.homedir(), ".config", "crucible", "keys");
const SESSION_ONLY = process.env.CRUCIBLE_SESSION_ONLY === "1";

// In-process key cache (survives for the lifetime of the process)
const _cache = new Map();

// ── Warn once per process on file fallback ────────────────────────────────────

let _warnedFallback = false;
export function _warnFileFallback() {
  if (_warnedFallback || process.env.CRUCIBLE_SILENCE_KEY_WARN === "1") return;
  _warnedFallback = true;
  process.stderr.write(
    "\x1b[33m[crucible] Keys stored in file (~/.config/crucible/keys/)." +
    " Install libsecret (Linux) or use macOS for keychain protection." +
    " Set CRUCIBLE_SILENCE_KEY_WARN=1 to silence.\x1b[0m\n"
  );
}

// ── macOS Keychain ────────────────────────────────────────────────────────────

function macStore(service, key) {
  try {
    execFileSync("security", [
      "add-generic-password", "-s", service, "-a", "crucible", "-w", key, "-U",
    ], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

function macRead(service) {
  try {
    return execFileSync("security", [
      "find-generic-password", "-s", service, "-a", "crucible", "-w",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { return null; }
}

function macDelete(service) {
  try {
    execFileSync("security", [
      "delete-generic-password", "-s", service, "-a", "crucible",
    ], { stdio: "ignore" });
  } catch { /* best-effort */ }
}

// ── Linux libsecret (secret-tool) ────────────────────────────────────────────

function linuxStore(service, key) {
  try {
    const r = spawnSync("secret-tool", [
      "store", `--label=${service}`, "service", service, "account", "crucible",
    ], { input: key, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" });
    return r.status === 0;
  } catch { return false; }
}

function linuxRead(service) {
  try {
    const r = spawnSync("secret-tool", [
      "lookup", "service", service, "account", "crucible",
    ], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    return (r.status === 0 && r.stdout) ? r.stdout.trim() || null : null;
  } catch { return null; }
}

function linuxDelete(service) {
  try {
    spawnSync("secret-tool", [
      "clear", "service", service, "account", "crucible",
    ], { stdio: "ignore" });
  } catch { /* best-effort */ }
}

// ── File fallback ─────────────────────────────────────────────────────────────

function _fileKeyPath(service) {
  return join(KEYS_DIR, service.replace(/[^a-zA-Z0-9_-]/g, "_"));
}

function fileStore(service, key) {
  if (!existsSync(KEYS_DIR)) {
    mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(KEYS_DIR, 0o700); } catch { /* best-effort */ }
  }
  const dest = _fileKeyPath(service);
  const tmp  = `${dest}.tmp.${process.pid}`;
  writeFileSync(tmp, key, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best-effort */ }
  renameSync(tmp, dest);              // atomic on POSIX
  try { chmodSync(dest, 0o600); } catch { /* best-effort */ }
  _warnFileFallback();
}

function fileRead(service) {
  const f = _fileKeyPath(service);
  if (!existsSync(f)) return null;
  try {
    const s = statSync(f);
    if (s.mode & 0o077) {
      process.stderr.write(`\x1b[31m[crucible] Fixing unsafe permissions on ${f}\x1b[0m\n`);
      try { chmodSync(f, 0o600); } catch { /* best-effort */ }
    }
    return readFileSync(f, "utf8").trim() || null;
  } catch { return null; }
}

function fileDelete(service) {
  const f = _fileKeyPath(service);
  if (existsSync(f)) { try { unlinkSync(f); } catch { /* best-effort */ } }
}

// ── Keychain dispatch ─────────────────────────────────────────────────────────

function keychainStore(service, key) {
  if (process.platform === "darwin") return macStore(service, key);
  if (process.platform === "linux")  return linuxStore(service, key);
  return false;
}

function keychainRead(service) {
  if (process.platform === "darwin") return macRead(service);
  if (process.platform === "linux")  return linuxRead(service);
  return null;
}

function keychainDelete(service) {
  if (process.platform === "darwin") macDelete(service);
  else if (process.platform === "linux") linuxDelete(service);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Store a key.
 * In session-only mode, stores only in memory and never touches disk.
 */
export function storeKey(service, key) {
  _cache.set(service, key);
  if (SESSION_ONLY) return;
  if (!keychainStore(service, key)) fileStore(service, key);
}

/**
 * Retrieve a key.
 * Priority: in-process cache → env vars (compatibility) → keychain → file
 * Returns null if not found.
 */
export function retrieveKey(service) {
  if (_cache.has(service)) return _cache.get(service);

  // Honour legacy env vars so existing users don't need to re-install
  if (service === SERVICE_OPENAI    && process.env.OPENAI_API_KEY)
    return process.env.OPENAI_API_KEY;
  if (service === SERVICE_ANTHROPIC && process.env.ANTHROPIC_API_KEY)
    return process.env.ANTHROPIC_API_KEY;

  if (SESSION_ONLY) return null;

  const key = keychainRead(service) ?? fileRead(service) ?? null;
  if (key) _cache.set(service, key);
  return key;
}

/**
 * Delete a key everywhere (cache, keychain, file).
 */
export function deleteKey(service) {
  _cache.delete(service);
  keychainDelete(service);
  fileDelete(service);
}

/**
 * Return all currently-loaded key values (for use in redactKeys).
 * Includes env vars that may be set from legacy installs.
 */
export function getLoadedKeys() {
  const vals = [..._cache.values()];
  if (process.env.OPENAI_API_KEY)    vals.push(process.env.OPENAI_API_KEY);
  if (process.env.ANTHROPIC_API_KEY) vals.push(process.env.ANTHROPIC_API_KEY);
  return [...new Set(vals)].filter(v => v && v.length >= 8);
}

/**
 * Redact all known key values from a string.
 * Handles exact match plus trimmed/quoted variants.
 * Pass explicit keys array, or omit to use getLoadedKeys().
 */
export function redactKeys(text, keys) {
  if (!text || typeof text !== "string") return text;
  const toRedact = keys ?? getLoadedKeys();
  let out = text;
  for (const k of toRedact) {
    if (!k || k.length < 8) continue;
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), "[REDACTED]");
    const trimmed = k.trim();
    if (trimmed !== k) {
      const te = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(te, "g"), "[REDACTED]");
    }
  }
  return out;
}
