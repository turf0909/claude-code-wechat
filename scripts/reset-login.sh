#!/bin/bash
# Clear WeChat login state (credentials, cache, logs). Re-scan QR on next start.

CRED_FILE="${WECHAT_CREDENTIALS_FILE:-$HOME/.claude/channels/wechat/account.json}"
CREDENTIALS_DIR="$(dirname "$CRED_FILE")"

if [ -d "$CREDENTIALS_DIR" ]; then
  rm -rf "$CREDENTIALS_DIR"
  echo "Cleared: $CREDENTIALS_DIR"
else
  echo "Nothing to clear: $CREDENTIALS_DIR does not exist"
fi
