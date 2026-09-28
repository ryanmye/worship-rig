#!/usr/bin/env bash
# sync-from-cloud.sh: bring a cloud-session code snapshot into this repo.
#
# Flow: drop dir (split tar parts) -> temp dir -> rsync onto branch `cloud` -> commit -> merge `cloud` into `main`
#       -> npm install if package*.json changed -> npm test -- --fast -> one-screen summary.
#
# Why a `cloud` branch: it only ever holds verbatim snapshots, so `git merge cloud` has a real merge base. Edits the
# cloud made win cleanly, local commits on main that the cloud didn't touch survive, and a real clash is a normal
# git conflict instead of a silent overwrite. Tracked files follow the cloud (it is the source of truth for them).
#
# Conflicts (rule approved by Ryan): each conflicted file is auto-resolved when
#   (a) it is CLOUD-owned per the ownership table in COORDINATION.md (the cloud's copy; COORDINATION.md itself is
#       always cloud-owned, also on add/add): take the cloud's version;
#   (b) every conflict hunk is one side inserting lines while the other side inserted nothing and neither side
#       changed an original line there: keep both. Under test/ and docs/ also when both sides inserted at the same
#       spot and share no (non-blank) line: ours, then theirs.
#   Delete/modify conflicts, overlapping edits and anything unclear stop the script (merge left in progress). A
#   resolved file must keep no marker line, .js/.mjs/.cjs must pass `node --check` and .json must parse, or it stops
#   too. Each auto-resolution is one line in the merge commit message and in the summary's `conflicts` row.
#
# Usage: tools/sync-from-cloud.sh [<stamp>|<path-to-drop-dir>] [--no-test] [--dry-run]
#   (no drop)   newest drop under ~/Projects/worship-rig-transfer/incoming/ (stamp-like names by name sort,
#               otherwise the newest by mtime). Override the transfer root with WORSHIP_RIG_TRANSFER=/path.
#   --dry-run   unpack and show what rsync would change in the current tree; no checkout, commit or merge.
#   --no-test   skip `npm test -- --fast`.
# A drop holds code.tgz.partNN (from `split -b`) or a whole code.tgz, plus optionally samples.tgz[.partNN].
# Exit: 0 ok, 1 error, 2 conflicts the rule above could not resolve (merge left in progress for you),
#       3 synced fine but tests failed.
set -euo pipefail
shopt -s extglob   # the ownership globs become extglob patterns (see glob_to_pattern)

TRANSFER_ROOT="${WORSHIP_RIG_TRANSFER:-$HOME/Projects/worship-rig-transfer}"
INCOMING="$TRANSFER_ROOT/incoming"
MAIN_BRANCH=main
CLOUD_BRANCH=cloud

# Never touched or deleted by the rsync. Every .gitignore entry (local and snapshot) is added on top of these.
ALWAYS_EXCLUDE=(.git/ .DS_Store node_modules/ dist/ user-samples/ _to_delete/ test/logs/)
# Trees that arrive in a separate archive or not in every snapshot (v3's code.tgz has no app/samples at all).
# When the snapshot lacks one it is excluded; otherwise --delete would wipe e.g. the 2000 tracked sample files.
SEPARATE_TREES=(app/samples audition/mp3)

# State, filled in as we go and printed at the end.
DROP_ARG="" DRY_RUN=0 RUN_TESTS=1 TMP="" KEEP_TMP=0
DROP_DIR="" STAMP="" SNAP_ROOT="" CODE_TGZ="" CODE_INFO="" SAMPLES_TGZ="" SAMPLES_INFO="none"
SAMPLES_NOTE="no samples archive in this drop" PROTECTED=""
OLD_MAIN="" NEW_MAIN="" OLD_CLOUD="" NEW_CLOUD="" CLOUD_CREATED=0 DEST=. DEST_DESC="working tree"
CHANGE_NOTE="" BY_DIR="" MERGE_NOTE="" GITIGNORE_NOTE="" NPM_NOTE="not needed (package*.json unchanged)"
TEST_NOTE="skipped (--no-test)" TEST_RC=0
CLOUD_PATTERNS="" AUTO_LINES="" STOP_LINES="" NOTE="" WHY=""

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
mb()   { awk -v b="$(wc -c < "$1")" 'BEGIN { printf "%.1f MB", b / 1048576 }'; }
usage() { sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; }

