"""Build and run Bay's own Windows or Linux unit tests in the engine tree, within the time a CI stage has left.

They catch what only those builds show: every Windows document was once saved empty because clang-cl, like MSVC,
evaluates arguments right to left, which document_store_unittests catches by reading a file back.

    python scripts/windows/unit-tests.py --root D:\\be --minutes 40
    python scripts/windows/unit-tests.py --platform linux --root /engine/be --minutes 40
"""

import argparse
import pathlib
import subprocess
import sys
import time

# Every Bay test target both builds (bay/core/BUILD.gn, chrome/browser/bay/BUILD.gn and webui/BUILD.gn). Those on Chrome's
# test support build Chrome's own WebUI tests too, which chromium-webui-tests-ungoogled.patch keeps compiling.
SHARED_TESTS = [
    "bay_core_unittests",
    "clear_specks_unittests",
    "content_blocker_rules_unittests",
    "crash_reports_unittests",
    "default_browser_unittests",
    "document_store_unittests",
    "keychain_unittests",
    "local_files_unittests",
    "native_file_drag_unittests",
    "native_host_unittests",
    "notifications_unittests",
    "pip_platform_unittests",
    "runtime_unittests",
    "search_suggestions_policy_unittests",
    "shell_appearance_unittests",
    "shell_clipboard_unittests",
    "shell_ui_options_unittests",
    "shortcut_recorder_unittests",
    "window_key_watch_unittests",
    "window_placement_unittests",
]
TESTS = {
    "win": SHARED_TESTS,
    "linux": sorted(SHARED_TESTS + [
        "app_services_linux_unittests",
        "autostart_linux_unittests",
        "external_apps_linux_unittests",
        "frame_linux_unittests",
        "quit_shortcut_linux_unittests",
        "secret_storage_linux_unittests",
        "shell_files_unittests",
        "sync_ui_linux_unittests",
        "window_button_layout_linux_unittests",
    ]),
}
OUTPUT_DIRECTORY = "out/Release_GN_x64"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--platform", choices=sorted(TESTS), default="win")
    parser.add_argument("--root", type=pathlib.Path, required=True, help="the engine root (ENGINE_ROOT)")
    parser.add_argument("--minutes", type=float, required=True, help="the time left for building and running them")
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args(argv)
    deadline = time.monotonic() + args.minutes * 60
    src = args.root / "chromium_git/chromium/src"
    out = src / OUTPUT_DIRECTORY
    windows = args.platform == "win"
    ninja = src / ("third_party/ninja/ninja.exe" if windows else "third_party/ninja/ninja")
    # One unknown name would stop ninja building any of them.
    listing = subprocess.run([str(ninja), "-C", str(out), "-t", "targets", "all"], cwd=src, capture_output=True,
                             text=True, check=True).stdout
    known = {line.split(":", 1)[0] for line in listing.splitlines()}
    wanted = TESTS[args.platform]
    tests = [test for test in wanted if test in known]
    failed = [f"{test} (not a target in this build)" for test in wanted if test not in known]
    try:
        # -k 0: every target that can build does, and every one that can't says why in one run.
        built = subprocess.run([str(ninja), "-C", str(out), "-k", "0", "-j", str(args.jobs), *tests], cwd=src,
                               timeout=max(60.0, deadline - time.monotonic())).returncode == 0
    except subprocess.TimeoutExpired:
        # Ninja keeps what it built: the saved tree carries it to the next run.
        print("Bay's unit tests didn't finish building in the time left; the next run goes on from here")
        return 0
    if not built:
        failed.append("the build (its errors are above)")
    for test in tests:
        binary = out / (f"{test}.exe" if windows else test)
        if not binary.exists():
            failed.append(f"{test} (didn't build)")
            continue
        left = deadline - time.monotonic()
        if left <= 0:
            print(f"Out of time before {test}")
            break
        print(f"::group::{test}", flush=True)
        try:
            if windows:
                # Chromium's test suite refuses to start at a background priority, which these would inherit on CI.
                code = subprocess.run([str(binary)], cwd=out, timeout=left,
                                      creationflags=subprocess.NORMAL_PRIORITY_CLASS).returncode
            else:
                # The runner has no display: Chromium's own wrapper starts Xvfb, a window manager and a D-Bus session.
                code = subprocess.run([sys.executable, str(src / "testing/xvfb.py"), str(binary)], cwd=out,
                                      timeout=left).returncode
        except subprocess.TimeoutExpired:
            code = "timed out"
        print("::endgroup::", flush=True)
        if code != 0:
            failed.append(f"{test} ({code})")
    if failed:
        print("Failed: " + ", ".join(failed))
        return 1
    print(f"Bay's {'Windows' if windows else 'Linux'} unit tests passed: {', '.join(tests)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
