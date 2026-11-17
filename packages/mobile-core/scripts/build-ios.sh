#!/bin/bash
# Builds the core for iOS into apple/ (git-ignored):
#   lib/<platform>/libbay_core.a   the static library, per Xcode platform (iphoneos, iphonesimulator)
#   include/BayCoreFFI/            UniFFI's C header and module map
#   Sources/BayCore.swift          the generated Swift API
# Run from Xcode (apps/ios's BayCore target) it builds only the platform being built; run by hand it builds both.
# With nothing changed in Rust it takes about a second.
#
# Uses rustup's cargo (~/.cargo/bin), which has the iOS targets; Homebrew's, earlier on PATH, has only the host's.
set -euo pipefail
core=$(cd "$(dirname "$0")/.." && pwd)
out="$core/apple"
profile="${BAY_CORE_PROFILE:-release}"
platforms=${PLATFORM_NAME:-"iphoneos iphonesimulator"}
export PATH="$HOME/.cargo/bin:$PATH"
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-15.0}"
# Xcode's environment points the compilers at the app's SDK; cargo's build scripts compile for the host.
unset SDKROOT LIBRARY_PATH CPATH

command -v cargo >/dev/null || { echo "error: no cargo: install Rust with rustup (https://rustup.rs)" >&2; exit 1; }
dir=$([ "$profile" = dev ] && echo debug || echo "$profile")

# Replaces $2 with $1 only when they differ, so Xcode doesn't recompile or relink after a run with nothing new.
place() { cmp -s "$1" "$2" || { mkdir -p "$(dirname "$2")"; cp "$1" "$2"; }; }

cd "$core"
for platform in $platforms; do
  case "$platform" in
    iphoneos) target=aarch64-apple-ios ;;
    iphonesimulator) target=aarch64-apple-ios-sim ;;
    *) echo "error: build-ios.sh: no Rust target for $platform" >&2; exit 1 ;;
  esac
  rustup target list --installed 2>/dev/null | grep -qx "$target" || rustup target add "$target" >&2
  cargo build --quiet --locked --profile "$profile" --package bay-core --lib --target "$target"
  place "target/$target/$dir/libbay_core.a" "$out/lib/$platform/libbay_core.a"
done

# The bindings come from the host library's metadata, which is the same on every target.
cargo build --quiet --locked --package bay-core --lib
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cargo run --quiet --locked --package uniffi-bindgen -- generate --library target/debug/libbay_core.dylib \
  --language swift --out-dir "$work" >/dev/null
place "$work/BayCoreFFI.h" "$out/include/BayCoreFFI/BayCoreFFI.h"
place "$work/BayCoreFFI.modulemap" "$out/include/BayCoreFFI/module.modulemap"
place "$work/BayCore.swift" "$out/Sources/BayCore.swift"