# Keep the temp dir when it holds something the user needs (unplaced samples) or when we died half-way.
on_exit() {
  local rc=$?
  if [[ -n "$TMP" && -d "$TMP" ]]; then
    if (( KEEP_TMP )) || (( rc != 0 && rc != 3 )); then printf '\n(temp dir kept: %s)\n' "$TMP" >&2
    else rm -rf "$TMP"; fi
  fi
  if (( rc != 0 && rc != 3 )) && git rev-parse --git-dir > /dev/null 2>&1; then
    printf '(current branch: %s)\n' "$(git branch --show-current)" >&2
  fi
}
trap on_exit EXIT

parse_args() {
  while (( $# )); do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --no-test) RUN_TESTS=0 ;;
      -h|--help) usage; exit 0 ;;
      -*) die "unknown option: $1 (see --help)" ;;
      *) [[ -z "$DROP_ARG" ]] || die "only one drop may be given"; DROP_ARG=$1 ;;
    esac
    shift
  done
}

# ---------------------------------------------------------------- preconditions

check_repo() {
  local top branch dirty
  top=$(git rev-parse --show-toplevel 2> /dev/null) || die "not inside a git repository (run from the worship-rig repo)"
  grep -q '"name": "worship-rig"' "$top/package.json" 2> /dev/null || die "$top is not the worship-rig repo"
  cd "$top"
  [[ ! -e "$(git rev-parse --git-path MERGE_HEAD)" ]] || die "a merge is in progress; finish or abort it first"
  branch=$(git branch --show-current)
  [[ "$branch" == "$MAIN_BRANCH" ]] || die "start on '$MAIN_BRANCH' (currently on '${branch:-detached HEAD}')"
  # Untracked files are allowed: they are excluded from the rsync and never committed (see write_excludes).
  dirty=$(git status --porcelain --untracked-files=no)
  [[ -z "$dirty" ]] || die "working tree has uncommitted changes (commit or stash them first):"$'\n'"$dirty"
}

