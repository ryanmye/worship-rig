#!/usr/bin/env bash
# Build native/core for the Apple slices and wrap them in build/RigCore.xcframework. UNBUILT on Linux.
#   ./scripts/build-core.sh            macOS arm64 + iPadOS (iphoneos arm64)
#   ./scripts/build-core.sh --sim      also the iOS simulator slice (arm64)
#   ./scripts/build-core.sh --mac-only for a quick Mac-only first build
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
core="$here/../core"
out="$here/build"
sim=0; mac_only=0
for a in "$@"; do
  case "$a" in
    --sim) sim=1 ;;
    --mac-only) mac_only=1 ;;
    *) echo "unknown flag $a" >&2; exit 2 ;;
  esac
done

command -v cmake >/dev/null || { echo "cmake not found (brew install cmake)" >&2; exit 1; }
mkdir -p "$out"

# name  extra-cmake-args...
build_slice() {
  local name="$1"; shift
  local dir="$out/cmake-$name"
  cmake -S "$core" -B "$dir" -DCMAKE_BUILD_TYPE=Release -DRIG_BUILD_TESTS=OFF "$@"
  cmake --build "$dir" --target rig_core -j "$(sysctl -n hw.ncpu)"
  mkdir -p "$out/lib-$name"
  # rig_core + rig_third_party (+ anything else static it grew) -> one archive per slice
  libtool -static -o "$out/lib-$name/librig_core_all.a" $(find "$dir" -name '*.a' -not -name 'librig_fixture.a')
}

build_slice macos -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=14.5
slices=(-library "$out/lib-macos/librig_core_all.a" -headers "$core/include")

if [ "$mac_only" -eq 0 ]; then
  build_slice ios -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT=iphoneos -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=17.5
  slices+=(-library "$out/lib-ios/librig_core_all.a" -headers "$core/include")
fi
if [ "$sim" -eq 1 ]; then
  build_slice iossim -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT=iphonesimulator -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=17.5
  slices+=(-library "$out/lib-iossim/librig_core_all.a" -headers "$core/include")
fi

rm -rf "$out/RigCore.xcframework"
xcodebuild -create-xcframework "${slices[@]}" -output "$out/RigCore.xcframework"
echo "built $out/RigCore.xcframework"
