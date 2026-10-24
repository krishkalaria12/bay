#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Point at an existing BoringSSL build to check the production dependency.
if [[ -n ${BORINGSSL_ROOT:-} ]]; then
  crypto_flags=("-I$BORINGSSL_ROOT/include" "${BORINGSSL_CRYPTO_LIBRARY:?set BORINGSSL_CRYPTO_LIBRARY to libcrypto.a}" -pthread)
else
  crypto_flags=(-lcrypto)
fi
"${CXX:-c++}" -std=c++17 -Wall -Wextra -Werror \
  -Iengine/chromium/src/chrome/browser/bay/data/vendor \
  packages/sync/windows/SyncCrypto.cpp \
  packages/sync/linux/SyncCryptoLinux.cpp \
  packages/sync/windows/tests/LinuxCrypto.cpp \
  "${crypto_flags[@]}" -o "$tmp/check"
"$tmp/check" packages/sync/windows/tests/golden.json "$tmp/vault"
