#!/bin/sh
# Run the project's wrangler with Node 22 (wrangler 4 needs Node >= 22; the system default here is Node 18).
DIR="$(cd "$(dirname "$0")" && pwd)"
exec /opt/homebrew/opt/node@22/bin/node "$DIR/node_modules/wrangler/bin/wrangler.js" "$@"
