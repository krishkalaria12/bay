#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Point at an existing BoringSSL build to check the production dependency.
if [[ -n ${BORINGSSL_ROOT:-} ]]; then
  crypto_flags=("-I$BORINGSSL_ROOT/include" "${BORINGSSL_CRYPTO_LIBRARY:?set BORINGSSL_CRYPTO_LIBRARY to libcrypto.a}" -pthread)
elif command -v pkg-config >/dev/null && pkg-config --exists openssl; then
  read -r -a crypto_flags <<<"$(pkg-config --cflags --libs openssl)"
else
  crypto_flags=(-lcrypto)
fi
platform_flags=()
if [[ $(uname -s) == Darwin ]]; then
  # Compile Linux crypto policy on macOS without claiming a Linux binary.
  platform_flags=(-DBAY_SYNC_LINUX_TEST)
fi
# The sync format (keys, sealed files, the recovery phrase) is bay-sync's, in Bay's desktop Rust library.
# The helper shell-quotes its output (paths may hold spaces), so let the shell parse it.
eval "rust_flags=($(python3 scripts/lib/rust_desktop.py))"
"${CXX:-c++}" -std=c++17 -Wall -Wextra -Werror "${platform_flags[@]}" \
  -Iengine/chromium/src/chrome/browser/bay/data/vendor \
  packages/sync/portable/SyncCrypto.cpp \
  packages/sync/linux/SyncCryptoLinux.cpp \
  packages/sync/portable/tests/LinuxCrypto.cpp \
  "${crypto_flags[@]}" "${rust_flags[@]}" -o "$tmp/check"
"$tmp/check" packages/sync/fixtures/golden.json "$tmp/vault"
