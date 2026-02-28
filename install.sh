#!/usr/bin/env bash
set -e

echo ""
echo "╔══════════════════════════════════╗"
echo "║        crucible install          ║"
echo "╚══════════════════════════════════╝"
echo ""

# ── Paths ─────────────────────────────────────────────────────────────────────

DEST="$HOME/.local/share/crucible"          # source + npm deps + crucible.db
KEYS_DIR="$HOME/.config/crucible/keys"      # file-based key fallback
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Check Node ────────────────────────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  echo "Node not found. Installing Node 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi

NODE_MAJOR=$(node -e "console.log(parseInt(process.versions.node))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node 18+ required (have $(node --version)). Installing Node 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi

echo "Node $(node --version) / npm $(npm --version)"

# ── Check Claude Code ─────────────────────────────────────────────────────────

if ! command -v claude &>/dev/null; then
  echo "Installing Claude Code..."
  npm install -g @anthropic-ai/claude-code
fi
echo "Claude Code $(claude --version 2>/dev/null | head -1)"

# ── Detect existing installation ──────────────────────────────────────────────
#
#   update  — copy source files only; keep crucible.db and keys unchanged
#   wipe    — remove src/ and node_modules/, keep crucible.db and keys, reinstall
#   factory — remove everything ($DEST + stored keys); full fresh start
#   fresh   — no prior install detected; proceed normally

INSTALL_MODE="fresh"

if [ -d "$DEST/src" ]; then
  echo ""
  echo "  Existing installation detected at $DEST"
  echo ""
  echo "  1  Update source files         (keep keys and all data)  [default]"
  echo "  2  Wipe source & reinstall     (keep keys and crucible.db)"
  echo "  3  Factory reset               (erase all data, keys, and history)"
  echo "  4  Abort"
  echo ""
  read -rp "  Choice [1]: " _CHOICE
  case "${_CHOICE:-1}" in
    2) INSTALL_MODE="wipe" ;;
    3) INSTALL_MODE="factory" ;;
    4) echo ""; echo "Aborted."; exit 0 ;;
    *) INSTALL_MODE="update" ;;
  esac
fi

# ── Handle wipe ───────────────────────────────────────────────────────────────

