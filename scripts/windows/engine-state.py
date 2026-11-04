#!/usr/bin/env python3
"""Save and restore the resumable engine tree without following symbolic links."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile


def create(root: Path, archive: Path):
    root = root.resolve()
    archive = archive.resolve()
    if not root.is_dir():
        raise ValueError(f"engine root is not a directory: {root}")
    if archive.is_relative_to(root):
        raise ValueError("the state archive must be outside the engine root")
    archive.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f"{archive.name}.", suffix=".partial", dir=archive.parent)
    os.close(descriptor)
    temporary = Path(temporary)
    try:
        # BSD tar is built into Windows. Its default is to archive links, even
        # dangling ones, rather than dereference the checkout's .bin/include links.
        # Compression streams directly to disk; a second, uncompressed tree would
        # exhaust the runner's free space.
        subprocess.run([
            "tar", "-czf", str(temporary), "--options", "gzip:compression-level=1",
            "-C", str(root), ".",
        ], check=True)
        temporary.replace(archive)
    finally:
        temporary.unlink(missing_ok=True)


def restore(root: Path, archive: Path):
    root = root.resolve()
    archive = archive.resolve()
    if not archive.is_file():
        raise ValueError(f"state archive is missing: {archive}")
    if root.exists() and (not root.is_dir() or any(root.iterdir())):
        raise ValueError(f"restore destination must be empty: {root}")
    root.mkdir(parents=True, exist_ok=True)
    subprocess.run(["tar", "-xzf", str(archive), "-C", str(root)], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("create", "restore"))
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.command == "create":
            create(args.root, args.archive)
        else:
            restore(args.root, args.archive)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"engine state {args.command} failed: {error}\n")


if __name__ == "__main__":
    main()
