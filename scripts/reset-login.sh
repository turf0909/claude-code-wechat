#!/bin/bash
# Clear WeChat login state (credentials, cache, logs). Re-scan QR on next start.

CREDENTIALS_DIR="${WECHAT_CREDENTIALS_FILE%/*}"
if [ -z "$WECHAT_CREDENTIALS_FILE" ]; then
  CREDENTIALS_DIR="$HOME/.claude/channels/wechat"
fi

if [ -d "$CREDENTIALS_DIR" ]; then
  rm -rf "$CREDENTIALS_DIR"
  echo "Cleared: $CREDENTIALS_DIR"
else
  echo "Nothing to clear: $CREDENTIALS_DIR does not exist"
fi