# Real stamps start with a date, so a name sort finds the newest. Hand-named drops (e.g. selftest-noop) are only
# picked, by mtime, when there is no stamp-named drop at all.
newest_drop() {
  local d stamped=() all=()
  for d in "$INCOMING"/*/; do
    [[ -d "$d" ]] || continue
    all+=("${d%/}")
    case "$(basename "$d")" in [0-9]*) stamped+=("${d%/}") ;; esac
  done
  (( ${#all[@]} )) || return 1
  if (( ${#stamped[@]} )); then printf '%s\n' "${stamped[@]}" | sort | tail -n 1
  else ls -1dt "${all[@]}" | head -n 1; fi
}

resolve_drop() {
  mkdir -p "$INCOMING"
  if [[ -z "$DROP_ARG" ]]; then
    DROP_DIR=$(newest_drop) || die "no drops under $INCOMING"
  elif [[ -d "$DROP_ARG" ]]; then
    DROP_DIR=$(cd "$DROP_ARG" && pwd)
  else
    [[ -d "$INCOMING/$DROP_ARG" ]] || die "no such drop: '$DROP_ARG' (not a directory, not a stamp in $INCOMING)"
    DROP_DIR="$INCOMING/$DROP_ARG"
  fi
  STAMP=$(basename "$DROP_DIR")
  log "drop: $DROP_DIR"
}

# ---------------------------------------------------------------- unpacking

# Rebuild <name>.tgz from its split parts, or take a whole <name>.tgz. Parts win because they are the transfer
# format; a whole .tgz beside them may be an older manual rebuild. Then prove the gzip+tar stream reads end to end.
# Sets the variables named by $2 (archive path, empty if absent) and $3 (human description).
assemble_archive() {
  local name=$1 out="$TMP/$1.tgz" parts=() p info
  for p in "$DROP_DIR/$name.tgz.part"*; do [[ -f "$p" ]] && parts+=("$p"); done
  if (( ${#parts[@]} )); then
    cat "${parts[@]}" > "$out"   # glob order is lexical = part00, part01, ... as written by split
    info="$(mb "$out") (rebuilt from ${#parts[@]} parts)"
  elif [[ -f "$DROP_DIR/$name.tgz" ]]; then
    out="$DROP_DIR/$name.tgz"
    info="$(mb "$out") (whole file)"
  else
    printf -v "$2" '%s' ""; return 0
  fi
  log "checking $name.tgz: $info"
  tar tzf "$out" > "$TMP/$name.list" 2> "$TMP/$name.err" \
    || die "$name.tgz is CORRUPT or truncated (tar tzf failed): $(head -n 3 "$TMP/$name.err")"
  [[ -s "$TMP/$name.list" ]] || die "$name.tgz is empty"
  printf -v "$2" '%s' "$out"
  printf -v "$3" '%s' "$info"
}

# The cloud wraps everything in worship-rig/. Detect it instead of assuming: package.json at the top means no
# wrapper; a single top-level dir holding package.json is the wrapper.
unpack_code() {
  local dir="$TMP/code" tops
  assemble_archive code CODE_TGZ CODE_INFO
  [[ -n "$CODE_TGZ" ]] || die "no code.tgz or code.tgz.part* in $DROP_DIR"
  mkdir -p "$dir"
  tar xzf "$CODE_TGZ" -C "$dir" || die "extracting code.tgz failed"
  tops=$(ls -A "$dir")
  if [[ -f "$dir/package.json" ]]; then SNAP_ROOT=$dir
  elif [[ $(printf '%s\n' "$tops" | wc -l) -eq 1 && -f "$dir/$tops/package.json" ]]; then SNAP_ROOT="$dir/$tops"
  else die "code.tgz has no package.json at its top or inside a single wrapper dir (top level: $(echo $tops))"
  fi
  log "snapshot tree: $SNAP_ROOT ($(find "$SNAP_ROOT" -type f | wc -l | tr -d ' ') files)"
}

# samples.tgz is placed automatically only when it is exactly app/samples/... (optionally inside worship-rig/),
# which is part of the tracked tree. Anything else is left in the temp dir for a human: no guessing.
unpack_samples() {
  local dir="$TMP/samples" root n
  assemble_archive samples SAMPLES_TGZ SAMPLES_INFO
  [[ -n "$SAMPLES_TGZ" ]] || { SAMPLES_INFO=none; return 0; }
  mkdir -p "$dir"
  tar xzf "$SAMPLES_TGZ" -C "$dir" || die "extracting samples.tgz failed"
  root=$dir
  [[ "$(ls -A "$dir")" == worship-rig && -d "$dir/worship-rig" ]] && root="$dir/worship-rig"
  if [[ "$(ls -A "$root")" == app && "$(ls -A "$root/app")" == samples && -d "$root/app/samples" ]]; then
    mkdir -p "$SNAP_ROOT/app"
    rsync -rlpt "$root/app/samples/" "$SNAP_ROOT/app/samples/"
    n=$(find "$root/app/samples" -type f | wc -l | tr -d ' ')
    SAMPLES_NOTE="app/samples/ layout ($n files): merged into the snapshot and synced (mirrored) with the code"
    log "samples: $SAMPLES_NOTE"
  else
    KEEP_TMP=1
    SAMPLES_NOTE="NOT placed (not an app/samples/ layout); extracted to $root; place it manually"
    log "samples.tgz is not an app/samples/ tree, so it was left alone. It is extracted at:"
    printf '      %s\n    top level:\n' "$root"
    ls -la "$root" | sed 's/^/      /'
    log "place it manually (it will not be synced or committed by this script)"
  fi
}

# ---------------------------------------------------------------- rsync

# .gitignore -> rsync exclude. A pattern with an inner slash is anchored to the repo root in git, so anchor it with
# a leading "/" for rsync too; slash-free patterns match at any depth in both. Both tools read "**" and a trailing
# "/" (directory only) the same way. Negations (!) have no exclude-only equivalent and are skipped with a warning.
gitignore_to_rsync() {
  local line
  sed -e 's/[[:space:]]*$//' | while IFS= read -r line; do
    case "$line" in
      '' | '#'*) continue ;;
      '!'*) warn "ignoring .gitignore negation '$line' (no rsync equivalent)"; continue ;;
    esac
    [[ "${line%/}" == */* && "$line" != /* ]] && line="/$line"
    printf '%s\n' "$line"
  done
}

# Untracked (not ignored) files are the user's local work: exclude them from rsync so --delete can't remove them;
# unstage_foreign keeps them out of the commit. If the snapshot ships the same path, stop, as
# `git merge` would ("untracked working tree file would be overwritten").
write_excludes() {
  local f="$TMP/rsync-excludes" t path clash=""
  printf '%s\n' "${ALWAYS_EXCLUDE[@]}" | gitignore_to_rsync > "$f"
  { cat .gitignore 2> /dev/null; cat "$SNAP_ROOT/.gitignore" 2> /dev/null; } | gitignore_to_rsync >> "$f"
  PROTECTED=""
  for t in "${SEPARATE_TREES[@]}"; do
    if [[ ! -d "$SNAP_ROOT/$t" ]]; then
      printf '/%s/\n' "$t" >> "$f"
      [[ -e "$t" ]] && PROTECTED="$PROTECTED $t/"
    fi
  done
  # --directory: a wholly untracked dir is listed once as "dir/", so the dir itself is excluded too.
  git ls-files --others --exclude-standard --directory -z > "$TMP/untracked.z"
  while IFS= read -r -d '' path; do
    [[ -e "$SNAP_ROOT/${path%/}" ]] && clash="$clash"$'\n'"  $path"
    printf '/%s\n' "$path" | sed 's/[[*?]/\\&/g' >> "$f"   # escape wildcards: these are literal names
  done < "$TMP/untracked.z"
  [[ -z "$clash" ]] || die "untracked local files also exist in the snapshot; move or commit them first:$clash"
  sort -u -o "$f" "$f"
}

# -c compares content, so no -t: unchanged files keep their local mtime and only real differences are itemized.
# -rlp, not -a: owner/group are meaningless here; -p keeps the exec bit, which git tracks.
# openrsync (macOS) prints "not empty, cannot delete" (to stdout) for a dir the snapshot dropped that still holds
# excluded files. Expected, and the dir is kept; those lines are dropped from the itemized list, as are ".f..T"
# lines (only the mtime differs, which we deliberately don't copy).
sync_tree() {
  local dry=() out="$TMP/rsync.out" n
  (( DRY_RUN )) && dry=(-n)
  write_excludes
  n=$(wc -l < "$TMP/rsync-excludes" | tr -d ' ')
  log "rsync ${dry[*]:+${dry[*]} }snapshot -> $DEST_DESC (--delete, $n excludes)"
  rsync -rlp -c --delete --itemize-changes ${dry[@]+"${dry[@]}"} --exclude-from="$TMP/rsync-excludes" \
    "$SNAP_ROOT/" "$DEST/" > "$out.raw" 2> "$TMP/rsync.err" || { cat "$TMP/rsync.err" >&2; die "rsync failed"; }
  grep -v -e 'not empty, cannot delete' -e '^\.[fdL]\.\.[tT]\.\.\.\. ' "$out.raw" > "$out" || true
  grep -v 'not empty, cannot delete' "$TMP/rsync.err" >&2 || true
}

# A dry run may not check out `cloud`, yet the real rsync lands on cloud's tree, not main's: against main, every
# main-only commit would show up as a deletion. So compare against an export of `cloud` when the branch exists.
choose_dry_run_target() {
  if git show-ref --verify --quiet "refs/heads/$CLOUD_BRANCH"; then
    mkdir -p "$TMP/cloud-tree"
    git archive "$CLOUD_BRANCH" | tar xf - -C "$TMP/cloud-tree"
    DEST="$TMP/cloud-tree" DEST_DESC="branch '$CLOUD_BRANCH' (exported to temp)"
  else
    DEST=. DEST_DESC="current tree on $MAIN_BRANCH (no '$CLOUD_BRANCH' branch yet; the first run starts it from here)"
  fi
}

# File counts from rsync's itemized output: >f+++ new, >f changed, *deleting (not dirs/) removed, .f mode only.
rsync_counts() {
  awk '/^>f\+\+\+/ {a++; next} /^>f/ {m++; next} /^\*deleting .*[^\/]$/ {d++; next} /^\.f/ {t++}
       END { printf "%d new, %d changed, %d deleted, %d mode-only (files)", a, m, d, t }' "$TMP/rsync.out"
}

print_dry_run_changes() {
  local list="$TMP/rsync.changes" n max=300
  cp "$TMP/rsync.out" "$list"
  n=$(wc -l < "$list" | tr -d ' ')
  log "would change: $(rsync_counts)"
  if (( n == 0 )); then echo "    (nothing: $DEST_DESC already matches the snapshot)"; return; fi
  head -n "$max" "$list" | sed 's/^/    /'
  if (( n > max )); then
    KEEP_TMP=1
    echo "    ... $((n - max)) more lines; full list: $list"
  fi
}

# ---------------------------------------------------------------- git

# The snapshot's .gitignore replaces main's on `cloud`. If it lacks a local-only line (e.g. _to_delete/), that tree
# becomes un-ignored and `git add -A` would commit it. So stage with main's ignore rules + ALWAYS_EXCLUDE on top,
# via core.excludesFile (an extra ignore source; it only ever hides more). Captured before leaving main.
save_local_ignores() {
  { printf '%s\n' "${ALWAYS_EXCLUDE[@]}"; cat .gitignore 2> /dev/null; } > "$TMP/git-excludes"
}

checkout_cloud() {
  OLD_MAIN=$(git rev-parse HEAD)
  save_local_ignores
  if git show-ref --verify --quiet "refs/heads/$CLOUD_BRANCH"; then
    git checkout -q "$CLOUD_BRANCH"
  else
    log "creating branch '$CLOUD_BRANCH' from $MAIN_BRANCH $(git rev-parse --short HEAD)"
    git checkout -q -b "$CLOUD_BRANCH"
    CLOUD_CREATED=1
  fi
  OLD_CLOUD=$(git rev-parse HEAD)
}

# "A added, M modified, D deleted" plus a per-top-level-directory breakdown.
summarize_diff() {
  CHANGE_NOTE=$(git diff --name-status --no-renames "$1" "$2" | awk '
    { k = substr($1, 1, 1); if (k == "A") a++; else if (k == "D") d++; else m++ }
    END { printf "%d added, %d modified, %d deleted", a, m, d }')
  CHANGE_NOTE="$CHANGE_NOTE ($(git diff --shortstat "$1" "$2" | sed 's/^ *//'))"
  BY_DIR=$(git diff --name-only --no-renames "$1" "$2" | awk -F/ '{ print (NF > 1 ? $1 "/" : $1) }' \
    | sort | uniq -c | sort -rn | awk '{ printf "%s%s %d", (NR > 1 ? ", " : ""), $2, $1 }')
}

