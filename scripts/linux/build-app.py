#!/usr/bin/env python3
"""Verify a Linux engine archive, add the React web bundle and stage the app that release.sh packs.

The SHA-256 must come from trusted release configuration, never from a file downloaded beside the archive.
"""
import argparse
import importlib.util
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("fetch_engine", HERE.parent / "windows/fetch-engine.py")
fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch)
engine = fetch.engine
web_artifacts = engine.web_artifacts
REPO = engine.REPO
REQUIRED = ("bay", "chrome_sandbox", "chrome_crashpad_handler", "resources.pak", "icudtl.dat", "xdg-settings",
            "bay-ui/" + web_artifacts.MOJO_ENTRY)
EXPANDED_LIMIT = 16 * 1024**3


def extract(archive, destination):
    """Unpack a .tar.zst engine archive: regular files and directories only, nothing outside `destination`."""
    with subprocess.Popen(["zstd", "-dc", "--", archive], stdout=subprocess.PIPE) as zstd:
        with tarfile.open(fileobj=zstd.stdout, mode="r|") as tar:
            size = 0
            for member in tar:
                fetch.validate_member(member.name)
                if not (member.isfile() or member.isdir()):
                    raise ValueError(f"engine archive may hold only files and directories: {member.name}")
                size += member.size
                if size > EXPANDED_LIMIT:
                    raise ValueError("engine archive exceeds 16 GiB expanded size")
                # The data filter also drops setuid bits; packages set the sandbox's mode themselves.
                tar.extract(member, destination, filter="data")
    if zstd.returncode:
        raise ValueError(f"zstd could not read {archive}")


def unresolved_libraries(directory):
    """Every ELF file's libraries that the loader can't find, with the app's own directory searched first (bay-wrapper)."""
    missing = []
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        with path.open("rb") as stream:
            if stream.read(4) != b"\x7fELF":
                continue
        result = subprocess.run(["ldd", path], capture_output=True, text=True, env={**os.environ, "LD_LIBRARY_PATH": str(directory)})
        for line in result.stdout.splitlines():
            if "=> not found" in line:
                missing.append(f"{path.relative_to(directory)}: {line.split('=>')[0].strip()}")
    return missing


def stage(engine_directory, web_directory, destination):
    manifest = fetch.verify(engine_directory, engine.artifact_id("linux"), platform="linux")
    runtime = engine_directory / "runtime"
    for name in REQUIRED:
        if not (runtime / name).is_file():
            raise ValueError(f"Linux engine runtime is missing {name}")
    web_artifacts.validate_entrypoint(web_directory)
    web_artifacts.mojo_files(runtime / "bay-ui")
    if destination.exists():
        raise ValueError(f"{destination} already exists; use a fresh output directory to avoid stale runtime files")
    # All verification finishes before creating the app directory.
    shutil.copytree(runtime, destination)
    # Chromium builds chrome_sandbox but discovers an installed sibling named chrome-sandbox.
    # Rename only the app copy, before hashing it; the engine manifest remains archive provenance.
    (destination / "chrome_sandbox").rename(destination / "chrome-sandbox")
    shutil.copytree(web_directory, destination / "bay-ui", dirs_exist_ok=True)
    # The generated Mojo bindings belong to the engine revision and win over any stale ones in a web export.
    shutil.copytree(runtime / "bay-ui", destination / "bay-ui", dirs_exist_ok=True)
    shutil.copy2(REPO / "packaging/linux/bay-wrapper", destination / "bay-wrapper")
    shutil.copy2(engine_directory / "manifest.json", destination / "engine-manifest.json")
    missing = unresolved_libraries(destination)
    if missing:
        shutil.rmtree(destination)
        raise ValueError("unresolved libraries:\n  " + "\n  ".join(missing))
    web_artifacts.write_manifest(destination, manifest["id"], platform="linux")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine-archive", type=pathlib.Path, help="the engine's runtime .tar.zst")
    parser.add_argument("--sha256", help="the archive's trusted SHA-256")
    parser.add_argument("--verify", type=pathlib.Path, help="verify a staged app instead")
    parser.add_argument("--web-directory", type=pathlib.Path, default=REPO / "apps/browser/dist")
    parser.add_argument("--output", type=pathlib.Path, default=REPO / "dist/linux-app")
    parser.add_argument("--skip-web-build", action="store_true", help="stage an existing web export")
    args = parser.parse_args()
    if args.verify:
        web_artifacts.verify_manifest(args.verify.resolve())
        print(f"Verified staged app: {args.verify}")
        return
    if args.engine_archive is None or not re.fullmatch(r"[a-fA-F0-9]{64}", args.sha256 or ""):
        parser.error("--engine-archive and a trusted --sha256 are required unless --verify is given")
    if engine.sha256(args.engine_archive) != args.sha256.lower():
        raise ValueError("engine archive SHA-256 does not match the configured checksum")
    if not args.skip_web_build:
        subprocess.run(["pnpm", "--filter", "@bay/browser", "build:web"], cwd=REPO, check=True)
    with tempfile.TemporaryDirectory(prefix="bay-linux-engine-") as directory:
        extract(args.engine_archive.resolve(), directory)
        stage(pathlib.Path(directory), args.web_directory.resolve(), args.output.resolve())
    print(args.output)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, tarfile.TarError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
