# Shared by scripts/native and scripts/e2e: toolchain paths, the platform list, and booting the two devices.
# IOS_SIMULATOR (default "iPhone 18 Pro") and ANDROID_AVD (default "bay-pixel") pick the devices.

ios_simulator=${IOS_SIMULATOR:-iPhone 18 Pro}
android_avd=${ANDROID_AVD:-bay-pixel}
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}
export JAVA_HOME=${JAVA_HOME:-$(/usr/libexec/java_home -v 17)}
adb=$ANDROID_HOME/platform-tools/adb

# Sets `platforms` from the arguments (ios, android; both when none are given).
parse_platforms() {
  platforms=("$@")
  ((${#platforms[@]})) || platforms=(ios android)
  local platform
  for platform in "${platforms[@]}"; do
    [[ $platform == ios || $platform == android ]] || { echo "unknown platform '$platform' (ios or android)" >&2; exit 2; }
  done
}

# Boots the simulator if needed and prints its UDID.
boot_ios() {
  xcrun simctl bootstatus "$ios_simulator" -b >/dev/null
  xcrun simctl list devices booted -j | python3 -I -c 'import json, sys
name = sys.argv[1]
for devices in json.load(sys.stdin)["devices"].values():
    for d in devices:
        if d["name"] == name:
            print(d["udid"]); raise SystemExit' "$ios_simulator"
}

# Starts the emulator if none is running, waits for boot, forwards Metro's port, and prints its serial.
boot_android() {
  if ! "$adb" devices | grep -q '^emulator-'; then
    "$ANDROID_HOME/emulator/emulator" -avd "$android_avd" -no-audio >/dev/null 2>&1 &
  fi
  "$adb" wait-for-device
  until [[ $("$adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') == 1 ]]; do sleep 2; done
  # A cold boot can leave a "System UI isn't responding" dialog over the app; close system dialogs.
  "$adb" shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true
  "$adb" reverse tcp:8081 tcp:8081 >/dev/null
  "$adb" devices | awk '/^emulator-/ { print $1; exit }'
}
