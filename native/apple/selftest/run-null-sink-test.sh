#!/usr/bin/env bash
# Build and run null_sink_test.c (E4) against a native/core build: the self-test's null output on the real realtime
# core, on Linux or macOS. No Xcode needed.
#   bash native/apple/selftest/run-null-sink-test.sh [<core build dir containing librig_core.a>]
# Default build dir: native/core/build/release (cmake --preset release). Builds into a temp dir; writes nothing else.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
root="$(cd "$here/../../.." && pwd -P)"
bdir="${1:-$root/native/core/build/release}"
if [ ! -f "$bdir/librig_core.a" ]; then
  echo "no librig_core.a in $bdir (cmake --preset release && cmake --build ...)" >&2
  exit 2
fi
cc="${CC:-cc}"
cxx="${CXX:-c++}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
inc=(-I "$root/native/core/include" -I "$root/native/apple/Sources/Audio")
"$cc" -std=c11 -O2 -Wall -Wextra -Werror -pthread "${inc[@]}" \
  -c "$root/native/apple/Sources/Audio/rig_apple_null_sink.c" -o "$tmp/sink.o"
"$cc" -std=c11 -O2 -Wall -Wextra -Werror -pthread "${inc[@]}" -c "$here/null_sink_test.c" -o "$tmp/test.o"
libs=("$bdir/librig_core.a")
[ -f "$bdir/librig_third_party.a" ] && libs+=("$bdir/librig_third_party.a")
extra=()
[ "$(uname -s)" = Linux ] && extra+=(-ldl)
"$cxx" -pthread "$tmp/test.o" "$tmp/sink.o" "${libs[@]}" ${extra[@]+"${extra[@]}"} -lm -o "$tmp/null_sink_test"
"$tmp/null_sink_test" "$root/app"
