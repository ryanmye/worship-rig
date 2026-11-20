#!/usr/bin/env bash
# Worship Rig 2.0: every automatable Mac check in one unattended run (native/docs/MAC_CHECK.md, tier 1).
#
#   bash tools/mac/check.sh [--rev <ref>] [--stage tools,core,probe,apple-mac,apple-sim] [--out <dir>] [--quick]
#                           [--jobs N] [--cache <dir>] [--repo <dir>] [--src <tree>]
#
# Stages (in this order; a failed stage does not stop the ones that do not depend on it):
#   tools      versions of macOS, CPU, Xcode, cmake, ninja, xcodegen, node; missing ones -> the exact brew line
#   core       native/core: cmake Release (Ninja) + build + ctest -j<ncpu> with Apple clang, pass/fail per test
#   probe      rig-probe on the default output device, OUTPUT MUTED (DECISIONS D2 64 frames, D4 'auto' voice limit)
#   apple-mac  build-core.sh --mac-only, xcodegen, xcodebuild WorshipRig-macOS (Debug, ad-hoc), compile only
#   apple-sim  build-core.sh --sim --no-device, xcodebuild WorshipRig-iPad for 'generic/platform=iOS Simulator'
# --quick = core + apple-mac (the compile-fix loop). --src <tree> copies an uncommitted tree instead of exporting a
# revision (testing this script; the copy, not the tree, is built).
#
# Rules it keeps: the user's working tree, index and branches are never touched (the revision is exported with
# `git archive` into a cache dir and built there); nothing is installed; no admin rights; no UI (the app is never
# launched, the probe writes zeros to the device and never changes the volume or the default device).
# Output: <out>/summary.json + one log per stage. Exit 0 = no stage FAILED (SKIPPED is not a failure), 1 = a stage
# failed, 2 = usage. Written for /bin/bash 3.2 (macOS): no mapfile, no associative arrays, guarded empty arrays.
set -euo pipefail

ALL_STAGES="tools core probe apple-mac apple-sim"

usage() {  # the header comment above `set -euo pipefail`
  awk 'NR > 1 && /^set -euo/ { exit } NR > 1' "$0" | sed 's/^# \{0,1\}//'
}

die_usage() {
  echo "check.sh: $*" >&2
  echo "run 'bash tools/mac/check.sh --help' for the options" >&2
  exit 2
}

# ---- arguments ---------------------------------------------------------------------------------------------------
rev=""
stage_arg=""
out=""
quick=0
jobs=""
cache_root="${RIG_CHECK_CACHE:-}"
repo=""
src_dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rev|--stage|--out|--jobs|--cache|--repo|--src)
      [ $# -ge 2 ] && [ -n "$2" ] || die_usage "$1 needs a value"
      case "$1" in
        --rev) rev="$2" ;;
        --stage) stage_arg="$2" ;;
        --out) out="$2" ;;
        --jobs) jobs="$2" ;;
        --cache) cache_root="$2" ;;
        --repo) repo="$2" ;;
        --src) src_dir="$2" ;;
      esac
      shift 2 ;;
    --rev=*) rev="${1#*=}"; shift ;;
    --stage=*) stage_arg="${1#*=}"; shift ;;
    --out=*) out="${1#*=}"; shift ;;
    --jobs=*) jobs="${1#*=}"; shift ;;
    --cache=*) cache_root="${1#*=}"; shift ;;
    --repo=*) repo="${1#*=}"; shift ;;
    --src=*) src_dir="${1#*=}"; shift ;;
    --quick) quick=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die_usage "unknown argument '$1'" ;;
  esac
done

if [ "$quick" -eq 1 ] && [ -n "$stage_arg" ]; then die_usage "--quick and --stage cannot be combined"; fi
if [ -n "$src_dir" ] && [ -n "$rev" ]; then die_usage "--src and --rev cannot be combined"; fi
if [ -n "$src_dir" ]; then
  [ -d "$src_dir/native/core" ] || die_usage "--src $src_dir has no native/core"
  src_dir="$(cd "$src_dir" && pwd -P)"
fi
if [ "$quick" -eq 1 ]; then stage_arg="core,apple-mac"; fi
[ -n "$stage_arg" ] || stage_arg="${ALL_STAGES// /,}"
selected=" "
IFS=',' read -r -a _req <<< "$stage_arg"
for s in ${_req[@]+"${_req[@]}"}; do
  case " $ALL_STAGES " in
    *" $s "*) case "$selected" in *" $s "*) ;; *) selected="$selected$s " ;; esac ;;
    *) die_usage "unknown stage '$s' (stages: ${ALL_STAGES// /, })" ;;
  esac
done
[ "$selected" != " " ] || die_usage "--stage is empty"
if [ -n "$jobs" ]; then
  case "$jobs" in *[!0-9]*|0) die_usage "--jobs needs a positive integer" ;; esac
