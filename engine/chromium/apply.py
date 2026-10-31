#!/usr/bin/env python3
"""Copy the Bay Chromium layer on every desktop build platform."""
import argparse
import contextlib
import filecmp
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

OWNED = ["chrome/browser/bay"]
WINDOWS_ICONS = (
    "chrome/app/theme/chromium/win/chromium.ico",
    "chrome/app/theme/chromium/win/chromium_doc.ico",
    "chrome/app/theme/chromium/win/chromium_pdf.ico",
)


def owned_paths(platform):
    return ([[path, True] for path in OWNED] +
            [[path, False] for path in WINDOWS_ICONS if platform == "win"])


def differs(source: Path, destination: Path) -> bool:
    if not destination.is_dir():
        return True
    comparison = filecmp.dircmp(source, destination)
    if comparison.left_only or comparison.right_only or comparison.funny_files:
        return True
    if any(not filecmp.cmp(source / f, destination / f, shallow=False)
           for f in comparison.common_files):
        return True
    return any(differs(source / d, destination / d) for d in comparison.common_dirs)


def sync(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for target in destination.iterdir():
        if not (source / target.name).exists():
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
    for item in source.iterdir():
        target = destination / item.name
        if item.is_dir():
            if target.exists() and not target.is_dir():
                target.unlink()
            sync(item, target)
        elif not target.is_file() or not filecmp.cmp(item, target, shallow=False):
            if target.is_dir():
                shutil.rmtree(target)
            shutil.copyfile(item, target)


@contextlib.contextmanager
def layer_source(here: Path, owned: str):
    """Materialize canonical package code inside the GN-owned Chromium layer."""
    source = here / "src" / owned
    if owned != "chrome/browser/bay":
        yield source
        return
    repository = here.parents[1]
    with tempfile.TemporaryDirectory(prefix="bay-chromium-layer-") as temporary:
        staged = Path(temporary) / "bay"
        shutil.copytree(source, staged)
        for package in ("import", "sync"):
            for platform in ("windows", "linux"):
                canonical = repository / "packages" / package / platform
                if platform == "linux" and not canonical.exists():
                    continue
                destination = staged / "data/packages" / package / platform
                shutil.copytree(canonical, destination,
                                ignore=shutil.ignore_patterns("tests", "__pycache__", "*.pyc"))
        yield staged


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--list-paths", action="store_true")
    args = parser.parse_args()
    platform = os.environ.get("BAY_ENGINE_PLATFORM",
                              {"win32": "win", "darwin": "mac"}.get(sys.platform, "linux"))
    if args.list_paths:
        print(json.dumps(owned_paths(platform)))
        return 0
    here = Path(__file__).resolve().parent
    root = Path(os.environ.get("CHROMIUM_SRC", str(Path.home() / "chromium-build/chromium_git/chromium/src")))
    for owned in OWNED:
        destination = root / owned
        with layer_source(here, owned) as source:
            if args.check:
                if differs(source, destination):
                    print(f"drift: {owned}")
                    return 1
            else:
                sync(source, destination)
    if platform == "win":
        icon = here / "assets/windows/bay.ico"
        for owned in WINDOWS_ICONS:
            destination = root / owned
            matches = destination.is_file() and filecmp.cmp(icon, destination, shallow=False)
            if args.check:
                if not matches:
                    print(f"drift: {owned}")
                    return 1
            elif not matches:
                destination.parent.mkdir(parents=True, exist_ok=True)
                if destination.is_dir():
                    shutil.rmtree(destination)
                shutil.copyfile(icon, destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