if [ "$INSTALL_MODE" = "wipe" ]; then
  echo ""
  echo "  This removes $DEST/src and node_modules/, then reinstalls."
  echo "  crucible.db and API keys are preserved."
  echo ""
  read -rp "  Continue? [y/N]: " _C
  [[ "${_C:-n}" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
  rm -rf "$DEST/src" "$DEST/node_modules"
  echo "  Source files removed — reinstalling..."
fi

# ── Handle factory reset ───────────────────────────────────────────────────────

if [ "$INSTALL_MODE" = "factory" ]; then
  echo ""
  echo "  ⚠  This will permanently delete:"
  echo "       $DEST  (source, crucible.db, all session history)"
  echo "       $KEYS_DIR/crucible-openai"
  echo "       $KEYS_DIR/crucible-anthropic"
  echo "       (OS keychain entries for crucible-openai / crucible-anthropic)"
  echo ""
  read -rp "  Type YES to confirm factory reset: " _CONF
  [ "$_CONF" = "YES" ] || { echo "Aborted."; exit 0; }

  rm -rf "$DEST"
  rm -f "$KEYS_DIR/crucible-openai" "$KEYS_DIR/crucible-anthropic"

  # Clear OS keychain entries (best-effort; errors are non-fatal)
  if command -v security &>/dev/null; then
    security delete-generic-password -s "crucible-openai"    -a "crucible" 2>/dev/null || true
    security delete-generic-password -s "crucible-anthropic" -a "crucible" 2>/dev/null || true
  elif command -v secret-tool &>/dev/null; then
    secret-tool clear service "crucible-openai"    account "crucible" 2>/dev/null || true
    secret-tool clear service "crucible-anthropic" account "crucible" 2>/dev/null || true
  fi

  echo "  All crucible data removed."
fi

# ── Copy source files ─────────────────────────────────────────────────────────

mkdir -p "$DEST/src"
cp "$SCRIPT_DIR"/src/*.js "$DEST/src/"
cp "$SCRIPT_DIR/package.json" "$DEST/package.json"
chmod +x "$DEST/src/cli.js"

echo "Installing npm dependencies..."
cd "$DEST" && npm install --silent
echo "Dependencies installed"

# ── API key discovery — search ALL storage locations before prompting ──────────
#
# Priority (mirrors keys.js retrieval order):
#   1. OS keychain      macOS: security, Linux: secret-tool
#   2. File fallback    ~/.config/crucible/keys/
#   3. Env vars         OPENAI_API_KEY / ANTHROPIC_API_KEY
#
# update mode — skip entirely; existing keys are already in place.

NEED_OPENAI=0
NEED_ANTHROPIC=0
OPENAI_KEY=""
ANTHROPIC_KEY=""
OPENAI_SOURCE=""
ANTHROPIC_SOURCE=""

if [ "$INSTALL_MODE" = "update" ]; then
  echo "Update mode — existing API keys are unchanged."
else

  echo ""
  echo "  Searching for existing API keys..."

  # ── 1. OS keychain ──────────────────────────────────────────────────────────
  if command -v security &>/dev/null; then
    # macOS Keychain
    _K=$(security find-generic-password -s "crucible-openai"    -a "crucible" -w 2>/dev/null || true)
    if [ -n "$_K" ]; then OPENAI_KEY="$_K";    OPENAI_SOURCE="macOS Keychain"; fi
    _K=$(security find-generic-password -s "crucible-anthropic" -a "crucible" -w 2>/dev/null || true)
    if [ -n "$_K" ]; then ANTHROPIC_KEY="$_K"; ANTHROPIC_SOURCE="macOS Keychain"; fi
  elif command -v secret-tool &>/dev/null; then
    # Linux libsecret
    _K=$(secret-tool lookup service "crucible-openai"    account "crucible" 2>/dev/null || true)
    if [ -n "$_K" ]; then OPENAI_KEY="$_K";    OPENAI_SOURCE="OS keychain (libsecret)"; fi
    _K=$(secret-tool lookup service "crucible-anthropic" account "crucible" 2>/dev/null || true)
    if [ -n "$_K" ]; then ANTHROPIC_KEY="$_K"; ANTHROPIC_SOURCE="OS keychain (libsecret)"; fi
  fi

  # ── 2. File fallback ────────────────────────────────────────────────────────
  if [ -z "$OPENAI_KEY" ] && [ -f "$KEYS_DIR/crucible-openai" ]; then
    _K=$(cat "$KEYS_DIR/crucible-openai" 2>/dev/null | tr -d '[:space:]' || true)
    if [ -n "$_K" ]; then OPENAI_KEY="$_K"; OPENAI_SOURCE="file ($KEYS_DIR/crucible-openai)"; fi
  fi
  if [ -z "$ANTHROPIC_KEY" ] && [ -f "$KEYS_DIR/crucible-anthropic" ]; then
    _K=$(cat "$KEYS_DIR/crucible-anthropic" 2>/dev/null | tr -d '[:space:]' || true)
    if [ -n "$_K" ]; then ANTHROPIC_KEY="$_K"; ANTHROPIC_SOURCE="file ($KEYS_DIR/crucible-anthropic)"; fi
  fi

  # ── 3. Environment variables ─────────────────────────────────────────────────
  if [ -z "$OPENAI_KEY" ] && [ -n "$OPENAI_API_KEY" ]; then
    OPENAI_KEY="$OPENAI_API_KEY"
    OPENAI_SOURCE="env var OPENAI_API_KEY"
  fi
  if [ -z "$ANTHROPIC_KEY" ] && [ -n "$ANTHROPIC_API_KEY" ]; then
    ANTHROPIC_KEY="$ANTHROPIC_API_KEY"
    ANTHROPIC_SOURCE="env var ANTHROPIC_API_KEY"
  fi

  # ── Report what was found ────────────────────────────────────────────────────
  if [ -n "$OPENAI_KEY" ]; then
    echo "  ✔ OpenAI key found    — $OPENAI_SOURCE"
  else
    echo "  ✗ OpenAI key          — not found in any storage location"
    NEED_OPENAI=1
  fi
  if [ -n "$ANTHROPIC_KEY" ]; then
    echo "  ✔ Anthropic key found — $ANTHROPIC_SOURCE"
  else
    echo "  ✗ Anthropic key       — not found in any storage location"
    NEED_ANTHROPIC=1
  fi

  # ── Offer to replace existing keys ──────────────────────────────────────────
  if [ -n "$OPENAI_KEY" ] || [ -n "$ANTHROPIC_KEY" ]; then
    echo ""
    read -rp "  Replace any found keys with new ones? [y/N]: " _REPLACE
    if [[ "${_REPLACE:-n}" =~ ^[Yy]$ ]]; then
      NEED_OPENAI=1
      NEED_ANTHROPIC=1
      OPENAI_KEY=""
      ANTHROPIC_KEY=""
    fi
  fi

  # ── Prompt for missing keys ──────────────────────────────────────────────────
  if [ "$NEED_OPENAI" = "1" ] || [ "$NEED_ANTHROPIC" = "1" ]; then
    echo ""
    if [ "$NEED_OPENAI" = "1" ]; then
      read -rsp "  OpenAI API key (sk-...):        " OPENAI_KEY
      echo ""
    fi
    if [ "$NEED_ANTHROPIC" = "1" ]; then
      read -rsp "  Anthropic API key (sk-ant-...): " ANTHROPIC_KEY
      echo ""
    fi
    if [[ -z "$OPENAI_KEY" || -z "$ANTHROPIC_KEY" ]]; then
      echo "Both API keys are required."
      exit 1
    fi
  fi

fi  # end: not update mode

# ── Store new / replaced keys ──────────────────────────────────────────────────
#
# Keys are stored via keys.js which picks the best available backend:
#   macOS  → Keychain  (security add-generic-password)
#   Linux  → libsecret (secret-tool) if available, else file fallback
#   file   → ~/.config/crucible/keys/  (mode 700/600, atomic rename)
#
# They are NOT embedded in the wrapper script or MCP config.

if [ -n "$OPENAI_KEY" ] && [ -n "$ANTHROPIC_KEY" ] && [ "$INSTALL_MODE" != "update" ]; then
  echo "Storing API keys securely..."
  KEYFILE=$(mktemp /tmp/crucible-keys-XXXXXX.mjs)
  cat > "$KEYFILE" << EOF
import { storeKey, SERVICE_OPENAI, SERVICE_ANTHROPIC } from "${DEST}/src/keys.js";
storeKey(SERVICE_OPENAI,    process.env._CRUCIBLE_OPENAI_KEY);
storeKey(SERVICE_ANTHROPIC, process.env._CRUCIBLE_ANTHROPIC_KEY);
console.log("  Keys stored.");
EOF
  _CRUCIBLE_OPENAI_KEY="$OPENAI_KEY" _CRUCIBLE_ANTHROPIC_KEY="$ANTHROPIC_KEY" \
    node "$KEYFILE"
  STATUS=$?
  rm -f "$KEYFILE"
  if [ $STATUS -ne 0 ]; then
    echo "Warning: key storage failed. Check permissions on $KEYS_DIR"
  fi
fi

# ── ~/.local/bin/crucible wrapper (no keys embedded) ─────────────────────────

mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/crucible" << 'WRAPEOF'
#!/usr/bin/env bash
# crucible wrapper — keys retrieved at runtime from OS keychain or
# ~/.config/crucible/keys/ (stored securely during install).
# Do NOT add API keys here.
export MAX_ROUNDS="${MAX_ROUNDS:-10}"
exec node "$HOME/.local/share/crucible/src/cli.js" "$@"
WRAPEOF
chmod +x "$HOME/.local/bin/crucible"

# ── Register MCP server with Claude Code (no keys in config) ──────────────────

mkdir -p "$HOME/.claude"
node -e "
const fs   = require('fs');
const file = process.env.HOME + '/.claude/claude.json';
const cfg  = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers.crucible = {
  command: 'node',
  args: [process.env.HOME + '/.local/share/crucible/src/cli.js'],
  env: { MAX_ROUNDS: '10' }
};
fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
console.log('Claude Code MCP config updated (no keys stored in config)');
"

# ── PATH ──────────────────────────────────────────────────────────────────────

if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
  echo "Added ~/.local/bin to PATH — run: source ~/.bashrc"
fi

# ── GitHub CLI setup (optional) ───────────────────────────────────────────────
#
# Offers to install gh CLI and authenticate so crucible can browse repos,
# create PRs, and push to private repos without password prompts.
# Skipped on update mode to avoid re-prompting existing users.

if [ "$INSTALL_MODE" != "update" ]; then
  echo ""
  echo "  ── GitHub integration (optional) ──────────────────────────────────────"
  echo "  The gh CLI enables browsing your GitHub repos, creating PRs, cloning"
  echo "  private repos, and push to GitHub without password prompts."
  echo ""

  if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
    GH_USER=$(gh api /user --jq '.login' 2>/dev/null || true)
    echo "  ✔ GitHub already connected — signed in as ${GH_USER:-unknown}"
  else
    read -rp "  Set up GitHub integration now? [Y/n]: " _GH_SETUP
    if [[ "${_GH_SETUP:-y}" =~ ^[Yy]?$ ]]; then
      # Install gh CLI if missing
      if ! command -v gh &>/dev/null; then
        echo "  Installing GitHub CLI..."
        if command -v apt-get &>/dev/null; then
          type -p curl >/dev/null || sudo apt install -y curl
          curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
            | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
          echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
            | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
          sudo apt update -qq && sudo apt install -y gh
        elif command -v brew &>/dev/null; then
          brew install gh
        else
          echo "  Could not auto-install gh. See https://cli.github.com for instructions."
          echo "  Skipping GitHub setup."
        fi
      fi

      # Authenticate
      if command -v gh &>/dev/null; then
        echo "  Launching GitHub login (browser will open)..."
        gh auth login --web --git-protocol ssh || true
        if gh auth status &>/dev/null 2>&1; then
          GH_USER=$(gh api /user --jq '.login' 2>/dev/null || true)
          echo "  ✔ GitHub connected — signed in as ${GH_USER:-unknown}"
          # Configure git to use gh as credential helper
          gh auth setup-git 2>/dev/null || true

          # Collect git identity if not already set
          GIT_NAME=$(git config --global user.name 2>/dev/null || true)
          GIT_EMAIL=$(git config --global user.email 2>/dev/null || true)
          if [ -z "$GIT_NAME" ]; then
            read -rp "  Your name for git commits: " GIT_NAME
            [ -n "$GIT_NAME" ] && git config --global user.name "$GIT_NAME"
          fi
          if [ -z "$GIT_EMAIL" ]; then
            read -rp "  Your email for git commits: " GIT_EMAIL
            [ -n "$GIT_EMAIL" ] && git config --global user.email "$GIT_EMAIL"
          fi
        else
          echo "  GitHub login did not complete — run 'gh auth login' manually later."
        fi
      fi
    else
      echo "  Skipping — run setup-git.sh later to enable GitHub features."
    fi
  fi
fi

# ── Smoke test ────────────────────────────────────────────────────────────────
# Always runs to confirm keys and provider connectivity after any install mode.

echo ""
echo "Running smoke test..."

CHECKFILE=$(mktemp /tmp/crucible-smoke-XXXXXX.mjs)
cat > "$CHECKFILE" << 'SMOKEEOF'
const home = process.env.HOME;
const { default: OpenAI }    = await import(`file://${home}/.local/share/crucible/node_modules/openai/index.js`);
const { default: Anthropic } = await import(`file://${home}/.local/share/crucible/node_modules/@anthropic-ai/sdk/index.js`);
const { retrieveKey, SERVICE_OPENAI, SERVICE_ANTHROPIC } =
  await import(`file://${home}/.local/share/crucible/src/keys.js`);

const openaiKey    = retrieveKey(SERVICE_OPENAI);
const anthropicKey = retrieveKey(SERVICE_ANTHROPIC);

if (!openaiKey || !anthropicKey) {
  console.error("One or more API keys not found in secure storage.");
  console.error("Run: crucible keys status");
  process.exit(1);
}

const openai    = new OpenAI({ apiKey: openaiKey });
const anthropic = new Anthropic({ apiKey: anthropicKey });
let ok = true;
try {
  const { data } = await openai.models.list();
  const n = data.filter(m => /^gpt-(4|5)/.test(m.id)).length;
  console.log(`OpenAI connected — ${n} GPT models available`);
} catch(e) { console.error("OpenAI failed:", e.message); ok = false; }
try {
  const { data } = await anthropic.models.list();
  const s = data.filter(m => m.id.includes("sonnet")).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  console.log(`Anthropic connected — latest Sonnet: ${s[0]?.id}`);
} catch(e) { console.error("Anthropic failed:", e.message); ok = false; }
process.exit(ok ? 0 : 1);
SMOKEEOF

node "$CHECKFILE"
STATUS=$?
rm -f "$CHECKFILE"

echo ""
if [ $STATUS -eq 0 ]; then
  case "$INSTALL_MODE" in
    update)  echo "crucible updated successfully. Type: crucible" ;;
    wipe)    echo "crucible reinstalled. Type: crucible" ;;
    factory) echo "crucible installed fresh. Type: crucible" ;;
    *)       echo "crucible is ready. Type: crucible" ;;
  esac
else
  echo "Smoke test failed — check your API keys and connection."
  echo "Run 'crucible keys status' to diagnose."
  exit 1
fi
echo ""