fi
want() { case "$selected" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ---- host basics -------------------------------------------------------------------------------------------------
OS="$(uname -s)"
IS_MAC=0
[ "$OS" = "Darwin" ] && IS_MAC=1
# brew's bin dirs when the calling shell was not a login shell (the push agent may run without them)
for d in /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH="$PATH:$d" ;; esac
done
export PATH
# A CommandLineTools developer dir cannot run xcodebuild; when Xcode.app exists, use it for this process only
# (DEVELOPER_DIR is per process: no `sudo xcode-select`, nothing global changes).
if [ "$IS_MAC" -eq 1 ] && [ -z "${DEVELOPER_DIR:-}" ]; then
  case "$(xcode-select -p 2>/dev/null || true)" in
    *CommandLineTools*|"")
      if [ -d /Applications/Xcode.app/Contents/Developer ]; then
        export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
      fi ;;
  esac
fi
ncpu="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
[ -n "$jobs" ] || jobs="$ncpu"

here="$(cd "$(dirname "$0")" && pwd -P)"
if [ -z "$repo" ]; then
  repo="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null)" || die_usage "not inside a git checkout (use --repo)"
fi
git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || die_usage "--repo $repo is not a git repository"

utc="$(date -u +%Y%m%dT%H%M%SZ)"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -z "$out" ]; then
  if [ -d "$HOME/Projects/worship-rig-v2/outbox" ]; then
    out="$HOME/Projects/worship-rig-v2/outbox/logs/$utc-check"
  else
    out="./mac-check-$utc"
  fi
fi
mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
state="$out/.state"
mkdir -p "$state"

say() { printf '[check %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# ---- JSON helpers (no python/jq on a stock Mac) ------------------------------------------------------------------
json_str() {
  # tabs -> spaces, other control bytes dropped, \ and " escaped, lines joined with \n (sed/awk/tr only: the
  # replacement rules of ${s//...} changed in bash 5.2, and /bin/bash on macOS is 3.2)
  printf '"'
  printf '%s' "$1" | LC_ALL=C tr '\t' ' ' | LC_ALL=C tr -d '\000-\010\013-\037' \
    | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | LC_ALL=C awk 'NR > 1 { printf "%s", "\\n" } { printf "%s", $0 }'
  printf '"'
}
# one JSON string array from the lines of a file (empty lines skipped)
json_lines() {
  local f="$1" first=1 line
  printf '['
  if [ -f "$f" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      [ -n "$line" ] || continue
      [ "$first" -eq 1 ] || printf ','
      first=0
      json_str "$line"
    done < "$f"
  fi
  printf ']'
}

# ---- stage bookkeeping -------------------------------------------------------------------------------------------
# record <stage> <PASS|FAIL|SKIPPED> <seconds> <details> [errors-file] [extra-json-members]
record() {
  local name="$1"
  printf '%s' "$2" > "$state/$name.status"
  printf '%s' "$3" > "$state/$name.seconds"
  printf '%s' "$4" > "$state/$name.details"
  if [ -n "${5:-}" ] && [ -f "$5" ]; then cp "$5" "$state/$name.errors"; else : > "$state/$name.errors"; fi
  printf '%s' "${6:-}" > "$state/$name.extra"
  say "$name: $2 (${3}s) $4"
}
skip() { record "$1" SKIPPED 0 "$2"; }

# first 80 distinct compiler/linker errors of a log, paths relative to the exported tree (= repo paths)
extract_errors() {
  local log="$1" dest="$2"
  grep -E ':[0-9]+:([0-9]+:)? (fatal )?error: |^ld: |^Undefined symbols|^xcodebuild: error|^error: |clang: error|^CMake Error|FAILED: ' \
    "$log" 2>/dev/null | sed -e "s#$src/##g" -e "s#$work/##g" | awk '!seen[$0]++' | head -n 80 > "$dest" || true
}

# ---- timeouts: macOS has no timeout(1) ---------------------------------------------------------------------------
# a process and all its descendants (collected before any is killed: an orphan is re-parented and lost to pgrep -P)
tree_pids() {
  local p="$1" c
  echo "$p"
  for c in $(pgrep -P "$p" 2>/dev/null || true); do tree_pids "$c"; done
}
cur_job=""  # the pid tmo is waiting on, for the TERM/INT/HUP trap
# tmo <seconds> cmd...: runs cmd with stdin from /dev/null (nothing can wait for input), kills its whole process tree
# (xcodebuild -> swift-frontend, cmake -> ninja -> clang) after <seconds>; returns its status, 124 on timeout.
# Output is the caller's: `tmo 600 cmake ... >> "$log" 2>&1`. A function as cmd runs in the background subshell.
tmo() {
  local secs="$1" pid wd rc=0
  shift
  "$@" < /dev/null &
  pid=$!
  cur_job="$pid"
  # shellcheck disable=SC2046  # the pid list is meant to split
  ( sleep "$secs"; echo "timeout" > "$state/.tmo.$pid"; pids="$(tree_pids "$pid")"; kill -TERM $pids
    sleep 5; kill -KILL $pids ) >/dev/null 2>&1 &
  wd=$!
  wait "$pid" || rc=$?
  cur_job=""
  kill_quiet "$wd"
  if [ -f "$state/.tmo.$pid" ]; then
    rm -f "$state/.tmo.$pid"
    echo "check.sh: timed out after ${secs}s: $*" >&2
    return 124
  fi
  return "$rc"
}
kill_quiet() {  # the watchdog subshell and its sleep
  local pids
  pids="$(tree_pids "$1")"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  wait "$1" 2>/dev/null || true
}
# in_dir <dir> cmd...: for tmo, instead of `(cd dir && cmd)` (exec: the timeout's TERM reaches cmd itself)
in_dir() { cd "$1" && shift && exec "$@"; }
# run_timeout <seconds> <log> cmd...: tmo with the output appended to <log>
run_timeout() {
  local secs="$1" log="$2" rc=0
  shift 2
  tmo "$secs" "$@" >> "$log" 2>&1 || rc=$?
  return "$rc"
}

# ---- tools -------------------------------------------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }
first_line() { "$@" 2>/dev/null | head -n 1 || true; }
os_desc=""; cpu_desc=""; cores_desc="$ncpu"
if [ "$IS_MAC" -eq 1 ]; then
  os_desc="macOS $(sw_vers -productVersion 2>/dev/null || echo '?') ($(sw_vers -buildVersion 2>/dev/null || echo '?'))"
  cpu_desc="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo '?')"
  perf="$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || true)"
  eff="$(sysctl -n hw.perflevel1.physicalcpu 2>/dev/null || true)"
  [ -z "$perf" ] || cores_desc="$ncpu ($perf performance + ${eff:-0} efficiency)"
else
  os_desc="$(uname -sr)"
  cpu_desc="$(sed -n 's/^model name[[:space:]]*: //p' /proc/cpuinfo 2>/dev/null | head -n 1)"
  [ -n "$cpu_desc" ] || cpu_desc="$(uname -m)"
fi
arch="$(uname -m)"
v_xcode=""; xcode_note=""
if [ "$IS_MAC" -eq 1 ]; then
  # /usr/bin/xcodebuild is a shim that always exists; it fails without Xcode.app or before the license is accepted
  xv="$(tmo 60 xcodebuild -version 2>&1 || true)"
  v_xcode="$(printf '%s\n' "$xv" | grep -E '^(Xcode [0-9]|Build version)' | tr '\n' ' ' | sed 's/ *$//' || true)"
  if [ -z "$v_xcode" ]; then
    case "$xv" in
      *icense*) xcode_note="Xcode license not accepted: Ryan runs 'sudo xcodebuild -license accept' once" ;;
      *) xcode_note="Xcode not found: install Xcode 15.4+ and open it once ($(printf '%s\n' "$xv" | head -n 1))" ;;
    esac
  fi
