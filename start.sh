#!/bin/bash
# Wrapper: delegates to channel-mode/start.sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/channel-mode/start.sh" "$@"
