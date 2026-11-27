#!/usr/bin/env bash
# Build and package the 2.x macOS Release app (lane N10, MAC_CHECK.md "2.0 release checklist" B3 / steps 2-3).
# UNRUN as written: no Mac on the box it was written on; its first run is release-native.yml's first dispatch.
#
#   bash native/apple/scripts/package-release.sh [--out <dir>] [--expect-version X.Y.Z] [--clean] [--app <path>]
#
#   (default)              build-core.sh --mac-only, xcodegen, xcodebuild WorshipRig-macOS -configuration Release
#                          (arm64, ad-hoc), then package
#   --app <path>           package an already built "Worship Rig.app" instead of building (it is re-signed ad hoc)
#   --out <dir>            where the files go (default native/apple/build/release-dist)
#   --expect-version <v>   fail unless the bundle's CFBundleShortVersionString is <v> (release-native.yml passes the
#                          tag without its "v" on a tag ref)
#   --clean                rm -rf native/apple/build first (the RigCore xcframework, CMake trees, DerivedData)
#
# Output in <out>: Worship-Rig-arm64.zip and Worship-Rig-arm64.dmg (the names 1.1's update check offers:
# update-check.js pickAsset, `Worship-Rig-<arch>.dmg`, else `.zip`), SHA256SUMS, release.json (version, build,
# identifier, signature, sizes, sha256), release-summary.md (a table for $GITHUB_STEP_SUMMARY) and app-path.txt (the
# built app, for `tools/mac/check.sh --stage selftest --app`).
# Signing is 1.x's: ad hoc (`codesign --force --deep --sign -`, build/afterPack.js), no hardened runtime, not
# notarized. Gates: arm64 only, Signature=adhoc, identifier com.ryanmye.worshiprig.native, the web app is in the
# bundle, nothing from My Samples / sound packs is, app size <= 480 MB (CLAUDE.md "Size budget": 500 MB rule, the
# same 480 MB line build-lint uses; warns above 400 MB), the zip and the dmg each hold an app that verifies.
# Exit 0 = packaged, 1 = a gate failed, 2 = usage. Written for /bin/bash 3.2 (macOS).
set -euo pipefail

usage() { awk 'NR > 1 && /^set -euo/ { exit } NR > 1' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "package-release: $*" >&2; exit 1; }
die_usage() { echo "package-release: $*" >&2; echo "run with --help for the options" >&2; exit 2; }

here="$(cd "$(dirname "$0")/.." && pwd -P)"  # native/apple
out=""
expect=""
clean=0
app_in=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out|--expect-version|--app)
      [ $# -ge 2 ] && [ -n "$2" ] || die_usage "$1 needs a value"
      case "$1" in
        --out) out="$2" ;;
        --expect-version) expect="$2" ;;
        --app) app_in="$2" ;;
      esac
      shift 2 ;;
    --clean) clean=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die_usage "unknown argument '$1'" ;;
  esac
done
[ "$(uname -s)" = Darwin ] || die "needs macOS (Xcode, codesign, hdiutil)"
case "$expect" in ""|[0-9]*) ;; *) die_usage "--expect-version '$expect' is not X.Y.Z (no leading v)" ;; esac

NAME="Worship-Rig-arm64"
BUNDLE_ID="com.ryanmye.worshiprig.native"
MAX_MB=480
COMFORT_MB=400

