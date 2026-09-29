#!/bin/bash
# Worship Rig — double-click to update: pulls the latest code, rebuilds the Mac app, and opens it.
# Keep this Terminal window open until it finishes; it stays open on failure so you can read the message.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Repo root is two levels up from this script (tools/update.command -> repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || { echo "Couldn't find the Worship Rig folder."; read -n1 -p "Press any key to close"; exit 1; }

DRY="${UPDATE_DRY_RUN:-0}"

run() {
  # Prints the command; runs it for real unless UPDATE_DRY_RUN=1.
  if [ "$DRY" = "1" ]; then
    echo "  [dry run] $*"
    return 0
  fi
  "$@"
}

fail() {
  echo ""
  echo "  $1"
  echo ""
  read -n1 -p "Press any key to close" _
  echo ""
  exit 1
}

echo "Worship Rig updater"
echo "This will: pull the latest code, reinstall dependencies if needed, rebuild the app, and open it."
echo "Folder: $REPO_ROOT"
echo ""

if ! command -v git >/dev/null 2>&1; then
  fail "Git isn't installed or isn't on PATH. Install Xcode Command Line Tools (run 'xcode-select --install' in Terminal), then try again."
fi
if ! command -v npm >/dev/null 2>&1; then
  fail "Node.js/npm isn't installed or isn't on PATH. Install it from https://nodejs.org, then try again."
fi

echo "Checking for local changes…"
if [ "$DRY" != "1" ]; then
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    fail "This copy of Worship Rig has local changes that would be overwritten. Ask whoever set this up before continuing (or discard them yourself if you know what they are)."
  fi
else
  echo "  [dry run] git status --porcelain"
fi
echo "  OK — nothing local to lose."

LOCK_BEFORE=""
if [ "$DRY" != "1" ]; then
  LOCK_BEFORE="$(git rev-parse HEAD:package-lock.json 2>/dev/null)"
fi

echo "Pulling the latest code…"
if [ "$DRY" = "1" ]; then
  echo "  [dry run] git pull --ff-only"
else
  if ! git pull --ff-only; then
    fail "Couldn't update: this copy has diverged from the latest version (not a fast-forward). Ask whoever set this up to help, or re-download the repo fresh."
  fi
fi
echo "  OK."

LOCK_AFTER=""
if [ "$DRY" != "1" ]; then
  LOCK_AFTER="$(git rev-parse HEAD:package-lock.json 2>/dev/null)"
fi

if [ "$DRY" = "1" ]; then
  echo "Checking whether dependencies changed…"
  echo "  [dry run] (would compare package-lock.json before/after pull)"
  echo "Installing dependencies…"
  echo "  [dry run] npm ci"
else
  if [ "$LOCK_BEFORE" != "$LOCK_AFTER" ]; then
    echo "Dependencies changed — installing…"
    if ! run npm ci; then
      fail "Installing dependencies failed. Check your internet connection and try again."
    fi
    echo "  OK."
  else
    echo "Dependencies unchanged — skipping install."
  fi
fi

echo "Building the app (about half a minute)…"
if ! run npm run build:mac; then
  fail "Building the app failed. Try running 'npm run build:mac' in Terminal from this folder to see the full error."
fi
echo "  OK."

echo "Opening Worship Rig…"
if ! run open "dist/mac-arm64/Worship Rig.app"; then
  fail "The build finished, but the app didn't open. Look in the dist/mac-arm64 folder and double-click \"Worship Rig.app\" yourself."
fi
echo "  Done — Worship Rig should be opening now. This window can be closed."

if [ "$DRY" = "1" ]; then
  read -n1 -p "Press any key to close" _
  echo ""
fi