# Belt and braces: a snapshot commit may only add files that are in the snapshot. Anything else staged as new
# (the user's untracked files, a tree some ignore rule no longer covers) is unstaged again and left on disk.
unstage_foreign() {
  local path n=0
  : > "$TMP/foreign.z"
  while IFS= read -r -d '' path; do
    [[ -e "$SNAP_ROOT/$path" ]] && continue
    printf '%s\0' "$path" >> "$TMP/foreign.z"
    n=$((n + 1))
  done < <(git diff --cached --name-only --diff-filter=A --no-renames -z)
  (( n )) || return 0
  GIT_LITERAL_PATHSPECS=1 git reset -q --pathspec-from-file="$TMP/foreign.z" --pathspec-file-nul
  log "kept $n local file(s) that are not in the snapshot out of the commit (untouched on disk), e.g.:"
  tr '\0' '\n' < "$TMP/foreign.z" | head -n 5 | sed 's/^/    /'
}

commit_cloud() {
  git -c core.excludesFile="$TMP/git-excludes" add -A
  unstage_foreign
  if git diff --cached --quiet; then
    log "snapshot identical to cloud branch"
    CHANGE_NOTE="none: snapshot identical to cloud branch"
  else
    git commit -q -m "cloud snapshot $STAMP"
    summarize_diff "$OLD_CLOUD" HEAD
    log "committed $(git rev-parse --short HEAD) on $CLOUD_BRANCH: $CHANGE_NOTE"
  fi
  NEW_CLOUD=$(git rev-parse HEAD)
}