say() { printf '[package-release %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

if [ "$clean" -eq 1 ]; then
  [ -z "$app_in" ] || die_usage "--clean and --app cannot be combined"
  say "rm -rf $here/build"
  rm -rf "$here/build"
fi
[ -n "$out" ] || out="$here/build/release-dist"
mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
work="$here/build/release-work"
rm -rf "$work"
mkdir -p "$work"
rm -f "$out/$NAME.zip" "$out/$NAME.dmg" "$out/SHA256SUMS" "$out/release.json" "$out/release-summary.md" \
  "$out/app-path.txt"

# ---- build -------------------------------------------------------------------------------------------------------
if [ -n "$app_in" ]; then
  [ -d "$app_in" ] || die "--app $app_in is not a directory"
  app="$(cd "$app_in" && pwd -P)"
else
  command -v xcodegen >/dev/null || die "xcodegen not found (brew install xcodegen)"
  say "build-core.sh --mac-only (Release core, arm64)"
  (cd "$here" && RIG_CMAKE_GENERATOR="${RIG_CMAKE_GENERATOR:-Ninja}" bash scripts/build-core.sh --mac-only)
  say "xcodegen"
  (cd "$here" && xcodegen generate --spec project.yml)
  dd="$here/build/dd-release"
  rm -rf "$dd" "$here/build/sym-release" "$here/build/obj-release"
  log="$work/xcodebuild.log"
  say "xcodebuild WorshipRig-macOS -configuration Release (log: $log)"
  rc=0
  # ARCHS=arm64: the xcframework has arm64 slices only (build-core.sh), so an x86_64 half could never link
  (cd "$here" && xcodebuild -project WorshipRig.xcodeproj -scheme WorshipRig-macOS -configuration Release \
    -destination 'platform=macOS' -derivedDataPath "$dd" CODE_SIGN_IDENTITY=- ARCHS=arm64 ONLY_ACTIVE_ARCH=NO \
    COMPILER_INDEX_STORE_ENABLE=NO build) > "$log" 2>&1 || rc=$?
  app="$dd/Build/Products/Release/Worship Rig.app"
  if [ "$rc" -ne 0 ] && grep -q 'does not contain a scheme named' "$log"; then
    # XcodeGen writes no shared schemes for this project.yml; the same fallback as tools/mac/check.sh xcode_build
    say "no scheme WorshipRig-macOS: building the target instead"
    rc=0
    (cd "$here" && xcodebuild -project WorshipRig.xcodeproj -target WorshipRig-macOS -configuration Release \
      -sdk macosx -arch arm64 SYMROOT="$here/build/sym-release" OBJROOT="$here/build/obj-release" \
      CODE_SIGN_IDENTITY=- ONLY_ACTIVE_ARCH=NO COMPILER_INDEX_STORE_ENABLE=NO build) >> "$log" 2>&1 || rc=$?
    app="$here/build/sym-release/Release/Worship Rig.app"
  fi
  if [ "$rc" -ne 0 ]; then
    grep -E ':[0-9]+:([0-9]+:)? (fatal )?error: |^ld: |^Undefined symbols|^xcodebuild: error|^error: ' "$log" \
      | awk '!seen[$0]++' | head -n 40 >&2 || true
    tail -n 30 "$log" >&2
    die "xcodebuild Release failed (exit $rc; log $log)"
  fi
  cp "$log" "$out/xcodebuild-release.log"
fi
exe="$app/Contents/MacOS/Worship Rig"
[ -x "$exe" ] || die "no executable at $exe"
say "app: $app"
printf '%s\n' "$app" > "$out/app-path.txt"

# ---- sign (ad hoc, as 1.x's build/afterPack.js) and check the bundle ---------------------------------------------
plist="$app/Contents/Info.plist"
pb() { "${PLISTBUDDY:-/usr/libexec/PlistBuddy}" -c "Print :$1" "$plist" 2>/dev/null || true; }
version="$(pb CFBundleShortVersionString)"
build="$(pb CFBundleVersion)"
ident="$(pb CFBundleIdentifier)"
say "bundle: $ident $version ($build)"
[ "$ident" = "$BUNDLE_ID" ] || die "CFBundleIdentifier is '$ident', expected $BUNDLE_ID"
# shellcheck disable=SC2016  # a literal "$(": an unexpanded build setting
case "$version" in *'$('*|"") die "CFBundleShortVersionString is '$version' (a build setting left unexpanded?)" ;; esac
if [ -n "$expect" ] && [ "$version" != "$expect" ]; then
  die "the bundle says version $version, expected $expect (project.yml MARKETING_VERSION; MAC_CHECK step 7)"
fi

archs="$(lipo -archs "$exe")"
[ "$archs" = arm64 ] || die "executable architectures are '$archs', expected arm64 only"
[ -f "$app/Contents/Resources/app/index.html" ] || die "the web app is not in the bundle (Resources/app/index.html)"
# CLAUDE.md: My Samples, GarageBand conversions, pack songs and sound-pack audio never ship in the app
leak="$(find "$app" \( -name 'user-samples' -o -name 'sound-packs' -o -name '*.exs' \) -print 2>/dev/null | head -n 5)"
[ -z "$leak" ] || die "personal or pack content in the bundle: $leak"

say "codesign --force --deep --sign - (ad hoc)"
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
sig="$(codesign -dv "$app" 2>&1 || true)"
signature="$(printf '%s\n' "$sig" | sed -n 's/^Signature=//p' | head -n 1)"
sig_ident="$(printf '%s\n' "$sig" | sed -n 's/^Identifier=//p' | head -n 1)"
[ "$signature" = adhoc ] || die "codesign says Signature='$signature', expected adhoc"
[ "$sig_ident" = "$BUNDLE_ID" ] || die "codesign says Identifier='$sig_ident', expected $BUNDLE_ID"

