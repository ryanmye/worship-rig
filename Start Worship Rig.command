#!/bin/bash
# Worship Rig — double-click to start in Google Chrome.
# Keeps a small local server running in this Terminal window; closing the window stops it.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd "$(dirname "$0")" || exit 1

find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  for p in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
    if [ -x "$p" ]; then echo "$p"; return 0; fi
  done
  # nvm default (or newest installed) version
  if [ -d "$HOME/.nvm/versions/node" ]; then
    if [ -s "$HOME/.nvm/alias/default" ]; then
      want="$(cat "$HOME/.nvm/alias/default")"
      for d in "$HOME/.nvm/versions/node/"v${want#v}*; do
        if [ -x "$d/bin/node" ]; then echo "$d/bin/node"; return 0; fi
      done
    fi
    newest="$(ls -1d "$HOME/.nvm/versions/node/"v* 2>/dev/null | sort -V | tail -n 1)"
    if [ -n "$newest" ] && [ -x "$newest/bin/node" ]; then echo "$newest/bin/node"; return 0; fi
  fi
  return 1
}

NODE="$(find_node)"
if [ -z "$NODE" ]; then
  echo ""
  echo "  Worship Rig needs Node.js, which isn't installed on this Mac yet."
  echo ""
  echo "  1. Go to https://nodejs.org and download the LTS installer."
  echo "  2. Run it (just click Continue through the steps)."
  echo "  3. Double-click \"Start Worship Rig\" again."
  echo ""
  read -r -p "  Press Return to close this window… " _
  exit 1
fi

if ! "$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' >/dev/null 2>&1; then
  echo ""
  echo "  Worship Rig needs Node.js 18 or newer; this Mac has $("$NODE" --version 2>/dev/null)."
  echo "  Install the current LTS version from https://nodejs.org, then double-click \"Start Worship Rig\" again."
  echo ""
  read -r -p "  Press Return to close this window… " _
  exit 1
fi

echo "Starting Worship Rig… (keep this window open while you play)"
exec "$NODE" serve.mjs --open "$@"
