#!/usr/bin/env python3
"""Install the code every Bay engine shares (//bay/filter, see apply.sh) on any host, Windows included."""
import argparse
import importlib.util
import json
import os
from pathlib import Path

OWNED = ["bay/filter"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--list-paths", action="store_true")
    args = parser.parse_args()
    if args.list_paths:
        print(json.dumps([[path, True] for path in OWNED]))
        return 0
    here = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location("bay_chromium_apply", here.parent / "chromium/apply.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    root = Path(os.environ.get("CHROMIUM_SRC", str(Path.home() / "chromium-build/chromium_git/chromium/src")))
    for path in OWNED:
        source, destination = here / "src" / path, root / path
        if args.check:
            if module.differs(source, destination):
                print(f"drift: {path}")
                return 1
        else:
            module.sync(source, destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
