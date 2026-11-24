#!/bin/bash
# Builds Bay's desktop Rust library (packages/rust, bay-desktop: the content blocker from packages/adblock and every
# other crate the desktops share) as a static library for the app: packages/rust/target/desktop/libbay_desktop.a, one
# slice per architecture in $ARCHS (Xcode's; default arm64). The BayNNCore pod runs it before compiling and the app
# links the result (BayNNCore.podspec). Cargo's own incremental build makes a run with nothing changed take about a
# second.
#
# Uses rustup's cargo (~/.cargo/bin), which has the Apple targets; Homebrew's, earlier on PATH, has only the host's.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
workspace=$(cd "$here/../../rust" && pwd)
out="$workspace/target/desktop"
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
    *) echo "error: rust.sh: no Rust target for $arch" >&2; exit 1 ;;
  esac
  rustup target list --installed 2>/dev/null | grep -qx "$target" || rustup target add "$target" >&2
  (cd "$workspace" && cargo rustc --quiet --locked --release --package bay-desktop --lib --crate-type staticlib --target "$target")
  slices+=("$workspace/target/$target/release/libbay_desktop.a")
done
mkdir -p "$out"
if [ ${#slices[@]} -eq 1 ]; then
  cmp -s "${slices[0]}" "$out/libbay_desktop.a" || cp "${slices[0]}" "$out/libbay_desktop.a"
else
  lipo -create "${slices[@]}" -output "$out/libbay_desktop.a.new"
  if cmp -s "$out/libbay_desktop.a.new" "$out/libbay_desktop.a"; then rm "$out/libbay_desktop.a.new"; else mv "$out/libbay_desktop.a.new" "$out/libbay_desktop.a"; fi
fi