app_kb="$(du -sk "$app" | cut -f1)"
app_mb=$((app_kb / 1024))
say "app size: $app_mb MB"
if [ "$app_mb" -gt "$MAX_MB" ]; then die "Worship Rig.app is $app_mb MB (> $MAX_MB MB; CLAUDE.md size budget)"; fi
size_note="under the $COMFORT_MB MB comfort zone"
if [ "$app_mb" -gt "$COMFORT_MB" ]; then
  size_note="above the $COMFORT_MB MB comfort zone (limit $MAX_MB)"
  echo "::warning title=App size::Worship Rig.app is $app_mb MB, $size_note"
fi

# ---- zip + dmg -----------------------------------------------------------------------------------------------------
zip="$out/$NAME.zip"
dmg="$out/$NAME.dmg"
say "ditto -> $NAME.zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
stage="$work/dmg"
mkdir -p "$stage"
ditto "$app" "$stage/Worship Rig.app"
ln -s /Applications "$stage/Applications"
say "hdiutil create -> $NAME.dmg"
ok=0
# hdiutil create sometimes fails with "Resource busy" on CI runners: up to three tries
for try in 1 2 3; do
  if hdiutil create -volname "Worship Rig" -srcfolder "$stage" -ov -format UDZO "$dmg"; then ok=1; break; fi
  say "hdiutil create failed (try $try of 3)"
  sleep 10
done
[ "$ok" -eq 1 ] || die "hdiutil create failed three times"

# each file holds an app that still verifies (catches a zip that dropped the signature or a broken image)
say "checking the zip and the dmg"
mkdir -p "$work/unzip"
ditto -x -k "$zip" "$work/unzip"
codesign --verify --deep --strict "$work/unzip/Worship Rig.app" || die "the app in $NAME.zip does not verify"
hdiutil verify "$dmg" > /dev/null || die "hdiutil verify $NAME.dmg failed"
mnt="$work/mnt"
mkdir -p "$mnt"
hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$dmg" > /dev/null || die "cannot attach $NAME.dmg"
dmg_ok=1
codesign --verify --deep --strict "$mnt/Worship Rig.app" || dmg_ok=0
[ -L "$mnt/Applications" ] || dmg_ok=0
hdiutil detach "$mnt" > /dev/null 2>&1 || hdiutil detach -force "$mnt" > /dev/null 2>&1 || true
[ "$dmg_ok" -eq 1 ] || die "the dmg's app does not verify, or its Applications link is missing"

# ---- sizes, sha256, summary --------------------------------------------------------------------------------------
(cd "$out" && shasum -a 256 "$NAME.dmg" "$NAME.zip" > SHA256SUMS)
bytes() { wc -c < "$1" | tr -d ' '; }
sha() { awk -v n="$1" '$2 == n { print $1 }' "$out/SHA256SUMS"; }
dmg_b="$(bytes "$dmg")"
zip_b="$(bytes "$zip")"
commit="$(git -C "$here" rev-parse HEAD 2>/dev/null || echo unknown)"
xcode="$(xcodebuild -version 2>/dev/null | head -n 1 || true)"
cat > "$out/release.json" <<EOF
{"tool":"package-release.sh","schema":1,"commit":"$commit","version":"$version","build":"$build",
 "identifier":"$ident","signature":"$signature","arch":"$archs","xcode":"$xcode",
 "app":{"kb":$app_kb,"mb":$app_mb,"limit_mb":$MAX_MB},
 "files":[{"name":"$NAME.dmg","bytes":$dmg_b,"sha256":"$(sha "$NAME.dmg")"},
          {"name":"$NAME.zip","bytes":$zip_b,"sha256":"$(sha "$NAME.zip")"}]}
EOF
mb() { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1048576 }'; }
{
  echo "### Worship Rig $version ($build), macOS arm64, ad-hoc signed"
  echo
  echo "| file | size | sha256 |"
  echo "|---|---|---|"
  echo "| Worship Rig.app (installed) | $app_mb MB ($size_note) | |"
  echo "| $NAME.dmg | $(mb "$dmg_b") MB | \`$(sha "$NAME.dmg")\` |"
  echo "| $NAME.zip | $(mb "$zip_b") MB | \`$(sha "$NAME.zip")\` |"
  echo
  echo "commit \`$commit\`, $xcode, identifier \`$ident\`, Signature=$signature"
} > "$out/release-summary.md"
cat "$out/release-summary.md"
say "packaged into $out"
