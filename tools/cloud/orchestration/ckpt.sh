#!/bin/bash
# checkpoint v2-native and write an incremental bundle on top of origin/v2-native's last known tip
cd /home/claude/worship-rig || exit 1
for p in native tools app test docs CONTRACT_CHANGES.md CLAUDE.md .github/workflows/native-core.yml; do [ -e "$p" ] && git add -A "$p"; done
if ! git diff --cached --quiet; then
  git commit -q -m "${1:-v2 setup (wip): checkpoint}

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TjRS9o42c1fgPwLHQaRjPA"
fi
git fetch -q origin v2-native:refs/remotes/origin/v2-native 2>/dev/null; base=$(git rev-parse origin/v2-native)
tip=$(git rev-parse v2-native); t7=${tip:0:7}
big=$(git diff --name-only $base $tip | while read f; do [ -f "$f" ] && [ $(stat -c%s "$f") -gt 20000000 ] && echo "$f"; done)
[ -n "$big" ] && { echo "OVER20MB: $big"; exit 2; }
if [ "$base" = "$tip" ]; then echo "UPTODATE $t7"; exit 0; fi
git bundle create /mnt/user-data/outputs/v2/v2-native-$t7.bundle $base..v2-native >/dev/null 2>&1
echo "BUNDLE /mnt/user-data/outputs/v2/v2-native-$t7.bundle $(stat -c%s /mnt/user-data/outputs/v2/v2-native-$t7.bundle) base=${base:0:7} tip=$t7 untracked_left=$(git status --short | wc -l)"
