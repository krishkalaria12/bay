#!/usr/bin/env python3
"""Save and restore the resumable engine tree without following symbolic links.

Windows' tar.exe crashes with an access violation on the checked-out tree, and
7-Zip can't store its dangling and forward-slash links, so Python writes the
archive.
"""
import argparse
import os
from pathlib import Path
import shutil
import stat
import tarfile
import tempfile

# tarfile keeps mtime as a float, which rounds up by a fraction of a microsecond.
# An output newer than ninja's record of it would rebuild, so keep the exact time.
MTIME_NS = "BAY.mtime-ns"
# Windows types a link as a file or a directory when making it.
DIRECTORY_LINK = "BAY.directory-link"
# Saving and restoring take many minutes; show they're moving.
PROGRESS_INTERVAL = 50_000


def report_progress(action, count):
    if count % PROGRESS_INTERVAL == 0:
        print(f"state archive: {action} {count} entries", flush=True)


def is_link(entry):
    return entry.is_symlink() or entry.is_junction()


def walk(root):
    """Yield each entry under `root` with its archive name, without entering links."""
    pending = [root]
    while pending:
        with os.scandir(pending.pop()) as entries:
            for entry in entries:
                yield entry, Path(entry.path).relative_to(root).as_posix()
                if entry.is_dir(follow_symlinks=False) and not is_link(entry):
                    pending.append(entry.path)


def add_entry(tar, entry, name):
    info = tar.gettarinfo(entry.path, name)
    if info is None:
        return
    if is_link(entry):
        info.type = tarfile.SYMTYPE
        info.linkname = os.readlink(entry.path)
        if os.path.isdir(entry.path):
            info.pax_headers[DIRECTORY_LINK] = "1"
        tar.addfile(info)
        return
    if not info.isdir():
        info.pax_headers[MTIME_NS] = str(entry.stat(follow_symlinks=False).st_mtime_ns)
    if info.isreg():
        try:
            content = open(entry.path, "rb")
        except OSError as error:
            # A file a stray process still holds shouldn't lose a whole stage. Ninja
            # rebuilds a missing output, and a missing source fails the next compile.
            print(f"::warning::skipped unreadable file {ascii(name)}: {error.strerror}", flush=True)
            return
        with content:
            tar.addfile(info, content)
    else:
        tar.addfile(info)


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
        # Compression streams directly to disk; a second, uncompressed tree would
        # exhaust the runner's free space.
        with tarfile.open(temporary, "w:gz", compresslevel=1) as tar:
            for count, (entry, name) in enumerate(walk(root), 1):
                add_entry(tar, entry, name)
                report_progress("saved", count)
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
    links = []
    # Keep tarfile's small default buffer: every read recopies what's left of it.
    # The archive comes from this repository's own runs, and its links may point
    # outside the tree, so the default filter would refuse them.
    with tarfile.open(archive, "r|gz") as tar:
        for count, member in enumerate(tar, 1):
            report_progress("restored", count)
            if member.issym():
                links.append(member)
                continue
            tar.extract(member, root, filter="fully_trusted")
            # Hard links too: extracting one rewrites the time of the file it shares.
            if MTIME_NS in member.pax_headers:
                modified = int(member.pax_headers[MTIME_NS])
                os.utime(root / member.name, ns=(modified, modified))
    for link in links:
        # Windows can't resolve the forward slashes some checked-in links carry.
        os.symlink(link.linkname.replace("/", os.sep), root / link.name,
                   target_is_directory=DIRECTORY_LINK in link.pax_headers)


def describe(root):
    tree = {}
    for entry, name in walk(root):
        if is_link(entry):
            tree[name] = ("link", os.readlink(entry.path).replace("/", os.sep))
        elif entry.is_dir(follow_symlinks=False):
            tree[name] = ("directory",)
        else:
            status = entry.stat(follow_symlinks=False)
            tree[name] = ("file", status.st_size, status.st_mtime_ns)
    return tree


def clear_read_only_and_retry(function, path, _error):
    os.chmod(path, stat.S_IWRITE)
    function(path)


def check(root: Path, archive: Path):
    """Round-trip the tree, so a problem costs minutes rather than a compile's worth."""
    root = root.resolve()
    archive = archive.resolve()
    restored = archive.with_name(f"{archive.name}.restored")
    try:
        create(root, archive)
        print(f"state archive: {archive.stat().st_size / 2**30:.1f} GB", flush=True)
        restore(restored, archive)
        print("state archive: comparing the restored tree", flush=True)
        original = describe(root)
        different = sorted({name for name, _ in original.items() ^ describe(restored).items()})
        if different:
            raise ValueError(f"{len(different)} entries changed in a round trip, such as {different[:20]}")
        print(f"state archive: {len(original)} entries restored exactly, removing the copy", flush=True)
    finally:
        if restored.exists():
            shutil.rmtree(restored, onexc=clear_read_only_and_retry)
        archive.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("create", "restore", "check"))
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    args = parser.parse_args()
    try:
        {"create": create, "restore": restore, "check": check}[args.command](args.root, args.archive)
    except (OSError, ValueError, EOFError, tarfile.TarError) as error:
        parser.exit(1, f"engine state {args.command} failed: {error}\n")


if __name__ == "__main__":
    main()
