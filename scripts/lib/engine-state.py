#!/usr/bin/env python3
"""Save and restore a resumable engine build tree between GitHub runner stages.

A hosted job ends after six hours, so a long Chromium compile saves its tree and
the next job resumes it. GNU tar's POSIX format keeps nanosecond times, which
ninja needs to see restored outputs as up to date, and multithreaded zstd writes
the tree in minutes. Each archive gets a SHA-256 sidecar that restore checks
before touching the destination.

Adapted from the Linux branch's scripts/windows/engine-state.py, keeping only
its tar + zstd path.
"""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def checksum_path(archive: Path) -> Path:
    return archive.with_name(archive.name + ".sha256")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def pipe(producer, consumer):
    """Run producer | consumer, failing if either fails."""
    with subprocess.Popen(producer, stdout=subprocess.PIPE) as first:
        second = subprocess.run(consumer, stdin=first.stdout, check=False)
        first.stdout.close()
    for command, code in ((producer, first.returncode), (consumer, second.returncode)):
        if code:
            raise OSError(f"{command[0]} exited with code {code}")


def create(root: Path, archive: Path):
    root = root.resolve()
    archive = archive.resolve()
    if not root.is_dir():
        raise ValueError(f"engine root is not a directory: {root}")
    if archive.is_relative_to(root):
        raise ValueError("the state archive must be outside the engine root")
    if not archive.name.endswith(".tar.zst"):
        raise ValueError("the state archive must be named *.tar.zst")
    archive.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f"{archive.name}.", suffix=".partial", dir=archive.parent)
    os.close(descriptor)
    temporary = Path(temporary)
    try:
        # Compression streams straight to disk; an uncompressed copy of the tree wouldn't fit.
        pipe(["tar", "--format=posix", "--numeric-owner", "-C", str(root), "-cf", "-", "."],
             ["zstd", "-T0", "-3", "-q", "-f", "-o", str(temporary)])
        checksum = sha256(temporary)
        temporary.replace(archive)
        checksum_path(archive).write_text(f"{checksum}  {archive.name}\n", encoding="utf-8")
    finally:
        temporary.unlink(missing_ok=True)


def verify(archive: Path):
    sidecar = checksum_path(archive)
    if not sidecar.is_file():
        raise ValueError(f"state archive has no checksum: {sidecar}")
    expected = sidecar.read_text(encoding="utf-8").split()[0]
    actual = sha256(archive)
    if actual != expected:
        raise ValueError(f"state archive checksum {actual} does not match {expected}")


def restore(root: Path, archive: Path):
    root = root.resolve()
    archive = archive.resolve()
    if not archive.is_file():
        raise ValueError(f"state archive is missing: {archive}")
    if root.exists() and (not root.is_dir() or any(root.iterdir())):
        raise ValueError(f"restore destination must be empty: {root}")
    verify(archive)
    root.mkdir(parents=True, exist_ok=True)
    pipe(["zstd", "-dcq", str(archive)], ["tar", "--numeric-owner", "-C", str(root), "-xpf", "-"])


def describe(root: Path):
    tree = {}
    pending = [root]
    while pending:
        with os.scandir(pending.pop()) as entries:
            for entry in entries:
                name = Path(entry.path).relative_to(root).as_posix()
                if entry.is_symlink():
                    tree[name] = ("link", os.readlink(entry.path))
                elif entry.is_dir(follow_symlinks=False):
                    tree[name] = ("directory",)
                    pending.append(entry.path)
                else:
                    status = entry.stat(follow_symlinks=False)
                    tree[name] = ("file", status.st_size, status.st_mtime_ns)
    return tree


def check(root: Path, archive: Path):
    """Round-trip the tree, so a problem costs minutes rather than a compile's worth."""
    root = root.resolve()
    archive = archive.resolve()
    restored = archive.with_name(f"{archive.name}.restored")
    try:
        create(root, archive)
        print(f"state archive: {archive.stat().st_size / 2**30:.1f} GB", flush=True)
        restore(restored, archive)
        original = describe(root)
        different = sorted({name for name, _ in original.items() ^ describe(restored).items()})
        if different:
            raise ValueError(f"{len(different)} entries changed in a round trip, such as {different[:20]}")
        print(f"state archive: {len(original)} entries restored exactly", flush=True)
    finally:
        shutil.rmtree(restored, ignore_errors=True)
        archive.unlink(missing_ok=True)
        checksum_path(archive).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("create", "restore", "check"))
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    args = parser.parse_args()
    try:
        {"create": create, "restore": restore, "check": check}[args.command](args.root, args.archive)
    except (OSError, ValueError) as error:
        parser.exit(1, f"engine state {args.command} failed: {error}\n")


if __name__ == "__main__":
    main()
