#!/bin/bash
# Compile the real writer against the actual bridge headers with mocked engine callbacks.
set -euo pipefail
cd "$(dirname "$0")/../.."
scratch=$(mktemp -d "${TMPDIR:-/tmp}/bay-extension-writer.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
mock=scripts/native-writer-tests
bridge=../nncore/ios
xcrun clang -fobjc-arc -fmodules -Wno-incomplete-implementation -Wno-objc-property-implementation \
  -I "$bridge" -I "$mock" -c "$mock/MockControl.m" -o "$scratch/mock.o"
xcrun swiftc -parse-as-library -I "$mock" -Xcc -I -Xcc "$bridge" \
  ios/Core/*.swift ios/ExtensionImportWriter.swift "$mock/WriterTests.swift" "$scratch/mock.o" \
  -framework Foundation -framework AppKit -framework Security -lsqlite3 -o "$scratch/tests"
"$scratch/tests"
