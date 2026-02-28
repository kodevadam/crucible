#!/usr/bin/env bash
set -e

echo ""
echo "╔══════════════════════════════════╗"
echo "║        crucible install          ║"
echo "╚══════════════════════════════════╝"
echo ""

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

# ── API keys ──────────────────────────────────────────────────────────────────

echo ""
read -rp "OpenAI API key (sk-...):        " OPENAI_KEY
echo ""
read -rp "Anthropic API key (sk-ant-...): " ANTHROPIC_KEY
echo ""

if [[ -z "$OPENAI_KEY" || -z "$ANTHROPIC_KEY" ]]; then
  echo "Both API keys are required."
  exit 1
fi

# ── Install to ~/.local/share/crucible ───────────────────────────────────────

DEST="$HOME/.local/share/crucible"
mkdir -p "$DEST/src"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$SCRIPT_DIR/src/cli.js"  "$DEST/src/cli.js"
cp "$SCRIPT_DIR/src/db.js"   "$DEST/src/db.js"
cp "$SCRIPT_DIR/src/repo.js" "$DEST/src/repo.js"
cp "$SCRIPT_DIR/package.json" "$DEST/package.json"
chmod +x "$DEST/src/cli.js"

echo "Installing npm dependencies..."
cd "$DEST" && npm install --silent
echo "Dependencies installed"

# ── ~/.local/bin/crucible wrapper ─────────────────────────────────────────────

mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/crucible" << EOF
#!/usr/bin/env bash
export OPENAI_API_KEY="${OPENAI_KEY}"
export ANTHROPIC_API_KEY="${ANTHROPIC_KEY}"
export MAX_ROUNDS="\${MAX_ROUNDS:-10}"
exec node "\$HOME/.local/share/crucible/src/cli.js" "\$@"
EOF
chmod +x "$HOME/.local/bin/crucible"

# ── Register MCP server with Claude Code ──────────────────────────────────────

mkdir -p "$HOME/.claude"
node -e "
const fs   = require('fs');
const file = process.env.HOME + '/.claude/claude.json';
const cfg  = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers.crucible = {
  command: 'node',
  args: [process.env.HOME + '/.local/share/crucible/src/cli.js'],
  env: {
    OPENAI_API_KEY:    '${OPENAI_KEY}',
    ANTHROPIC_API_KEY: '${ANTHROPIC_KEY}',
    MAX_ROUNDS:        '10'
  }
};
fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
console.log('Claude Code MCP config updated');
"

# ── PATH ──────────────────────────────────────────────────────────────────────

if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
  echo "Added ~/.local/bin to PATH — run: source ~/.bashrc"
fi

# ── Smoke test ────────────────────────────────────────────────────────────────

echo ""
echo "Running smoke test..."

CHECKFILE=$(mktemp /tmp/crucible-smoke-XXXXXX.mjs)
cat > "$CHECKFILE" << 'SMOKEEOF'
const home = process.env.HOME;
const { default: OpenAI }    = await import(`file://${home}/.local/share/crucible/node_modules/openai/index.js`);
const { default: Anthropic } = await import(`file://${home}/.local/share/crucible/node_modules/@anthropic-ai/sdk/index.js`);
const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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

OPENAI_API_KEY="$OPENAI_KEY" ANTHROPIC_API_KEY="$ANTHROPIC_KEY" node "$CHECKFILE"
STATUS=$?
rm -f "$CHECKFILE"

echo ""
if [ $STATUS -eq 0 ]; then
  echo "crucible is ready. Just type: crucible"
else
  echo "Smoke test failed — check your API keys."
  exit 1
fi
echo ""
