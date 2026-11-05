#!/bin/bash
# Builds Bay's content blocker (packages/adblock, the Rust crate the mobile app uses too) as a static library for the
# desktop app: target/desktop/libbay_adblock.a, one slice per architecture in $ARCHS (Xcode's; default arm64). The
# BayNNCore pod runs it before compiling and the app links the result (BayNNCore.podspec). Cargo's own incremental
# build makes a run with nothing changed take about a second.
#
# Uses rustup's cargo (~/.cargo/bin), which has the Apple targets; Homebrew's, earlier on PATH, has only the host's.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
crate=$(cd "$here/../../adblock" && pwd)
out="$crate/target/desktop"
export PATH="$HOME/.cargo/bin:$PATH"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
# Xcode's environment points the compilers at its SDK for the app; cargo's build scripts compile for the host.
unset SDKROOT LIBRARY_PATH CPATH

command -v cargo >/dev/null || { echo "error: no cargo: install Rust with rustup (https://rustup.rs)" >&2; exit 1; }
slices=()
for arch in ${ARCHS:-arm64}; do
  case "$arch" in
    arm64) target=aarch64-apple-darwin ;;
    x86_64) target=x86_64-apple-darwin ;;
    *) echo "error: adblock.sh: no Rust target for $arch" >&2; exit 1 ;;
  esac
  rustup target list --installed 2>/dev/null | grep -qx "$target" || rustup target add "$target" >&2
  (cd "$crate" && cargo rustc --quiet --locked --release --lib --crate-type staticlib --target "$target")
  slices+=("$crate/target/$target/release/libbay_adblock.a")
done
mkdir -p "$out"
if [ ${#slices[@]} -eq 1 ]; then
  cmp -s "${slices[0]}" "$out/libbay_adblock.a" || cp "${slices[0]}" "$out/libbay_adblock.a"
else
  lipo -create "${slices[@]}" -output "$out/libbay_adblock.a.new"
  if cmp -s "$out/libbay_adblock.a.new" "$out/libbay_adblock.a"; then rm "$out/libbay_adblock.a.new"; else mv "$out/libbay_adblock.a.new" "$out/libbay_adblock.a"; fi
fi