fi
v_cmake="$(have cmake && first_line cmake --version || true)"
v_ninja="$(have ninja && first_line ninja --version || true)"
v_xcodegen="$(have xcodegen && first_line xcodegen --version || true)"
v_node="$(have node && first_line node --version || true)"
v_cxx="$(first_line c++ --version)"

missing_brew=""
need_tool() {  # need_tool <command> <brew formula>: appends to missing_brew, returns 1 when absent
  if have "$1"; then return 0; fi
  case " $missing_brew " in *" $2 "*) ;; *) missing_brew="${missing_brew:+$missing_brew }$2" ;; esac
  return 1
}
core_tools_ok=1
need_tool cmake cmake || core_tools_ok=0
need_tool ninja ninja || core_tools_ok=0
apple_tools_ok=1
if [ "$IS_MAC" -eq 1 ]; then
  [ -n "$v_xcode" ] || apple_tools_ok=0
  need_tool xcodegen xcodegen || apple_tools_ok=0
  [ "$core_tools_ok" -eq 1 ] || apple_tools_ok=0
fi
need_tool node node || true  # optional: only the core's unit.params-drift test needs it
brew_line=""
if [ -n "$missing_brew" ]; then
  if [ "$IS_MAC" -eq 1 ]; then brew_line="brew install $missing_brew"
  else brew_line="install: $missing_brew (on the Mac: brew install $missing_brew)"; fi
fi

