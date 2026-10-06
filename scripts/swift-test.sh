#!/bin/bash
# Run Swift package tests with XCTest available, without changing xcode-select.
set -euo pipefail

if [[ $(uname -s) == Darwin ]]; then
  if [[ -z ${DEVELOPER_DIR:-} ]] && ! xcrun --find xctest >/dev/null 2>&1; then
    if [[ -d /Applications/Xcode.app/Contents/Developer ]]; then
      export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
    fi
  fi

  if ! xcrun --find xctest >/dev/null 2>&1; then
    echo 'Swift tests require full Xcode for XCTest. Set DEVELOPER_DIR to its Contents/Developer directory.' >&2
    exit 1
  fi

  exec xcrun swift test "$@"
fi

exec swift test "$@"
