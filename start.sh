#!/bin/bash

# Channel mode startup script
# Usage: ./start.sh [working-directory]
#
# Authentication (by priority):
#   1. ANTHROPIC_API_KEY in .env or environment -> use API Key
#   2. Nothing set -> use Claude Code native OAuth

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_PATH="$SCRIPT_DIR/dist/wechat-channel.js"
WORK_DIR="${1:-$SCRIPT_DIR}"

# ── Load .env ─────────────────────────────────────────────────────────────────

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  . "$SCRIPT_DIR/.env"
  set +a
fi

# ── API Authentication ────────────────────────────────────────────────────────

if [ -n "$ANTHROPIC_API_KEY" ]; then
  echo "Auth: API Key${ANTHROPIC_BASE_URL:+ (proxy: $ANTHROPIC_BASE_URL)}"
else
  echo "Auth: Claude Code OAuth (make sure you ran: claude login)"
fi

# ── Build Check ───────────────────────────────────────────────────────────────

if [ ! -f "$DIST_PATH" ]; then
  echo "dist not found, running install and build..."

  if ! command -v bun &>/dev/null; then
    echo "bun not found, installing..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi

  cd "$SCRIPT_DIR"
  bun install
  npm run build

  if [ ! -f "$DIST_PATH" ]; then
    echo "Error: build failed, $DIST_PATH not found" >&2
    exit 1
  fi
fi

# ── WeChat Login ──────────────────────────────────────────────────────────────

WECHAT_CRED_FILE="${WECHAT_CREDENTIALS_FILE:-$HOME/.claude/channels/wechat/account.json}"

if [ ! -f "$WECHAT_CRED_FILE" ]; then
  echo "No WeChat credentials found, starting QR login..."
  node "$SCRIPT_DIR/dist/setup.js"
  if [ ! -f "$WECHAT_CRED_FILE" ]; then
    echo "Error: login failed or cancelled" >&2
    exit 1
  fi
fi

# ── MCP Config & Launch ──────────────────────────────────────────────────────

WECHAT_SERVER="{\"command\":\"node\",\"args\":[\"$DIST_PATH\"]}"

python3 -c "
import json, os
mcp_path = os.path.join('$WORK_DIR', '.mcp.json')
cfg = {}
if os.path.exists(mcp_path):
    with open(mcp_path) as f: cfg = json.load(f)
cfg.setdefault('mcpServers', {})['wechat'] = json.loads('$WECHAT_SERVER')
with open(mcp_path, 'w') as f: json.dump(cfg, f, indent=2); f.write('\n')
" 2>/dev/null

cd "$WORK_DIR"
exec claude --dangerously-load-development-channels server:wechat --dangerously-skip-permissions
