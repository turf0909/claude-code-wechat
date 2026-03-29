#!/bin/bash
# Full reset: clear login state + remove build artifacts and dependencies (back to post-clone state)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Clear login state
"$SCRIPT_DIR/reset-login.sh"

# Clear build artifacts and dependencies
rm -rf "$PROJECT_DIR/node_modules" "$PROJECT_DIR/dist" "$PROJECT_DIR/bun.lock"
echo "Cleared: node_modules/ dist/ bun.lock"

echo ""
echo "Reset complete. Run ./start.sh to start (will auto-install deps and build)."