# ---------------------------------------------------------------- conflicts

# Backtick-quoted globs in the "Area / files" column of COORDINATION.md rows whose Owner starts with CLOUD. Read from
# the cloud branch: the cloud writes that file, so its copy is the current one (main's may be a cycle old).
cloud_globs() {
  { git show "$CLOUD_BRANCH:COORDINATION.md" || git show "$MAIN_BRANCH:COORDINATION.md"; } 2> /dev/null | awk -F'|' '
    /^\|/ { owner = $3; sub(/^[ \t]+/, "", owner); if (owner !~ /^CLOUD/) next
            s = $2
            while (match(s, /`[^`]+`/)) { print substr(s, RSTART + 1, RLENGTH - 2); s = substr(s, RSTART + RLENGTH) } }
  ' || true
}

# components/{onTile,stepChip}.js -> one line per alternative (recursive, so several brace groups work too).
expand_braces() {
  local g=$1 pre rest body post alts=() a
  if [[ "$g" != *\{*\}* ]]; then printf '%s\n' "$g"; return 0; fi
  pre=${g%%\{*} rest=${g#*\{}
  body=${rest%%\}*} post=${rest#*\}}
  IFS=, read -r -a alts <<< "$body"
  for a in "${alts[@]}"; do expand_braces "$pre$a$post"; done
}

# Glob -> extglob pattern for [[ == ]], where a bare * would also match "/": * stays inside one path segment,
# **/ matches zero or more directories, any other ** matches anything.
glob_to_pattern() {
  printf '%s\n' "$1" \
    | sed -e 's#\*\*/#@DS@#g' -e 's#\*\*#@DD@#g' -e 's#\*#*([!/])#g' -e 's#@DS@#?(*/)#g' -e 's#@DD@#*#g'
}

# The table writes components/..., shared/... for app/js/components/..., so every glob also matches under app/js/.
load_cloud_patterns() {
  local g e
  CLOUD_PATTERNS=COORDINATION.md
  while IFS= read -r g; do
    while IFS= read -r e; do
      CLOUD_PATTERNS+=$'\n'"$(glob_to_pattern "$e")"
      [[ "$e" == app/js/* ]] || CLOUD_PATTERNS+=$'\n'"$(glob_to_pattern "app/js/$e")"
    done < <(expand_braces "$g")
  done < <(cloud_globs)
}

is_cloud_owned() {
  local pat
  while IFS= read -r pat; do [[ -n "$pat" && "$1" == $pat ]] && return 0; done <<< "$CLOUD_PATTERNS"
  return 1
}

# "<stages present> <mode ours> <mode theirs>", e.g. "123 100644 100644". Without stage 2 or 3 one side deleted
# (or renamed away) the file; without stage 1 both sides added it.
stage_info() {
  git ls-files -u -z -- "$1" | tr '\0' '\n' | awk '{ s = s $3; m[$3] = $1 } END { print s, m["2"] "-", m["3"] "-" }'
}

# Re-merge one file from its index stages with zdiff3 markers: unlike git's default style they show the base (so
# "one side only inserted" is provable, not guessed) while still trimming lines common to both sides. Classifies
# every hunk; writes the resolution to $TMP/resolve/resolved and prints "one-sided" or "disjoint", else prints why
# not and fails.
merge_both() {
  local p=$1 d="$TMP/resolve" disjoint=0 rc=0
  mkdir -p "$d"
  git show ":1:$p" > "$d/base" && git show ":2:$p" > "$d/ours" && git show ":3:$p" > "$d/theirs" \
    || { echo "could not read the index stages"; return 1; }
  git merge-file -p --zdiff3 -L ours -L base -L theirs "$d/ours" "$d/base" "$d/theirs" > "$d/merged" || rc=$?
  (( rc > 0 && rc < 128 )) \
    || { echo "git merge-file found no text conflict (binary, or not a content conflict)"; return 1; }
  case "$p" in test/* | docs/*) disjoint=1 ;; esac
  awk -v disjoint="$disjoint" -v out="$d/resolved" '
    function blank(s) { return s ~ /^[ \t\r]*$/ }
    function fail(why) { print why " (hunk at merged line " start ")"; bad = 1; exit 1 }
    function resolve(   i, seen) {
      if (nb) fail("both sides changed or deleted the same original lines")
      if (no && nt) {
        if (!disjoint) fail("both sides inserted different lines at the same spot (outside test/ and docs/)")
        for (i = 1; i <= no; i++) if (!blank(o[i])) seen[o[i]] = 1
        for (i = 1; i <= nt; i++) if (!blank(t[i]) && (t[i] in seen)) fail("both sides inserted the line \"" t[i] "\"")
        kind = "disjoint"
      }
      for (i = 1; i <= no; i++) print o[i] > out
      for (i = 1; i <= nt; i++) print t[i] > out
    }
    state == 0 && /^<<<<<<<( |$)/ { state = 1; no = nb = nt = 0; start = FNR; hunks++; next }
    state == 1 && /^\|\|\|\|\|\|\|( |$)/ { state = 2; next }
    (state == 1 || state == 2) && /^=======$/ { state = 3; next }
    state == 3 && /^>>>>>>>( |$)/ { resolve(); state = 0; next }
    state == 0 { print > out; next }
    state == 1 { o[++no] = $0; next }
    state == 2 { nb++; next }
    state == 3 { t[++nt] = $0; next }
    END { if (bad) exit 1
          if (state || !hunks) { print "could not parse the conflict hunks"; exit 1 }
          print (kind == "" ? "one-sided" : kind) }
  ' "$d/merged" || return 1
  # awk ends every line with a newline; keep a missing one at EOF missing.
  [[ -z "$(tail -c 1 "$d/merged")" ]] || perl -pi -e 'chomp if eof' "$d/resolved"
}

# A resolution may not keep a marker line and must still parse (node --check reads ESM too).
check_resolved() {
  local p=$1 err
  if grep -qE '^(<<<<<<<|>>>>>>>|\|\|\|\|\|\|\|)( |$)|^=======$' "$p"; then
    echo "a conflict marker line remains"; return 1
  fi
  case "$p" in
    *.js | *.mjs | *.cjs)
      err=$(node --check "$p" 2>&1) || { echo "node --check fails: $(grep -m 1 'Error' <<< "$err")"; return 1; } ;;
    *.json)
      node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$p" 2> /dev/null \
        || { echo "not valid JSON"; return 1; } ;;
  esac
}

# Apply the rule (see the header) to one conflicted path and stage it. Sets NOTE, or WHY when it must stay manual.
resolve_one() {
  local p=$1 st m2 m3 kind
  NOTE="" WHY=""
  read -r st m2 m3 <<< "$(stage_info "$p")"
  if [[ "$st" != 123 && "$st" != 23 ]]; then
    WHY="delete/modify (one side deleted or renamed it): never auto-resolved"; return 1
  elif is_cloud_owned "$p"; then
    git checkout -q --theirs -- "$p"
    NOTE="theirs (cloud-owned per COORDINATION.md)"
  elif [[ "$st" == 23 ]]; then
    WHY="added on both sides and not cloud-owned"; return 1
  elif [[ "$m2" != "$m3" || ( "$m2" != 100644- && "$m2" != 100755- ) ]]; then
    WHY="not a plain file on both sides, or its mode changed (${m2%-} vs ${m3%-})"; return 1
  else
    kind=$(merge_both "$p") || { WHY=$kind; return 1; }
    cat "$TMP/resolve/resolved" > "$p"
    NOTE="kept both (one-sided hunks)"
    [[ "$kind" == disjoint ]] && NOTE="kept both (disjoint hunks under ${p%%/*}/)"
  fi
  if ! WHY=$(check_resolved "$p"); then
    WHY="$WHY after auto-resolving as $NOTE; conflict restored" NOTE=""
    git checkout -q -m -- "$p"
    return 1
  fi
  git add -- "$p"
}

# Runs after `git merge` reported conflicts. Commits the merge when every conflicted path was auto-resolved;
# otherwise fails with the merge still in progress, the resolved paths staged and listed in MERGE_MSG.
resolve_conflicts() {
  local p msg
  msg=$(git rev-parse --git-path MERGE_MSG)
  load_cloud_patterns
  # Listed up front: `git add` in the loop must not race a git process still reading the index.
  git diff --name-only --diff-filter=U -z > "$TMP/conflicts.z"
  while IFS= read -r -d '' p; do
    if resolve_one "$p"; then AUTO_LINES+="auto-resolved $p: $NOTE"$'\n'
    else STOP_LINES+="$p: $WHY"$'\n'; fi
  done < "$TMP/conflicts.z"
  AUTO_LINES=${AUTO_LINES%$'\n'} STOP_LINES=${STOP_LINES%$'\n'}
  if [[ -n "$STOP_LINES" ]]; then
    [[ -z "$AUTO_LINES" ]] || printf '\n%s\n' "$AUTO_LINES" >> "$msg"
    return 1
  fi
  { head -n 1 "$msg"; echo; printf '%s\n' "$AUTO_LINES"; } > "$TMP/merge-msg"
  git commit -q -F "$TMP/merge-msg"
}

conflict_banner() {
  local bar n
  bar=$(printf '#%.0s' {1..88})
  n=$(printf '%s\n' "$STOP_LINES" | wc -l | tr -d ' ')
  printf '\n%s\n' "$bar"
  echo "#  CONFLICTS in $n file(s) that could not be auto-resolved (listed below with the reason). Resolve them by"
  echo "#  hand, then: git add <those files> && git commit && npm test -- --fast"
  echo "#  The merge of '$CLOUD_BRANCH' into '$MAIN_BRANCH' is left IN PROGRESS. To back out: git merge --abort"
  printf '%s\n\nNot auto-resolved:\n' "$bar"
  printf '%s\n' "$STOP_LINES" | sed 's/^/  /'
  if [[ -n "$AUTO_LINES" ]]; then
    echo "Auto-resolved and staged (also added to the merge message):"
    printf '%s\n' "$AUTO_LINES" | sed 's/^/  /'
  fi
  echo
  echo "cloud snapshot commit: $(git rev-parse --short "$CLOUD_BRANCH") (\"cloud snapshot $STAMP\")"
}

merge_into_main() {
  local n
  git checkout -q "$MAIN_BRANCH"
  if git merge --no-edit "$CLOUD_BRANCH" > "$TMP/merge.out" 2>&1; then
    NEW_MAIN=$(git rev-parse HEAD)
    if [[ "$NEW_MAIN" == "$OLD_MAIN" ]]; then MERGE_NOTE="already up to date (main unchanged)"
    elif git rev-parse -q --verify HEAD^2 > /dev/null; then
      MERGE_NOTE="clean merge commit $(git rev-parse --short HEAD)"
    else MERGE_NOTE="fast-forward to $(git rev-parse --short HEAD)"
    fi
    log "merge: $MERGE_NOTE"
    return 0
  fi
  n=$(git diff --name-only --diff-filter=U | wc -l | tr -d ' ')
  (( n )) || { cat "$TMP/merge.out" >&2; die "git merge failed (no conflicted paths; see above)"; }
  log "merge: conflicts in $n file(s); applying the auto-resolve rule"
  if resolve_conflicts; then
    NEW_MAIN=$(git rev-parse HEAD)
    MERGE_NOTE="merge commit $(git rev-parse --short HEAD) ($n conflicted file(s) auto-resolved, see below)"
    log "merge: $MERGE_NOTE"
    return 0
  fi
  conflict_banner
  exit 2
}

# Lines main lost from .gitignore: local-only ignores the cloud never had. Worth a warning; they now leave main.
check_gitignore() {
  local lost
  lost=$(git diff "$OLD_MAIN" "$NEW_MAIN" -- .gitignore | sed -n 's/^-\([^-].*\)$/\1/p' | grep -v '^#' || true)
  [[ -n "$lost" ]] || return 0
  GITIGNORE_NOTE="cloud removed: $(printf '%s' "$lost" | tr '\n' ' ')(re-add on main if still wanted)"
}

maybe_npm_install() {
  git diff --quiet "$OLD_MAIN" "$NEW_MAIN" -- package.json package-lock.json && return 0
  log "package.json / package-lock.json changed: running npm install"
  if npm install; then NPM_NOTE="ran (ok)"; else NPM_NOTE="ran and FAILED (exit $?)"; fi
}

run_tests() {
  (( RUN_TESTS )) || return 0
  log "running npm test -- --fast (takes a few minutes)"
  npm test -- --fast || TEST_RC=$?
  if (( TEST_RC == 0 )); then TEST_NOTE="PASS (exit 0)"; else TEST_NOTE="FAIL (exit $TEST_RC)"; fi
  TEST_NOTE="$TEST_NOTE; logs: $(pwd)/test/logs/ (summary.txt)"
}

# ---------------------------------------------------------------- summary

print_summary() {
  local line title="sync-from-cloud summary"
  line=$(printf '=%.0s' {1..92})
  (( DRY_RUN )) && title="$title (DRY RUN: nothing committed, checked out or merged)"
  printf '\n%s\n  %s\n%s\n' "$line" "$title" "$line"
  printf '  %-13s %s\n' stamp "$STAMP" drop "$DROP_DIR" code.tgz "$CODE_INFO" samples.tgz "$SAMPLES_INFO" \
    samples "$SAMPLES_NOTE"
  [[ -z "$PROTECTED" ]] || printf '  %-13s %s\n' protected "${PROTECTED# } (not in snapshot: left untouched)"
  if (( DRY_RUN )); then
    printf '  %-13s %s\n' "would change" "$(rsync_counts)" "  compared to" "$DEST_DESC"
  else
    printf '  %-13s %s\n' "cloud commit" "$(git rev-parse --short "$NEW_CLOUD")$( (( CLOUD_CREATED )) \
      && echo " (branch '$CLOUD_BRANCH' newly created from $MAIN_BRANCH $(git rev-parse --short "$OLD_CLOUD"))")"
    printf '  %-13s %s\n' changes "$CHANGE_NOTE"
    [[ -z "$BY_DIR" ]] || printf '  %-13s %s\n' "  by dir" "$BY_DIR"
    [[ -z "$GITIGNORE_NOTE" ]] || printf '  %-13s %s\n' .gitignore "$GITIGNORE_NOTE"
    printf '  %-13s %s\n' merge "$MERGE_NOTE"
    [[ -z "$AUTO_LINES" ]] \
      || printf '%s\n' "$AUTO_LINES" | awk '{ printf "  %-13s %s\n", (NR == 1 ? "conflicts" : ""), $0 }'
    printf '  %-13s %s\n' "npm install" "$NPM_NOTE" tests "$TEST_NOTE"
  fi
  printf '  %-13s %s\n%s\n' branch "$(git branch --show-current)" "$line"
  if (( CLOUD_CREATED )); then
    echo "  note: first run. '$CLOUD_BRANCH' started at main, so main-only edits to tracked files were reverted by"
    echo "  the snapshot and that reversion was merged into main (see .gitignore above). Later runs merge normally."
  fi
  return 0
}

main() {
  parse_args "$@"
  check_repo
  resolve_drop
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/sync-from-cloud.XXXXXX")
  unpack_code
  unpack_samples
  if (( DRY_RUN )); then
    choose_dry_run_target
    sync_tree
    print_dry_run_changes
    print_summary
    return 0
  fi
  checkout_cloud
  DEST_DESC="branch '$CLOUD_BRANCH' in $(pwd)"
  sync_tree
  commit_cloud
  merge_into_main
  check_gitignore
  maybe_npm_install
  run_tests
  print_summary
  (( TEST_RC == 0 )) || exit 3
}

main "$@"
