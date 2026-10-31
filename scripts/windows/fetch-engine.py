#!/usr/bin/env python3
"""Download a checksum-pinned engine artifact and verify its file manifest.

The SHA-256 must come from trusted release configuration, never from an adjacent
unauthenticated download. Local --archive also supports offline Windows testing.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import pathlib
import re
import shutil
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile

SPEC = importlib.util.spec_from_file_location("bay_windows_engine", pathlib.Path(__file__).with_name("engine.py"))
engine = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(engine)


def validate_member(name):
    path = pathlib.PurePosixPath(name)
    if not name or "\\" in name or path.is_absolute() or ".." in path.parts or ":" in name:
        raise ValueError(f"unsafe artifact path: {name}")
    return path


def verify(directory, expected_id=None):
    directory = pathlib.Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1 or manifest.get("lock") != engine.LOCK:
        raise ValueError("engine manifest schema or pinned version does not match this checkout")
    if expected_id and manifest.get("id") != expected_id:
        raise ValueError(f"engine artifact {manifest.get('id')} does not match {expected_id}")
    files = manifest.get("files", {})
    if not isinstance(files, dict) or not files:
        raise ValueError("engine artifact has an empty file manifest")
    actual_files = {p.relative_to(directory).as_posix() for p in directory.rglob("*") if p.is_file()}
    if actual_files != {*files, "manifest.json"}:
        raise ValueError("engine artifact files do not match its manifest")
    for name, checksum in files.items():
        validate_member(name)
        if not isinstance(checksum, str) or not re.fullmatch(r"[a-f0-9]{64}", checksum):
            raise ValueError(f"invalid checksum for {name}")
        if engine.sha256(directory / name) != checksum:
            raise ValueError(f"engine artifact checksum mismatch: {name}")
    return manifest


def extract(archive, destination, expected_id):
    destination = pathlib.Path(destination)
    if destination.exists():
        raise ValueError(f"{destination} already exists; use a new destination to avoid mixing engine versions")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = pathlib.Path(tempfile.mkdtemp(prefix="bay-engine-", dir=destination.parent))
    try:
        with zipfile.ZipFile(archive) as zip_file:
            seen = set()
            for info in zip_file.infolist():
                validate_member(info.filename)
                canonical = info.filename.rstrip("/").lower()
                if canonical in seen:
                    raise ValueError(f"duplicate artifact path: {info.filename}")
                seen.add(canonical)
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError(f"artifact symlink is not allowed: {info.filename}")
            if sum(info.file_size for info in zip_file.infolist()) > 16 * 1024**3:
                raise ValueError("engine artifact exceeds 16 GiB expanded size")
            zip_file.extractall(temporary)
        verify(temporary, expected_id)
        temporary.rename(destination)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--url")
    group.add_argument("--archive", type=pathlib.Path)
    group.add_argument("--verify", type=pathlib.Path)
    parser.add_argument("--sha256")
    parser.add_argument("--destination", type=pathlib.Path, default=engine.REPO / "dist/windows-engine")
    parser.add_argument("--expected-id", default=engine.artifact_id())
    args = parser.parse_args()
    if args.verify:
        print(json.dumps(verify(args.verify, args.expected_id), indent=2))
        return
    if not args.sha256 or not re.fullmatch(r"[a-fA-F0-9]{64}", args.sha256):
        parser.error("--sha256 must be a trusted SHA-256 checksum for the archive")
    with tempfile.TemporaryDirectory(prefix="bay-engine-download-") as directory:
        archive = args.archive
        if args.url:
            if urllib.parse.urlparse(args.url).scheme != "https":
                parser.error("engine downloads require HTTPS")
            archive = pathlib.Path(directory) / "engine.zip"
            with urllib.request.urlopen(args.url, timeout=120) as response, archive.open("wb") as stream:
                if urllib.parse.urlparse(response.url).scheme != "https":
                    raise ValueError("engine download redirected away from HTTPS")
                shutil.copyfileobj(response, stream)
        if engine.sha256(archive) != args.sha256.lower():
            raise ValueError("engine archive SHA-256 does not match the configured checksum")
        extract(archive, args.destination, args.expected_id)
    print(args.destination)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        sys.exit(str(error))
