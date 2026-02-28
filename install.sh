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

# ── API keys ──────────────────────────────────────────────────────────────────
#
#   update mode     — always skip; existing keys are already in place
#   wipe / fresh    — check file fallback for pre-existing keys; offer to keep
#   factory reset   — keys were just deleted above; always prompt

NEED_KEYS=1
OPENAI_KEY=""
ANTHROPIC_KEY=""

if [ "$INSTALL_MODE" = "update" ]; then
  NEED_KEYS=0
  echo "Update mode — existing API keys are unchanged."

elif [ -f "$KEYS_DIR/crucible-openai" ] && [ -f "$KEYS_DIR/crucible-anthropic" ]; then
  # Keys found in the file fallback — offer to keep them
  echo ""
  echo "  Stored API keys detected in $KEYS_DIR"
  read -rp "  Re-use existing keys? [Y/n]: " _KEEPKEYS
  if [[ "${_KEEPKEYS:-y}" =~ ^[Yy]?$ ]]; then
    NEED_KEYS=0
    echo "  Keeping existing keys."
  fi
fi

if [ "$NEED_KEYS" = "1" ]; then
  echo ""
  read -rsp "  OpenAI API key (sk-...):        " OPENAI_KEY
  echo ""
  read -rsp "  Anthropic API key (sk-ant-...): " ANTHROPIC_KEY
  echo ""
  if [[ -z "$OPENAI_KEY" || -z "$ANTHROPIC_KEY" ]]; then
    echo "Both API keys are required."
    exit 1
  fi
fi

# ── Store new keys ─────────────────────────────────────────────────────────────
#
# Keys are stored via keys.js which picks the best available backend:
#   macOS  → Keychain  (security add-generic-password)
#   Linux  → libsecret (secret-tool) if available, else file fallback
#   file   → ~/.config/crucible/keys/  (mode 700/600, atomic rename)
#
# They are NOT embedded in the wrapper script or MCP config.

if [ -n "$OPENAI_KEY" ] && [ -n "$ANTHROPIC_KEY" ]; then
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
