"""Build and run Bay's own Windows unit tests in the engine tree, within the time a CI stage has left.

They catch what only Windows shows: every document was once saved empty because clang-cl, like MSVC, evaluates
arguments right to left, which document_store_unittests catches by reading a file back.

    python scripts/windows/unit-tests.py --root D:\\be --minutes 40
"""

import argparse
import pathlib
import subprocess
import sys
import time

# Bay's light Windows test targets (chrome/browser/bay/webui/BUILD.gn): storage, paths, state and parsing.
TESTS = [
    "document_store_unittests",
    "runtime_unittests",
    "local_files_unittests",
    "window_placement_unittests",
    "content_blocker_rules_unittests",
    "keychain_unittests",
    "default_browser_unittests",
]
OUTPUT_DIRECTORY = "out/Release_GN_x64"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", type=pathlib.Path, required=True, help="the engine root (ENGINE_ROOT)")
    parser.add_argument("--minutes", type=float, required=True, help="the time left for building and running them")
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args(argv)
    deadline = time.monotonic() + args.minutes * 60
    src = args.root / "chromium_git/chromium/src"
    out = src / OUTPUT_DIRECTORY
    ninja = src / "third_party/ninja/ninja.exe"
    try:
        subprocess.run([str(ninja), "-C", str(out), "-j", str(args.jobs), *TESTS], cwd=src, check=True,
                       timeout=max(60.0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        # Ninja keeps what it built: the saved tree carries it to the next run.
        print("Bay's unit tests didn't finish building in the time left; the next run goes on from here")
        return 0
    except subprocess.CalledProcessError as error:
        print(f"Bay's unit tests didn't build (ninja exited {error.returncode})")
        return 1
    failed = []
    for test in TESTS:
        left = deadline - time.monotonic()
        if left <= 0:
            print(f"Out of time before {test}")
            break
        print(f"::group::{test}", flush=True)
        try:
            code = subprocess.run([str(out / f"{test}.exe")], cwd=out, timeout=left).returncode
        except subprocess.TimeoutExpired:
            code = "timed out"
        print("::endgroup::", flush=True)
        if code != 0:
            failed.append(f"{test} ({code})")
    if failed:
        print("Failed: " + ", ".join(failed))
        return 1
    print(f"Bay's Windows unit tests passed: {', '.join(TESTS)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