# ---- summary.json + table (also written when the run is interrupted) ----------------------------------------------
summary="$out/summary.json"
interrupted=""
cur_stage=""  # the stage running now, for the trap
probe_json="$out/probe.json"
export_status="FAIL"; export_details="not reached"; export_secs=0
src=""; work=""; sha=""
finish() {
  {
    printf '{"tool":"tools/mac/check.sh","schema":1,"rev":%s,"sha":%s,"started":%s,"finished":%s,' \
      "$(json_str "$rev")" "$(json_str "$sha")" "$(json_str "$started")" "$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
    printf '"host":{"os":%s,"arch":%s,"cpu":%s,"cores":%s,"xcode":%s,"cxx":%s,"cmake":%s,"ninja":%s,"xcodegen":%s,' \
      "$(json_str "$os_desc")" "$(json_str "$arch")" "$(json_str "$cpu_desc")" "$(json_str "$cores_desc")" \
      "$(json_str "$v_xcode")" "$(json_str "$v_cxx")" "$(json_str "$v_cmake")" "$(json_str "$v_ninja")" \
      "$(json_str "$v_xcodegen")"
    printf '"node":%s,"jobs":%s,"missing_brew":%s},' "$(json_str "$v_node")" "$jobs" "$(json_str "$brew_line")"
    printf '"export":{"status":%s,"seconds":%s,"details":%s,"src":%s},' "$(json_str "$export_status")" \
      "$export_secs" "$(json_str "$export_details")" "$(json_str "$src")"
    printf '"out":%s,"interrupted":%s,"stages":{' "$(json_str "$out")" "$(json_str "$interrupted")"
    firsts=1
    for s in $ALL_STAGES; do
      want "$s" || continue
      [ -f "$state/$s.status" ] || continue
      [ "$firsts" -eq 1 ] || printf ','
      firsts=0
      printf '%s:{"status":%s,"seconds":%s,"details":%s,"log":%s,"errors":' "$(json_str "$s")" \
        "$(json_str "$(cat "$state/$s.status")")" "$(cat "$state/$s.seconds")" \
        "$(json_str "$(cat "$state/$s.details")")" "$(json_str "$s.log")"
      json_lines "$state/$s.errors"
      ex="$(cat "$state/$s.extra" 2>/dev/null || true)"
      [ -z "$ex" ] || printf ',%s' "$ex"
      printf '}'
    done
    printf '},"probe":'
    if want probe && [ -s "$probe_json" ]; then tr -d '\n' < "$probe_json"; else printf 'null'; fi
    printf '}\n'
  } > "$summary"

  fails=0
  echo
  printf '%-10s %-8s %6s  %s\n' STAGE STATUS SECONDS DETAILS
  printf '%-10s %-8s %6s  %s\n' export "$export_status" "$export_secs" "$export_details" | cut -c1-160
  for s in $ALL_STAGES; do
    want "$s" || continue
    [ -f "$state/$s.status" ] || continue
    st="$(cat "$state/$s.status")"
    [ "$st" != FAIL ] || fails=$((fails + 1))
    printf '%-10s %-8s %6s  %s\n' "$s" "$st" "$(cat "$state/$s.seconds")" "$(cat "$state/$s.details")" | cut -c1-160
    if [ "$st" = FAIL ] && [ -s "$state/$s.errors" ]; then
      head -n 3 "$state/$s.errors" | sed 's/^/             ! /' | cut -c1-160
    fi
  done
  [ "$export_status" = PASS ] || fails=$((fails + 1))
  echo
  echo "summary: $summary"
  [ "$fails" -eq 0 ]
}
on_signal() {  # TERM/INT/HUP (e.g. the push agent gives up): stop the running command, still write the summary
  trap - TERM INT HUP
  local pids
  if [ -n "$cur_job" ]; then
    pids="$(tree_pids "$cur_job")"
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
  fi
  interrupted="signal during ${cur_stage:-setup}"
  if [ -n "$cur_stage" ] && [ ! -f "$state/$cur_stage.status" ]; then
    record "$cur_stage" FAIL 0 "interrupted by a signal (partial log: $cur_stage.log)"
  fi
  finish || true
  exit 143
}
trap on_signal TERM INT HUP

if want tools; then
  t0=$SECONDS
  tl="$out/tools.log"
  {
    echo "os:       $os_desc ($arch)"
    echo "cpu:      $cpu_desc, $cores_desc cores"
    echo "xcode:    ${v_xcode:-MISSING} ${DEVELOPER_DIR:+(DEVELOPER_DIR=$DEVELOPER_DIR)}"
    echo "c++:      ${v_cxx:-MISSING}"
    echo "cmake:    ${v_cmake:-MISSING}"
    echo "ninja:    ${v_ninja:-MISSING}"
    echo "xcodegen: ${v_xcodegen:-MISSING}"
    echo "node:     ${v_node:-MISSING (optional: unit.params-drift is not registered without it)}"
    if [ "$IS_MAC" -eq 1 ] && [ -n "$v_xcode" ]; then
      echo "xcode-select -p: $(xcode-select -p 2>/dev/null || echo '?')"
      tmo 60 xcodebuild -showsdks 2>/dev/null | grep -E 'macosx|iphonesimulator|iphoneos' || true
      if ! tmo 60 xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
        echo "NOTE: xcodebuild -checkFirstLaunchStatus is not clean: Ryan runs 'sudo xcodebuild -runFirstLaunch' once"
      fi
    fi
    [ -z "$brew_line" ] || echo "MISSING: $brew_line"
  } > "$tl"
  errs="$state/tools.errlist"
  : > "$errs"
  st=PASS
  det="all tools present"
  [ "$IS_MAC" -eq 1 ] || det="$det (not macOS: Xcode and xcodegen are not needed here)"
  if [ -n "$missing_brew" ]; then
    case " $missing_brew " in
      " node ") det="node missing (optional): $brew_line" ;;
      *) st=FAIL; det="missing: $brew_line"; echo "$brew_line" > "$errs" ;;
    esac
  fi
  if [ "$IS_MAC" -eq 1 ] && [ -z "$v_xcode" ]; then
    st=FAIL; det="$xcode_note; $det"
    echo "$xcode_note" >> "$errs"
  fi
  record tools "$st" $((SECONDS - t0)) "$det" "$errs"
  cat "$tl"
