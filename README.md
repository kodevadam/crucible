# crucible

AI-powered planning sessions. Claude and GPT debate your proposals, converge on a plan, and help you ship it.

```
crucible
```

---

## What it does

- **Proposal flow** — describe your idea as roughly as you like. Before the debate starts, GPT critiques and stress-tests it, you can respond and clarify, Claude weighs in on the critique, then GPT synthesises a clean refined proposal for your approval. That refined version is what the debate starts from — so by the time the two models are debating implementation they're working from something solid, not your rough first draft.
- **Repo intelligence** — point crucible at any git repo. It reads the codebase deeply, builds a persistent understanding, and updates it automatically on every return visit by diffing new commits.
- **You stay in control** — you can steer the debate between rounds, accept early, or reject and restart with new direction. Nothing is committed or pushed without explicit confirmation.
- **File staging** — after a plan is finalised, Claude infers which files need to be created or modified, generates their content, and lets you review each one before anything touches disk. You can approve, regenerate with extra instructions, view the full file, or skip. Only approved files get written and staged. Nothing is committed until you explicitly confirm.
- **Branch-safe git** — all commits go to feature branches. Protected branches (`main`, `master`, `develop`, `prod`) are blocked. Merging offers squash / merge commit / rebase with a clear explanation of each.
- **GitHub integration** — browse and clone your private repos, open PRs, squash-merge, and manage branches — all from the crucible menu. Uses the `gh` CLI so your GitHub token is stored securely by the GitHub CLI, never by crucible itself.
- **Full history** — every session, proposal, debate message, git action, and repo change is logged to a local SQLite database.

---

## Requirements

