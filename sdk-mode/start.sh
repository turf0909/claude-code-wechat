#!/bin/bash

# SDK mode startup script: uses Agent SDK instead of MCP Channel, no OAuth needed
# Usage: ./sdk-mode/start.sh [working-directory]
#
# Authentication (by priority):
#   1. ANTHROPIC_API_KEY in .env or environment -> use it
#   2. Nothing set -> exit with error (SDK mode requires API Key)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WORK_DIR="${1:-$PROJECT_DIR}"

# ── Load .env ─────────────────────────────────────────────────────────────────

if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  . "$PROJECT_DIR/.env"
  set +a
fi

# ── API Authentication ────────────────────────────────────────────────────────

if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "Error: ANTHROPIC_API_KEY not found." >&2
  echo "Set it in .env or as an environment variable." >&2
  exit 1
fi

echo "Auth: API Key${ANTHROPIC_BASE_URL:+ (proxy: $ANTHROPIC_BASE_URL)}"

# ── Dependency Check ──────────────────────────────────────────────────────────

if [ ! -d "$PROJECT_DIR/node_modules/@anthropic-ai/claude-agent-sdk" ]; then
  echo "Installing dependencies..."
  cd "$PROJECT_DIR"
  if ! command -v bun &>/dev/null; then
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi
  bun install
fi

# ── WeChat Login ──────────────────────────────────────────────────────────────

WECHAT_CRED_FILE="${WECHAT_CREDENTIALS_FILE:-$HOME/.claude/channels/wechat/account.json}"
if [ ! -f "$WECHAT_CRED_FILE" ]; then
  echo "No WeChat credentials found, starting QR login..."
  if [ -f "$PROJECT_DIR/dist/setup.js" ]; then
    node "$PROJECT_DIR/dist/setup.js"
  else
    cd "$PROJECT_DIR" && npx tsx setup.ts
  fi
  if [ ! -f "$WECHAT_CRED_FILE" ]; then
    echo "Error: login failed or cancelled" >&2
    exit 1
  fi
fi

# ── Launch ────────────────────────────────────────────────────────────────────

cd "$WORK_DIR"
echo "Starting SDK mode (working directory: $WORK_DIR)"
exec npx tsx "$SCRIPT_DIR/main.ts"