fi

# ---- export the revision (read-only git) -------------------------------------------------------------------------
# only what the builds and tests read: the native tree, the web app (bundled by Xcode, read by tests), docs (bundled),
# test/ (fixtures the core tests load), the golden tools
EXPORT_PATHS="native app docs test tools/golden package.json"
if [ -z "$cache_root" ]; then
  if [ "$IS_MAC" -eq 1 ]; then cache_root="$HOME/Library/Caches/worship-rig-check"
  else cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/worship-rig-check"; fi
fi
mkdir -p "$cache_root"
cache_root="$(cd "$cache_root" && pwd -P)"
t0=$SECONDS
if [ -n "$src_dir" ]; then
  # --src: an uncommitted tree (testing this script, or a change before it is pushed): copied, never built in place
  rev="(tree $src_dir)"
  work="$cache_root/local"
  src="$work/src"
  rm -rf "$src"
  mkdir -p "$src"
  ok=1
  for p in $EXPORT_PATHS; do
    [ -e "$src_dir/$p" ] || continue
    mkdir -p "$src/$(dirname "$p")"
    # build trees and other git-ignored bulk stay behind (native/core/build-*, native/apple/build, node_modules)
    if [ -d "$src_dir/$p" ]; then
      (cd "$src_dir" && tar -cf - --exclude='native/core/build*' --exclude='native/devhost/build*' \
        --exclude='native/apple/build' --exclude='node_modules' --exclude='*.xcodeproj' --exclude='DerivedData' \
        "$p") | tar -xf - -C "$src" || ok=0
    else
      cp "$src_dir/$p" "$src/$p" || ok=0
    fi
  done
  if [ "$ok" -eq 1 ]; then
    export_status=PASS
    export_details="copied $src_dir to $src ($(du -sk "$src" 2>/dev/null | cut -f1) KB)"
  else
    export_details="copy of $src_dir failed"
  fi
else
  if [ -z "$rev" ]; then
    if git -C "$repo" rev-parse --verify -q refs/heads/v2-native >/dev/null; then rev="v2-native"
    elif git -C "$repo" rev-parse --verify -q refs/remotes/origin/v2-native >/dev/null; then rev="origin/v2-native"
    else rev="HEAD"; fi
  fi
  sha="$(git -C "$repo" rev-parse --verify -q "$rev^{commit}" 2>/dev/null || true)"
  if [ -z "$sha" ]; then
    export_details="revision '$rev' not found in $repo"
  else
    sha7="${sha:0:7}"
    work="$cache_root/$sha7"
    src="$work/src"
    if [ -f "$src/.export-ok" ] && [ "$(cat "$src/.export-ok")" = "$sha" ]; then
      export_status=PASS; export_details="reused $src"
    else
      rm -rf "$src" "$src.partial"
      mkdir -p "$src.partial"
      paths=()  # paths absent at older revisions are left out
      for p in $EXPORT_PATHS; do
        if git -C "$repo" cat-file -e "$sha:$p" 2>/dev/null; then paths+=("$p"); fi
      done
      if { git -C "$repo" archive --format=tar "$sha" -- ${paths[@]+"${paths[@]}"} | tar -x -C "$src.partial"; } \
          2> "$out/export.log"; then
        printf '%s' "$sha" > "$src.partial/.export-ok"
        mv "$src.partial" "$src"
        export_status=PASS
        export_details="exported $rev ($sha7) to $src ($(du -sk "$src" 2>/dev/null | cut -f1) KB)"
      else
        export_details="git archive $rev failed (see export.log)"
      fi
    fi
    touch "$work"
    # keep the three most recent revisions (each holds an export plus its build trees)
    # shellcheck disable=SC2012  # names are 7 hex digits (local/ from --src and anything else are left alone)
    ls -1t "$cache_root" 2>/dev/null | grep -E '^[0-9a-f]{7}$' | tail -n +4 | while IFS= read -r old; do
      rm -rf "${cache_root:?}/$old"
    done
  fi
