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
- **Full history** — every session, proposal, debate message, git action, and repo change is logged to a local SQLite database.

---

## Install

```bash
git clone https://github.com/YOUR_USERNAME/crucible.git
cd crucible
chmod +x install.sh
./install.sh
```

Requires Node 18+. You'll be prompted for your OpenAI and Anthropic API keys.

For GitHub integration (PRs, cloning, merging via `gh`):

```bash
chmod +x setup-git.sh
./setup-git.sh
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

### Interactive session flow

```
1  New proposal
2  Git / GitHub
3  History
4  Repo — understanding & change log
5  Stage files from a previous plan
6  Switch repo
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

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | required | OpenAI API key |
| `ANTHROPIC_API_KEY` | required | Anthropic API key |
| `MAX_ROUNDS` | `10` | Maximum debate rounds before forcing synthesis |

---

## Project structure

```
src/
  cli.js     — interactive REPL, all commands, debate engine, git flow
  db.js      — SQLite schema and all queries
  repo.js    — repo scanning, Claude-powered understanding, change log
  staging.js — file inference, content generation, per-file review, git staging
install.sh   — one-shot installer (copies files, installs deps, adds to PATH)
setup-git.sh — installs GitHub CLI and authenticates
```

---

## License

MIT
