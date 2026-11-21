#!/usr/bin/env python3
"""Build or verify the standalone CLI bundled beside the desktop browser."""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parents[1]
TARGETS = {"linux": ("bun-linux-x64", "bay", "linux-x64"),
           "win": ("bun-windows-x64", "bay.exe", "windows-x64")}


def validate(directory, platform):
    _, name, expected = TARGETS[platform]
    manifest_path = directory / "manifest.json"
    executable = directory / name
    if manifest_path.is_symlink() or executable.is_symlink():
        raise ValueError("the CLI bundle must contain plain files")
    manifest = json.loads(manifest_path.read_text())
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z]+\.[0-9]+)?", manifest.get("version", "")):
        raise ValueError("the CLI bundle has no valid version")
    if manifest.get("platform") != expected or not executable.is_file():
        raise ValueError("the CLI bundle does not match the app platform")
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
    if manifest.get("sha256") != digest:
        raise ValueError("the CLI bundle checksum does not match its executable")
    return manifest


def build(directory, platform, version=None):
    cli = REPO / "apps/cli"
    version = version or json.loads((cli / "package.json").read_text())["version"]
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z]+\.[0-9]+)?", version):
        raise ValueError("invalid CLI version")
    target, name, label = TARGETS[platform]
    if directory.exists():
        raise ValueError("build the CLI in a fresh output directory")
    directory.mkdir(parents=True)
    bun = shutil.which("bun")
    if not bun:
        raise ValueError("Bun is required to bundle the bay command")
    subprocess.run([bun, "install", "--frozen-lockfile"], cwd=cli, check=True)
    subprocess.run([bun, "build", "--compile", "./bin/bay.ts", "--target=" + target,
                    "--define", "BAY_CLI_VERSION=" + json.dumps(version),
                    "--outfile", str(directory / name)], cwd=cli, check=True)
    manifest = {"version": version, "platform": label,
                "sha256": hashlib.sha256((directory / name).read_bytes()).hexdigest()}
    (directory / "manifest.json").write_text(json.dumps(manifest) + "\n")
    return validate(directory, platform)


def stage(source, destination, platform):
    validate(source, platform)
    # Ship only the two verified files, never arbitrary files beside a supplied CLI.
    destination.mkdir()
    for name in (TARGETS[platform][1], "manifest.json"):
        shutil.copy2(source / name, destination / name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", required=True, choices=TARGETS)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--version")
    args = parser.parse_args()
    build(args.output.resolve(), args.platform, args.version)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