fi
export_secs=$((SECONDS - t0))
say "export: $export_status ($export_details)"
exported=0
[ "$export_status" = PASS ] && exported=1

tree="${work:+$work/build}"
configure_tree() {  # the devhost tree, which also builds the core and its tests (one compile of the core for both)
  local log="$1"
  if [ -f "$tree/build.ninja" ] && grep -q '^DEVHOST_CORE_TESTS:BOOL=ON' "$tree/CMakeCache.txt" 2>/dev/null; then
    return 0
  fi
  run_timeout 600 "$log" cmake -S "$src/native/devhost" -B "$tree" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DDEVHOST_CORE_TESTS=ON
}

# ---- core --------------------------------------------------------------------------------------------------------
if want core; then
  cur_stage=core
  log="$out/core.log"; : > "$log"
  if [ "$exported" -eq 0 ]; then skip core "no exported tree ($export_details)"
  elif [ "$core_tools_ok" -eq 0 ]; then skip core "needs cmake + ninja: $brew_line"
  else
    t0=$SECONDS
    errs="$state/core.errlist"; : > "$errs"
    extra=""
    if ! configure_tree "$log" || ! run_timeout 2400 "$log" cmake --build "$tree" -j "$jobs" \
        --target rig_tests rig_render rig-golden rig_bench; then
      extract_errors "$log" "$errs"
      record core FAIL $((SECONDS - t0)) "configure/build failed ($(wc -l < "$errs" | tr -d ' ') errors)" "$errs"
    else
      exclude="devhost"
      golden_note="goldens compared"
      if [ ! -d "$src/native/golden/out" ]; then
        exclude="devhost|golden"
        golden_note="golden.* not run: native/golden/out is git-ignored, so absent in the export (CI's goldens job renders them for macos-15)"
      fi
      ctl="$out/core.ctest.txt"
      rc=0
      tmo 1800 in_dir "$tree" ctest -LE "$exclude" -j "$jobs" --timeout 900 --output-on-failure > "$ctl" 2>&1 || rc=$?
      cat "$ctl" >> "$log"
      # per test: "name status" from ctest's progress lines
      results="$state/core.results"
      sed -nE 's/^ *[0-9]+\/[0-9]+ Test +#[0-9]+: ([^ ]+) \.*[ *]*(Passed|Failed|Skipped|Timeout|Not Run|Exception|SEGFAULT|Subprocess aborted|Child aborted|Disabled).*/\1 \2/p' \
        "$ctl" > "$results"
      flaky=""
      if [ "$rc" -ne 0 ]; then
        # timing-sensitive tests on a busy machine: one serial rerun of the failures (the lanes' rule), noted as flaky
        rr="$out/core.rerun.txt"
        tmo 1200 in_dir "$tree" ctest --rerun-failed --timeout 900 --output-on-failure > "$rr" 2>&1 || true
        cat "$rr" >> "$log"
        while IFS=' ' read -r name status; do
          [ -n "$name" ] || continue
          if [ "$status" = Passed ]; then
            flaky="${flaky:+$flaky }$name"
            # the rerun result wins for that test
            awk -v n="$name" '$1 == n { print n " Passed"; next } { print }' "$results" > "$results.tmp"
            mv "$results.tmp" "$results"
          fi
        done < <(sed -nE 's/^ *[0-9]+\/[0-9]+ Test +#[0-9]+: ([^ ]+) \.*[ *]*(Passed|Failed|Timeout|Exception|SEGFAULT|Subprocess aborted|Child aborted).*/\1 \2/p' "$rr")
      fi
      # tests that read git-ignored generated data: without it their failure says nothing about this machine
      nodata=""
      if [ ! -d "$src/tools/golden/decode-dump/data/raw44100" ]; then
        for t in unit.samples_decode unit.samples_process unit.samples_service; do
          if grep -q "^$t " "$results" && ! grep -q "^$t Passed$" "$results"; then
            nodata="${nodata:+$nodata }$t"
            awk -v n="$t" '$1 == n { print n " NoData"; next } { print }' "$results" > "$results.tmp"
            mv "$results.tmp" "$results"
          fi
        done
      fi
      total="$(wc -l < "$results" | tr -d ' ')"
      npass="$(grep -c ' Passed$' "$results" || true)"
      nskip="$(grep -c ' Skipped$' "$results" || true)"
      nnodata="$(grep -c ' NoData$' "$results" || true)"
      nfail=$((total - npass - nskip - nnodata))
      grep -v -E ' (Passed|Skipped|NoData)$' "$results" | sed 's/ /: /' > "$errs" || true
      # the doctest assertion lines of the failures, so the cloud sees what broke without the log
      if [ "$nfail" -gt 0 ]; then
        grep -E '(ERROR|FATAL ERROR|CHECK|REQUIRE).*(is NOT correct|failed|threw)|: ERROR: ' "$log" \
          | sed -e "s#$src/##g" | awk '!seen[$0]++' | head -n 40 >> "$errs" || true
      fi
      if [ "$total" -eq 0 ]; then
        echo "ctest ran no tests (exit $rc)" >> "$errs"
        nfail=1
      fi
      tests_json="{"
      firstt=1
      while IFS=' ' read -r name status; do
        [ -n "$name" ] || continue
        [ "$firstt" -eq 1 ] || tests_json="$tests_json,"
        firstt=0
        tests_json="$tests_json$(json_str "$name"):$(json_str "$status")"
      done < "$results"
      tests_json="$tests_json}"
      nodata_note=""
      if [ -n "$nodata" ]; then
        nodata_note="not counted, they need tools/golden/decode-dump/data/raw* (git-ignored; dump.mjs in Chromium)"
        nodata_note="$nodata_note: $nodata"
      fi
      extra="\"tests\":$tests_json,\"flaky\":$(json_str "$flaky"),\"golden\":$(json_str "$golden_note")"
      extra="$extra,\"no_data\":$(json_str "$nodata_note")"
      det="$npass passed, $nfail failed, $nskip skipped of $total (${v_cxx:-?}); $golden_note"
      [ -z "$nodata" ] || det="$det; $nodata_note"
      [ -z "$flaky" ] || det="$det; passed on the serial rerun (flaky): $flaky"
      if [ "$nfail" -eq 0 ]; then record core PASS $((SECONDS - t0)) "$det" "$errs" "$extra"
      else record core FAIL $((SECONDS - t0)) "$det" "$errs" "$extra"; fi
    fi
  fi