| Requirement | Minimum | Notes |
|---|---|---|
| **Node.js** | 18.x | 20.x recommended; installer auto-installs if missing |
| **npm** | 8.x | Bundled with Node 18+ |
| **OpenAI API key** | — | `sk-...` — [platform.openai.com](https://platform.openai.com/api-keys) |
| **Anthropic API key** | — | `sk-ant-...` — [console.anthropic.com](https://console.anthropic.com/) |
| **git** | 2.x | Required for all repo / staging features |
| **gh CLI** *(optional)* | 2.x | Required for GitHub features (PRs, cloning, private repos) |

---

## Install

```bash
git clone https://github.com/YOUR_USERNAME/crucible.git
cd crucible
chmod +x install.sh
./install.sh
```

The installer will:
1. Check for Node 18+ (installs Node 20 automatically if missing on Debian/Ubuntu)
2. Copy source files to `~/.local/share/crucible/`
3. Install npm dependencies
4. **Search existing key storage** before asking — checks OS keychain, `~/.config/crucible/keys/`, and `$OPENAI_API_KEY` / `$ANTHROPIC_API_KEY` env vars
5. Prompt for any keys not already found
6. Store new keys securely (OS keychain when available, secure file fallback otherwise)
7. Create the `crucible` command at `~/.local/bin/crucible`
8. Register crucible as a Claude Code MCP server
9. Offer to set up GitHub CLI authentication
10. Run a connectivity smoke test

**No API keys are stored in the wrapper script or MCP config.** Keys live in your OS keychain or a permission-restricted directory (`~/.config/crucible/keys/`, mode 700/600).

### GitHub integration (optional but recommended)

The installer will offer to set up GitHub after copying files. You can also run it separately:

```bash
chmod +x setup-git.sh
./setup-git.sh
```

This installs the `gh` CLI (if missing), authenticates via browser OAuth, and configures git to use `gh` as a credential helper — enabling `git push` to private repos without password prompts.

### Updating an existing install

Re-running `./install.sh` detects the existing installation and offers:

```
1  Update source files         (keep keys and all data)  [default]
2  Wipe source & reinstall     (keep keys and crucible.db)
3  Factory reset               (erase all data, keys, and history)
4  Abort
```

---

## Usage

```bash
crucible                        # open interactive session (recommended)
crucible plan "task"            # jump straight into a planning session
crucible debate "task"          # raw debate, no clarification phase
crucible git                    # GitHub/git menu
crucible history                # browse past sessions, proposals, actions
crucible stage                  # stage files from a previous completed plan
crucible models                 # show which model versions will be used
crucible keys status            # show API key storage locations (no values shown)
crucible repo refresh           # force-rebuild repo knowledge for current dir
crucible help                   # show help
```

### Full workflow

```
Your rough idea
      ↓
Phase 0 — Refinement
  GPT critiques the raw proposal
  You respond / clarify
  Claude responds to GPT's critique
  GPT synthesises a clean refined proposal
  You approve, edit, or revert to original
      ↓
Phase 1 — Debate
  Claude and GPT debate the refined proposal
  You steer between rounds
      ↓
Phase 2 — Plan
  Both models converge → final plan synthesised
      ↓
Phase 3 — Staging & commit
  Claude infers affected files, generates content
  You review each file
  Write → stage → commit → push → PR → merge
```

### Interactive session — main menu

When you type `crucible`, you get an interactive session. On first run you'll be prompted for your GitHub account if the `gh` CLI is available — this enables private repo access, repo browsing, and automatic PR workflows.

```
  crucible
  AI-powered planning with Claude & GPT

  GPT:    gpt-4o
  Claude: claude-sonnet-4-6

  ─────────────────────────────────────────
  GitHub: yourname · My Project · /path/to/repo
  ─────────────────────────────────────────

  1  New proposal
  2  Git / GitHub
  3  History
  4  Repo — understanding & change log
  5  Stage files from a previous plan
  6  Switch repo
  7  Chat (conversational mode)
  ?  Help
  0  Exit
```

### After a plan is finalised

```
1  Stage & commit the actual files this plan changes
2  Commit just the spec document (planning record only)
3  Both — stage files AND save a spec
0  Nothing — plan is saved in the database
```

### During file staging

For each affected file:
```
y  Approve — write this file
f  Show full file content
e  Edit prompt and regenerate
s  Skip this file
0  Stop staging entirely
```

### Between debate rounds

```
1  Continue            2  Show agreed points
3  Show diff           4  Steer next round
5  Accept early        6  Reject & restart
```

### GitHub repo browser

When authenticated with `gh`, the GitHub repo picker lets you:

```
  GitHub Repos  mine  (42 repos, page 1/3)
  ──────────────────────────────────────────
   1  yourname/my-project ⚿  A private project
   2  yourname/public-lib    An open source library
   ...

  p prev   n next   c collab   s search   o org/user   0 cancel
  ⚿ = private repo
```

- **mine** — repos you own
- **collab** — repos you can push to (team, org, invited collaborator)
- **search** — full GitHub search
- **org/user** — browse another account's public repos

---

## Repo intelligence

On first entry to a repo, crucible:
1. Reads the file tree, README, config files, and key source files
2. Asks Claude to synthesise a structured understanding (purpose, architecture, stack, conventions)
3. Logs the last 20 commits as a baseline change record
4. Stores everything in `~/.local/share/crucible/crucible.db`

On every return visit, crucible:
1. Checks the current HEAD against the stored HEAD
2. Fetches all new commits and their changed files
3. Asks Claude to update the existing understanding with the delta
4. Appends each new commit to the per-repo change log

The stored understanding is injected as context into every planning debate and proposal review for that repo.

View it at any time: **main menu → 4 Repo**

---

## Database

Everything is stored in `~/.local/share/crucible/crucible.db` — a plain SQLite file.

```bash
sqlite3 ~/.local/share/crucible/crucible.db

# Browse proposals
SELECT title, status, rounds, created_at FROM proposals ORDER BY created_at DESC;

# Change log for a repo
SELECT commit_hash, commit_date, author, message FROM repo_changes
WHERE repo_path='/path/to/repo' ORDER BY commit_date DESC;

# All git actions
SELECT type, description, status, executed_at FROM actions ORDER BY created_at DESC;
```

Tables: `sessions`, `proposals`, `messages`, `actions`, `repo_knowledge`, `repo_changes`, `staged_files`

---

## API key storage

crucible uses a 3-tier system to keep your API keys safe:

| Tier | Backend | When used |
|---|---|---|
| 1 | **OS keychain** | macOS Keychain (`security`) or Linux libsecret (`secret-tool`) |
| 2 | **Secure file** | `~/.config/crucible/keys/` — directory mode 700, files mode 600 |
| 3 | **Env vars** | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` — legacy fallback only |

At startup, crucible searches all locations in priority order and uses the first key found — **you are never prompted for a key that is already stored somewhere**. Keys are never written to the wrapper script, MCP config, or any world-readable file.

Check key status without revealing values:

```bash
crucible keys status
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | Legacy fallback (installer stores key in keychain instead) |
| `ANTHROPIC_API_KEY` | — | Legacy fallback (installer stores key in keychain instead) |
| `MAX_ROUNDS` | `10` | Maximum debate rounds before forcing synthesis |
| `CRUCIBLE_SESSION_ONLY` | unset | If `1`, keys held in memory only — never written to disk |
| `CRUCIBLE_SILENCE_KEY_WARN` | unset | If `1`, suppress the file-fallback key warning |
| `CRUCIBLE_PARANOID_ENV` | unset | If `1`, strip extra env vars from all child processes |
| `OPENAI_MODEL` | auto | Force a specific OpenAI model (skips auto-detection) |
| `CLAUDE_MODEL` | auto | Force a specific Claude model (skips auto-detection) |
| `CRUCIBLE_DEBUG` | unset | If `1`, emit debug lines to stderr (model selection, token use) |

---

## Project structure

```
src/
  cli.js      — interactive REPL, all commands, debate engine, git flow
  db.js       — SQLite schema and all queries
  repo.js     — repo scanning, Claude-powered understanding, change log
  staging.js  — file inference, content generation, per-file review, git staging
  keys.js     — secure API key storage (keychain → file → env)
  github.js   — GitHub CLI integration (repo browsing, auth, PR management)
  safety.js   — path validation, branch validation, env hardening
  models.js   — model selection and ranking logic
  providers.js — LLM client initialisation
  chat.js     — conversational chat session management
install.sh    — one-shot installer (copies files, installs deps, adds to PATH)
setup-git.sh  — installs GitHub CLI and authenticates
docs/
  SECURITY.md — threat model and security architecture
```

---

## Building from source / development

```bash
# Clone and install dependencies only (no global install)
git clone https://github.com/YOUR_USERNAME/crucible.git
cd crucible
npm install

# Run directly from source
node src/cli.js

# Run the test suite
npm test

# Syntax-check all source files
node --check src/*.js

# Install globally from your local clone
./install.sh
```

Tests live in `test/` and use Node's built-in test runner (`node --test`). No extra test framework needed.

---

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for the full threat model, including:

- API key protection and redaction
- Path traversal prevention
- Shell injection prevention (all git/gh calls use `spawnSync` with explicit arg arrays)
- Environment hardening (`safeEnv()` strips API keys from child processes)
- Prompt injection guards (repo content is prefixed with an untrusted-content banner)

---

## License

MIT
