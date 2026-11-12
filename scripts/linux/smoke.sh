#!/bin/bash
# Starts Bay (an AppImage, or a staged app's bay-wrapper) on an X display and checks that it opens a window, keeps
# running and that chrome://bay logs no errors. CI runs it under xvfb-run; it needs xdotool.
#
#   scripts/linux/smoke.sh PATH [STARTUP_SECONDS]
#
# This is liveness only: the sandbox's AppArmor setup, GPU and video decoding still need a real desktop.
set -uo pipefail

app=$(readlink -f "$1")
startup=${2:-30}
data=$(mktemp -d -t bay-smoke-XXXXXX)
log="$data/chrome_debug.log"
[[ -x "$app" ]] || { echo "not executable: $app" >&2; exit 2; }
[[ -n "${DISPLAY:-}" ]] || { echo "no X display; run under xvfb-run" >&2; exit 2; }

failure=""
"$app" --user-data-dir="$data" --enable-logging --log-file="$log" --no-first-run about:blank &
pid=$!

window=""
for ((i = 0; i < startup * 4; i++)); do
  sleep 0.25
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid"
    failure="Bay exited during startup with code $?"
    break
  fi
  window=$(xdotool search --class Bay 2>/dev/null | head -1 || true)
  [[ -n "$window" ]] && break
done
if [[ -z "$failure" && -z "$window" ]]; then
  failure="Bay did not create a window in $startup seconds"
fi
if [[ -z "$failure" ]]; then
  # Time for the UI and its coordinator to start, publish and fail if they will.
  sleep 10
  ui_errors=$(grep -c ':ERROR:CONSOLE.*source: chrome://bay' "$log" 2>/dev/null) || true
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid"
    failure="Bay exited after creating its window: $?"
  elif (( ${ui_errors:-0} > 0 )); then
    failure="Bay's UI logged $ui_errors errors; they are listed below"
  fi
fi

if kill -0 "$pid" 2>/dev/null; then
  kill -TERM "$pid" 2>/dev/null
  for ((i = 0; i < 20; i++)); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -KILL "$pid" 2>/dev/null || true
fi
wait "$pid" 2>/dev/null || true
# An AppImage's runtime starts Bay as a child; stop whatever still uses this profile.
pkill -KILL -f -- "--user-data-dir=$data" 2>/dev/null || true

if [[ -f "$log" ]]; then
  echo "Bay's logged errors and console messages (first 200):"
  grep -E 'CONSOLE|:ERROR:|:FATAL:' "$log" | head -200
fi
echo "Smoke profile: $data"
if [[ -n "$failure" ]]; then
  echo "::error::$failure"
  exit 1
fi
echo "Liveness passed: Bay opened a window, kept running and its UI logged no errors"