fi

# ---- probe -------------------------------------------------------------------------------------------------------
if want probe; then
  cur_stage=probe
  log="$out/probe.log"; : > "$log"
  if [ "$exported" -eq 0 ]; then skip probe "no exported tree ($export_details)"
  elif [ "$core_tools_ok" -eq 0 ]; then skip probe "needs cmake + ninja: $brew_line"
  else
    t0=$SECONDS
    errs="$state/probe.errlist"; : > "$errs"
    if ! configure_tree "$log" || ! run_timeout 2400 "$log" cmake --build "$tree" -j "$jobs" \
        --target rig-probe devhost_tests rig-devhost; then
      extract_errors "$log" "$errs"
      record probe FAIL $((SECONDS - t0)) "devhost build failed" "$errs"
    else
      # the dev host's own tests first (null backend, ~15 s): the probe's plumbing on this machine's compiler
      dh_rc=0
      run_timeout 900 "$log" in_dir "$tree" ctest -L devhost -j "$jobs" --timeout 300 --output-on-failure || dh_rc=$?
      [ "$dh_rc" -eq 0 ] || echo "devhost ctest failed (exit $dh_rc): see probe.log" >> "$errs"
      if [ "$IS_MAC" -eq 1 ]; then
        probe_args=(--out "$probe_json")
        probe_note="default output device (Core Audio), muted"
      else
        probe_args=(--backend null --quick --out "$probe_json")
        probe_note="null backend (not a Mac): plumbing only, the numbers mean nothing"
      fi
      rm -f "$probe_json"
      prc=0
      run_timeout 300 "$log" "$tree/rig-probe" ${probe_args[@]+"${probe_args[@]}"} || prc=$?
      if [ "$prc" -ne 0 ] || [ ! -s "$probe_json" ]; then
        echo "rig-probe exited $prc without a report (see probe.log)" >> "$errs"
        grep -E '^rig-probe: ' "$log" | tail -n 5 >> "$errs" || true
        record probe FAIL $((SECONDS - t0)) "rig-probe failed ($probe_note)" "$errs"
      else
        auto="$(sed -nE 's/.*"auto_voice_limit_suggestion":\{"desktop":([0-9]+).*/\1/p' "$probe_json")"
        d2="$(sed -nE 's/.*"d2_64_frames":\{"measured":[a-z]+,"safe":([a-z]+).*/\1/p' "$probe_json")"
        probe_errs="$(sed -nE 's/.*"errors":\[(.*)\],"seconds_total".*/\1/p' "$probe_json")"
        # one line per error (BSD sed has no \n in replacements: awk splits)
        [ -z "$probe_errs" ] || printf '%s\n' "$probe_errs" \
          | awk '{ n = split($0, a, /","/); for (i = 1; i <= n; i++) { s = a[i]; gsub(/^"|"$/, "", s); print s } }' \
          >> "$errs"
        det="$probe_note; auto voice limit suggestion ${auto:-none}, 64 frames safe: ${d2:-unknown}"
        if [ -s "$errs" ]; then record probe FAIL $((SECONDS - t0)) "$det" "$errs"
        else record probe PASS $((SECONDS - t0)) "$det" "$errs"; fi
      fi
    fi
  fi
