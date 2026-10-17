#!/usr/bin/env python3
"""Install NNCore: the Windows CEF host or the existing macOS Chrome host."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--list-paths", action="store_true")
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    windows = os.environ.get("BAY_ENGINE_PLATFORM", "win" if sys.platform == "win32" else "mac") == "win"
    if args.list_paths:
        if windows:
            print(json.dumps([["bay", True]]))
        else:
            import re
            script = (here / "apply.sh").read_text()
            hooks = sorted(set(re.findall(r'\$src/([^"\s]+)', script)))
            print(json.dumps([["bay", True]] + [[p, False] for p in hooks if p != "bay" and not p.endswith("/")]))
        return 0
    if not windows:
        return subprocess.call(["bash", str(here / "apply.sh"), *(["--check"] if args.check else [])])
    spec = importlib.util.spec_from_file_location("bay_chromium_apply", here.parent / "chromium/apply.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    root = Path(os.environ.get("CHROMIUM_SRC", str(Path.home() / "chromium-build/chromium_git/chromium/src")))
    source, destination = here / "src/bay", root / "bay"
    if args.check:
        if module.differs(source, destination):
            print("drift: bay")
            return 1
    else:
        module.sync(source, destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
