#!/bin/bash
# Builds the core for iOS: apple/BayCoreFFI.xcframework (the static library for the device and the arm64 simulator,
# with UniFFI's C header) and apple/Sources/BayCore.swift (the generated Swift API). apps/ios runs it before every
# build; with nothing changed it takes about a second.
#
# Uses rustup's cargo (~/.cargo/bin), which has the iOS targets; Homebrew's, earlier on PATH, has only the host's.
set -euo pipefail
core=$(cd "$(dirname "$0")/.." && pwd)
out="$core/apple"
profile="${BAY_CORE_PROFILE:-release}"
export PATH="$HOME/.cargo/bin:$PATH"
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-15.0}"
# Xcode's environment points the compilers at the app's SDK; cargo's build scripts compile for the host.
unset SDKROOT LIBRARY_PATH CPATH

command -v cargo >/dev/null || { echo "error: no cargo: install Rust with rustup (https://rustup.rs)" >&2; exit 1; }
targets=(aarch64-apple-ios aarch64-apple-ios-sim)
for target in "${targets[@]}"; do
  rustup target list --installed 2>/dev/null | grep -qx "$target" || rustup target add "$target" >&2
done

cd "$core"
for target in "${targets[@]}"; do
  cargo build --quiet --locked --profile "$profile" --package bay-core --lib --target "$target"
done
# The bindings come from the host library's metadata, which is the same on every target.
cargo build --quiet --locked --package bay-core --lib
dir=$([ "$profile" = dev ] && echo debug || echo "$profile")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cargo run --quiet --locked --package uniffi-bindgen -- generate --library target/debug/libbay_core.dylib \
  --language swift --out-dir "$work/bindings" >/dev/null
mkdir -p "$work/headers"
cp "$work/bindings/BayCoreFFI.h" "$work/headers/"
cp "$work/bindings/BayCoreFFI.modulemap" "$work/headers/module.modulemap"

xcodebuild -create-xcframework \
  -library "target/aarch64-apple-ios/$dir/libbay_core.a" -headers "$work/headers" \
  -library "target/aarch64-apple-ios-sim/$dir/libbay_core.a" -headers "$work/headers" \
  -output "$work/BayCoreFFI.xcframework" >/dev/null

mkdir -p "$out/Sources"
# Replace only what changed, so Xcode doesn't relink or recompile after a run with nothing new.
if ! diff -rq "$work/BayCoreFFI.xcframework" "$out/BayCoreFFI.xcframework" >/dev/null 2>&1; then
  rm -rf "$out/BayCoreFFI.xcframework"
  mv "$work/BayCoreFFI.xcframework" "$out/"
fi
cmp -s "$work/bindings/BayCore.swift" "$out/Sources/BayCore.swift" || cp "$work/bindings/BayCore.swift" "$out/Sources/BayCore.swift"