fi

# ---- apple-mac / apple-sim ---------------------------------------------------------------------------------------
apple_skip_reason=""
if [ "$IS_MAC" -eq 0 ]; then apple_skip_reason="not macOS ($OS): the Apple stages need Xcode"
elif [ "$exported" -eq 0 ]; then apple_skip_reason="no exported tree ($export_details)"
elif [ "$apple_tools_ok" -eq 0 ]; then
  apple_skip_reason="needs Xcode + cmake + ninja + xcodegen${brew_line:+: $brew_line}"
  [ -n "$v_xcode" ] || apple_skip_reason="$apple_skip_reason ($xcode_note)"
fi

platform_note="no iOS Simulator platform in this Xcode: Ryan decides on 'xcodebuild -downloadPlatform iOS' (several GB)"

# xcode_build <stage> <scheme> <destination> <sdk> <log> [build settings...]: scheme build; XcodeGen writes no shared
# schemes for this project.yml, so if xcodebuild has not auto-created one, fall back to a target build
xcode_build() {
  local stage="$1" scheme="$2" dest="$3" sdk="$4" log="$5"
  shift 5
  local rc=0
  run_timeout 2400 "$log" in_dir "$src/native/apple" xcodebuild -project WorshipRig.xcodeproj -scheme "$scheme" \
    -configuration Debug -destination "$dest" -derivedDataPath "$work/dd-$stage" COMPILER_INDEX_STORE_ENABLE=NO \
    "$@" build || rc=$?
  if [ "$rc" -ne 0 ] && grep -q 'does not contain a scheme named' "$log"; then
    echo "check.sh: no scheme '$scheme'; building the target instead" >> "$log"
    rc=0
    run_timeout 2400 "$log" in_dir "$src/native/apple" xcodebuild -project WorshipRig.xcodeproj -target "$scheme" \
      -configuration Debug -sdk "$sdk" -arch arm64 SYMROOT="$work/sym-$stage" OBJROOT="$work/obj-$stage" \
      COMPILER_INDEX_STORE_ENABLE=NO "$@" build || rc=$?
  fi
  return "$rc"
}

apple_stage() {  # apple_stage <stage> <build-core flags> <scheme> <destination> <sdk> [build settings...]
  local stage="$1" flags="$2" scheme="$3" dest="$4" sdk="$5"
  shift 5
  local log="$out/$stage.log" errs="$state/$stage.errlist" t0=$SECONDS step=""
  cur_stage="$stage"
  : > "$log"; : > "$errs"
  step="build-core.sh $flags"
  # shellcheck disable=SC2086  # $flags is a word list
  if RIG_CMAKE_GENERATOR=Ninja RIG_JOBS="$jobs" run_timeout 2400 "$log" in_dir "$src/native/apple" \
      bash scripts/build-core.sh $flags; then
    step="xcodegen"
    if run_timeout 300 "$log" in_dir "$src/native/apple" xcodegen generate --spec project.yml; then
      step="xcodebuild $scheme"
      if xcode_build "$stage" "$scheme" "$dest" "$sdk" "$log" "$@"; then
        local warn
        warn="$(grep -c ': warning: ' "$log" || true)"
        record "$stage" PASS $((SECONDS - t0)) "$scheme compiled and linked ($dest); $warn compiler warnings" "$errs"
        return 0
      fi
      # Xcode 15+ ships the iOS platform (simulator runtime) as a separate download: without it the generic
      # simulator destination does not resolve. That is a missing install, not a compile error.
      if [ "$sdk" = iphonesimulator ] && grep -qE 'is not installed\. To use with Xcode, first download and install|Unable to find a destination matching' "$log"; then
        record "$stage" SKIPPED $((SECONDS - t0)) "$platform_note" "$errs"
        return 0
      fi
    fi
  fi
  extract_errors "$log" "$errs"
  record "$stage" FAIL $((SECONDS - t0)) "failed at $step ($(wc -l < "$errs" | tr -d ' ') errors captured)" "$errs"
}

if want apple-mac; then
  if [ -n "$apple_skip_reason" ]; then skip apple-mac "$apple_skip_reason"
  else apple_stage apple-mac "--mac-only" WorshipRig-macOS "platform=macOS" macosx CODE_SIGN_IDENTITY=-; fi
fi
if want apple-sim; then
  if [ -n "$apple_skip_reason" ]; then skip apple-sim "$apple_skip_reason"
  elif ! tmo 60 xcodebuild -showsdks 2>/dev/null | grep -q iphonesimulator; then
    skip apple-sim "$platform_note"
  else
    apple_stage apple-sim "--sim --no-device" WorshipRig-iPad "generic/platform=iOS Simulator" iphonesimulator \
      CODE_SIGNING_ALLOWED=NO
  fi
fi

finish
