#!/bin/bash
# Set up a fresh Claude cloud container for Worship Rig 2.0 work (AWAY_WEEK_PLAN §0, REPICKUP "Handoff").
# Idempotent. Run from the repo root: bash tools/cloud/setup.sh
#
# What it does:
#   1. Installs the toolchain the gates use: g++ 13, clang++-20 (stand-in for Apple clang 21), cmake, ninja, lld.
#   2. npm ci (Playwright is a devDependency; never run `playwright install`).
#   3. Builds a PLAYWRIGHT_BROWSERS_PATH mapping: the pinned Playwright wants Chromium build N (browsers.json);
#      the container ships another build under /opt/pw-browsers. The mapping dir fakes build N with symlinks to the
#      shipped one. Export the printed PLAYWRIGHT_BROWSERS_PATH before any browser suite.
#   4. Installs the push guard as .git/hooks/pre-push (v2-native only, fast-forward only, no tags/main/deletes,
#      no samples, nothing over 20 MB).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

need=()
for p in g++-13 clang-20 cmake ninja-build lld; do dpkg -s "$p" >/dev/null 2>&1 || need+=("$p"); done
if [ ${#need[@]} -gt 0 ]; then
  echo "setup: apt-get install ${need[*]}"
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}"
fi

[ -d node_modules/playwright-core ] || npm ci --no-audit --no-fund

# 3. Playwright browser mapping
SHIP=/opt/pw-browsers
OUT=${RIG_PW_MAP:-$HOME/.cache/rig-pw}
want=$(node -e "const b=require('./node_modules/playwright-core/browsers.json').browsers;console.log(b.find(x=>x.name==='chromium').revision)")
have=$(ls -d $SHIP/chromium-[0-9]* 2>/dev/null | sed 's/.*-//' | sort -n | tail -1)
mkdir -p "$OUT"
for f in "$SHIP"/*; do ln -sfn "$f" "$OUT/$(basename "$f")"; done
if [ -n "$have" ] && [ "$want" != "$have" ]; then
  # full chromium: chrome-linux -> the shipped chrome-linux64
  mkdir -p "$OUT/chromium-$want"
  ln -sfn "$SHIP/chromium-$have/chrome-linux64" "$OUT/chromium-$want/chrome-linux"
  touch "$OUT/chromium-$want/INSTALLATION_COMPLETE" "$OUT/chromium-$want/DEPENDENCIES_VALIDATED"
  # headless shell: chrome-linux/<every file> -> shipped chrome-headless-shell-linux64, plus the old name headless_shell
  hs="$SHIP/chromium_headless_shell-$have/chrome-headless-shell-linux64"
  if [ -d "$hs" ]; then
    d="$OUT/chromium_headless_shell-$want/chrome-linux"; mkdir -p "$d"
    for f in "$hs"/*; do ln -sfn "$f" "$d/$(basename "$f")"; done
    ln -sfn "$hs/chrome-headless-shell" "$d/headless_shell"
    touch "$OUT/chromium_headless_shell-$want/INSTALLATION_COMPLETE" "$OUT/chromium_headless_shell-$want/DEPENDENCIES_VALIDATED"
  fi
fi
echo "setup: export PLAYWRIGHT_BROWSERS_PATH=$OUT   (Playwright wants chromium $want; container ships ${have:-none})"

# 4. push guard
install -m 0755 tools/cloud/pre-push .git/hooks/pre-push
echo "setup: push guard installed (.git/hooks/pre-push)"
echo "setup: done. Next: read native/docs/REPICKUP.md (Handoff section) and native/docs/AWAY_WEEK_PLAN.md"
