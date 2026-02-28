# Security Model

This document describes Crucible's security design: what it protects against, how
it stores sensitive data, what it logs, and how to report vulnerabilities.

---

## Threat model

Crucible runs on a developer's local machine and calls OpenAI and Anthropic APIs to
drive a multi-round debate → plan → staging → commit workflow.  The surfaces we
actively defend are:

| Surface | Threat | Mitigation |
|---------|--------|------------|
| API key storage | Keys in plaintext shell scripts or config files | OS keychain / restricted file fallback (see below) |
| LLM-provided file paths | Model output steering writes to arbitrary paths | `validateStagingPath` enforces repo-root boundary |
| LLM-provided branch names | Model output injecting shell metacharacters | `validateBranchName` strict allowlist |
| git / gh invocations | Shell injection via user or model-controlled strings | `spawnSync` with explicit args arrays — no shell |
| Log output | Keys leaking in error messages or debug logs | `redactKeys()` applied to all logged strings |

### What we do NOT defend against

- A malicious npm package in `node_modules` (supply-chain attack)
- Physical access to the machine
- An attacker who already has shell access
- The AI models themselves acting adversarially beyond output content

---

## API key storage

Keys are stored in one of three modes, tried in order:

### 1. OS keychain (preferred)

| Platform | Mechanism | Notes |
|----------|-----------|-------|
| macOS | `security add-generic-password` | Keychain Access app, locked with login password |
| Linux | `secret-tool store` (libsecret) | Requires `gnome-keyring` or compatible daemon |

Keys are accessed at runtime by `src/keys.js` via `spawnSync` with explicit args — the
key value is never interpolated into a shell string.

### 2. File fallback

When no keychain tool is available, keys are written to:

```
~/.config/crucible/keys/<service-name>
```

- Directory permissions: `700` (owner read/write/execute only)
- File permissions: `600` (owner read/write only)
- Writes are **atomic**: written to a `.tmp.<pid>` file then `rename()`d into place
- If a file is found with looser permissions at read time, permissions are tightened and
  a warning is printed to stderr

A one-time warning is printed when file fallback is used.  Set
`CRUCIBLE_SILENCE_KEY_WARN=1` to suppress it.

### 3. Session-only mode

Set `CRUCIBLE_SESSION_ONLY=1` to prevent any key from touching disk.  Keys are held in
the Node.js process memory only and lost when the process exits.

### Legacy env vars

`OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are honoured for backwards compatibility with
earlier installs.  These take priority over the keychain/file store so that existing
users do not need to re-run the installer.

---

## Checking key source

```
crucible keys status
```

Reports which storage backend is active for each service (env / keychain / file /
session-only / not-set) **without** printing key values.

---

## What is logged and what is redacted

`src/keys.js` exports `redactKeys(text, keys?)`.  It is called on any string before it
is written to stderr or a log file.  It replaces every occurrence of a loaded key value
(exact match, trimmed variant) with `[REDACTED]`.

Rules:
- Any string 8+ characters long that matches a loaded key is redacted
- Error response bodies from the AI SDKs are passed through `redactKeys` before logging
- Stack traces are redacted before display
- Keys are **never** echoed to stdout or stderr during collection (`read -rsp` in the
  installer, no echo in the CLI)

---

## Path traversal protection

`src/safety.js` exports `validateStagingPath(repoRoot, proposedPath)`.

All file paths that originate from AI model output or user input are validated before
use.  The function:

1. Rejects non-string values
2. Rejects absolute paths (`isAbsolute`)
3. Normalises separators (handles both `/` and `\`)
4. Rejects any path that contains `..` after normalisation
5. Resolves the full path and asserts it starts with `repoRoot + sep`

Violations throw an `Error` with a descriptive message; the calling code surfaces this
to the user and skips the file.

---

## Shell injection prevention

All `git` and `gh` CLI invocations use `spawnSync` with an explicit args array:

```js
// SAFE — args are passed as data, not interpreted by a shell
spawnSync("git", ["-C", repoPath, "commit", "-m", message], { stdio: "inherit" });

// UNSAFE — never done in this codebase
execSync(`git -C "${repoPath}" commit -m "${message}"`);
```

Branch names supplied by the user or the AI model are validated by
`validateBranchName` before being passed to git.  The allowlist permits only
`[A-Za-z0-9._-/]` and additionally rejects leading `-`, `.lock` suffix, `..`,
`@{`, and `HEAD`.

---

## Trust boundary: AI model output

Output from Claude and GPT is treated as **untrusted user input**.  In particular:

- File paths suggested by a model are validated by `validateStagingPath` before any
  filesystem write
- Branch names suggested by a model are validated by `validateBranchName`
- Model output is never passed to `eval`, `Function()`, or a shell
- Model output is redacted before logging in case a prompt-injection attack caused the
  model to echo back a key

---

## Install script

`install.sh` stores keys at install time via `src/keys.js` (keychain or file fallback).
The generated wrapper at `~/.local/bin/crucible` and the MCP config at
`~/.claude/claude.json` contain **no API keys**.  Verify after install:

```sh
grep -i 'sk-\|api.key' ~/.local/bin/crucible && echo "FAIL: key found" || echo "OK"
grep -i 'sk-\|api.key' ~/.claude/claude.json  && echo "FAIL: key found" || echo "OK"
```

---

## Reporting a vulnerability

Open a GitHub issue tagged `security`.  For sensitive reports, use the private
vulnerability reporting feature in the repository's Security tab.  Please include
reproduction steps, the version of Crucible, and your OS.
