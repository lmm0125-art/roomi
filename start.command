#!/bin/zsh
cd "$(dirname "$0")"

# Prefer node on PATH, then the usual Homebrew locations. The previous version
# hardcoded one user's WorkBuddy runtime path, which breaks on every other Mac.
if command -v node >/dev/null 2>&1; then
    NODE_BIN=node
elif [ -x /opt/homebrew/bin/node ]; then
    NODE_BIN=/opt/homebrew/bin/node
elif [ -x /usr/local/bin/node ]; then
    NODE_BIN=/usr/local/bin/node
else
    echo "node >= 22 not found. Install it or add it to PATH." >&2
    exit 1
fi

exec "$NODE_BIN" --experimental-sqlite server.js
