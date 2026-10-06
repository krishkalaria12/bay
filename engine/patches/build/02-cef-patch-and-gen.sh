#!/usr/bin/env bash
# Step 2: our CEF patches, translated API files and CEF's Chromium patches.
# GN generation waits until step 4 has installed Bay's source targets and BRANDING file.
set -euo pipefail
source ~/chromium-build/scripts/env.sh
series="$NN_REPO/engine/patches/series.py"
# The base `series.py check` compares against: CEF's files as the series finds them (once per checkout).
python3 "$series" capture-base --phase cef
python3 "$series" apply --phase cef
cd "$CB/chromium_git/chromium/src/cef"
lowprio_net python3 tools/version_manager.py -u --fast-check
lowprio_net python3 tools/patcher.py
