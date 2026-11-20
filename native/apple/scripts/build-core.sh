#!/usr/bin/env bash
# Build native/core for the Apple slices and wrap them in build/RigCore.xcframework. UNBUILT on Linux.
#   ./scripts/build-core.sh                       macOS arm64 + iPadOS (iphoneos arm64)
#   ./scripts/build-core.sh --sim                 also the iOS simulator slice (arm64)
#   ./scripts/build-core.sh --mac-only            for a quick Mac-only first build
#   ./scripts/build-core.sh --sim --no-device     macOS + simulator, no iphoneos slice (tools/mac/check.sh apple-sim)
# Environment (optional): RIG_CMAKE_GENERATOR (e.g. Ninja; only for a fresh build dir), RIG_JOBS (default: all CPUs).
# Runs under /bin/bash 3.2 (macOS): no mapfile, guarded array expansions.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
core="$here/../core"
out="$here/build"
sim=0; mac_only=0; device=1
for a in ${1+"$@"}; do
  case "$a" in
    --sim) sim=1 ;;
    --mac-only) mac_only=1 ;;
    --no-device) device=0 ;;
    *) echo "unknown flag $a" >&2; exit 2 ;;
  esac
done
[ "$mac_only" -eq 0 ] || device=0

command -v cmake >/dev/null || { echo "cmake not found (brew install cmake)" >&2; exit 1; }
mkdir -p "$out"
jobs="${RIG_JOBS:-$(sysctl -n hw.ncpu)}"

# name  extra-cmake-args...
build_slice() {
  local name="$1"; shift
  local dir="$out/cmake-$name"
  local gen=()
  # a generator can only be chosen for a fresh build dir (CMake refuses to switch an existing one)
  if [ -n "${RIG_CMAKE_GENERATOR:-}" ] && [ ! -f "$dir/CMakeCache.txt" ]; then gen=(-G "$RIG_CMAKE_GENERATOR"); fi
  cmake -S "$core" -B "$dir" ${gen[@]+"${gen[@]}"} -DCMAKE_BUILD_TYPE=Release -DRIG_BUILD_TESTS=OFF "$@"
  cmake --build "$dir" --target rig_core -j "$jobs"
  mkdir -p "$out/lib-$name"
  # rig_core + rig_third_party (+ anything else static it grew) -> one archive per slice
  local libs=() f
  while IFS= read -r f; do libs+=("$f"); done < <(find "$dir" -name '*.a' -not -name 'librig_fixture.a' | sort)
  [ "${#libs[@]}" -gt 0 ] || { echo "no static libraries under $dir" >&2; exit 1; }
  rm -f "$out/lib-$name/librig_core_all.a"
  libtool -static -o "$out/lib-$name/librig_core_all.a" "${libs[@]}"
}

build_slice macos -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=14.5
slices=(-library "$out/lib-macos/librig_core_all.a" -headers "$core/include")

# iOS slices: try_compile as a static library, so CMake's compiler checks need no code signing (README "Expected
# errors")
if [ "$device" -eq 1 ]; then
  build_slice ios -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT=iphoneos -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=17.5 -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY
  slices+=(-library "$out/lib-ios/librig_core_all.a" -headers "$core/include")
fi
if [ "$sim" -eq 1 ]; then
  build_slice iossim -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT=iphonesimulator -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=17.5 -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY
  slices+=(-library "$out/lib-iossim/librig_core_all.a" -headers "$core/include")
fi

rm -rf "$out/RigCore.xcframework"
xcodebuild -create-xcframework "${slices[@]}" -output "$out/RigCore.xcframework"
echo "built $out/RigCore.xcframework"
