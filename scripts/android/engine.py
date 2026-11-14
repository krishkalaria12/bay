#!/usr/bin/env python3
"""Pinned Chromium for Android: download, build, archive, or describe the pin.

Android's Chromium builds only on an x86-64 Linux host. This script drives a
direct Chromium checkout (no CEF) synced with target_os = ["android"], at the
commit in engine/android/lock.json, and builds the lock's target for arm64.

It builds Bay's engine, //bay/mobile (engine/android/src, copied into the tree
before each build), as bay-engine.aar for the app (docs/android-chromium-plan.html).

  python scripts/android/engine.py pin
  python scripts/android/engine.py download --root ~/bay-android-engine
  python scripts/android/engine.py build --root ~/bay-android-engine --jobs 4
  python scripts/android/engine.py archive --root ~/bay-android-engine --output dist/android-engine

`build --ci-minutes N` stops the compile after N minutes and exits 124, so a
runner can save the tree (scripts/lib/engine-state.py) and the next one resume.
Existing checkouts are verified, never reset.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import time

DRIVER_PATH = pathlib.Path(__file__).resolve()
REPO = DRIVER_PATH.parents[2]
LOCK_PATH = REPO / "engine/android/lock.json"
LOCK = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
STOPPED_EXIT_CODE = 124
BASE_STAMP = "bay-android-base.json"
BUILD_STAMP = "bay-android-build.json"
OVERLAY = REPO / "engine/android/src"
# Directories the overlay owns in chromium/src: replaced whole on every build.
OVERLAY_DIRECTORIES = ("bay/mobile",)
# The code every Bay engine shares (engine/shared, which desktop copies in with engine/shared/apply.sh): the content
# blocker's request and cookie filters, also replaced whole.
SHARED = REPO / "engine/shared/src"
SHARED_DIRECTORIES = ("bay/filter",)
ADBLOCK = REPO / "packages/adblock"
RUST_TARGET = "aarch64-linux-android"
# What a saved build tree depends on. The target and Bay's own sources aren't here: a change to them is an incremental
# rebuild of the same tree.
BASE_KEYS = ("chromium", "chromiumRef", "chromiumCommit", "chromiumUrl", "depotToolsCommit", "gclientTargetOs", "abi",
             "outputDirectory", "gnArgs")
DEPOT_TOOLS_URL = "https://chromium.googlesource.com/chromium/tools/depot_tools.git"


def digest(*parts: bytes) -> str:
    value = hashlib.sha256()
    for part in parts:
        value.update(part)
        value.update(b"\0")
    return value.hexdigest()


def base_id(lock=LOCK) -> str:
    """What a saved build tree depends on: the source pin, toolchains (from its DEPS) and GN args."""
    return digest(json.dumps({key: lock[key] for key in BASE_KEYS}, sort_keys=True).encode())[:16]


def tree_digest(directory: pathlib.Path) -> str:
    value = hashlib.sha256()
    for path in sorted(directory.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts:
            value.update(path.relative_to(directory).as_posix().encode() + b"\0")
            value.update(bytes.fromhex(sha256(path)))
    return value.hexdigest()


def shared_digest() -> str:
    """The shared filters and the Rust blocker they run on."""
    value = hashlib.sha256()
    value.update(tree_digest(SHARED).encode())
    for name in ("Cargo.toml", "Cargo.lock"):
        value.update(bytes.fromhex(sha256(ADBLOCK / name)))
    value.update(tree_digest(ADBLOCK / "src").encode())
    value.update(tree_digest(ADBLOCK / "include").encode())
    value.update(tree_digest(ADBLOCK / "vendor").encode())
    value.update(bytes.fromhex(sha256(ADBLOCK / "resources/resources.json")))
    return value.hexdigest()


def engine_id(lock=LOCK) -> str:
    """The artifact: the base, the target, and everything in this repository that shapes it."""
    return digest(base_id(lock).encode(), lock["target"].encode(), DRIVER_PATH.read_bytes(),
                  tree_digest(OVERLAY).encode(), shared_digest().encode())[:16]


def describe_pin(lock=LOCK) -> dict:
    cpu = lock["gnArgs"]["target_cpu"]
    return {
        "chromium": lock["chromium"],
        "chromiumCommit": lock["chromiumCommit"],
        "abi": lock["abi"],
        "target": lock["target"],
        "baseId": base_id(lock),
        "id": f"bay-android-engine-{lock['chromium']}-{cpu}-{engine_id(lock)}",
        "stateArtifact": f"android-engine-state-{base_id(lock)}",
    }


def gn_args_text(lock=LOCK) -> str:
    return "".join(f"{key} = {json.dumps(value)}\n" for key, value in lock["gnArgs"].items())


def unused_gn_args(output: str) -> list[str]:
    """GN only warns about an argument the pinned tree doesn't declare; treat it as an error."""
    names = re.findall(r'The variable "(\w+)" was set as a build argument', output)
    return names or (["(unnamed)"] if "Build argument has no effect" in output else [])


def chromium_version(src: pathlib.Path) -> str:
    fields = dict(line.split("=", 1) for line in (src / "chrome/VERSION").read_text().splitlines() if "=" in line)
    return ".".join(fields[key] for key in ("MAJOR", "MINOR", "BUILD", "PATCH"))


def min_sdk_version(src: pathlib.Path):
    match = re.search(r"default_min_sdk_version\s*=\s*(\d+)", (src / "build/config/android/config.gni").read_text())
    return int(match.group(1)) if match else None


def read_value(path: pathlib.Path, pattern: str | None = None):
    if not path.is_file():
        return None
    text = path.read_text(errors="replace")
    if pattern is None:
        return text.strip() or None
    match = re.search(pattern, text, re.MULTILINE)
    return match.group(1).strip() if match else None


def toolchains(src: pathlib.Path) -> dict:
    sdk = src / "third_party/android_sdk/public"

    def listing(path):
        return sorted(entry.name for entry in path.iterdir()) if path.is_dir() else []

    return {
        "ndk": (read_value(src / "third_party/android_toolchain/ndk/source.properties", r"^Pkg\.Revision\s*=\s*(.+)$")
                or read_value(src / "third_party/android_ndk/source.properties", r"^Pkg\.Revision\s*=\s*(.+)$")),
        "sdkPlatforms": listing(sdk / "platforms"),
        "buildTools": listing(sdk / "build-tools"),
        "jdk": read_value(src / "third_party/jdk/current/release", r'^JAVA_VERSION="?([^"\n]+)'),
        "clang": read_value(src / "third_party/llvm-build/Release+Asserts/cr_build_revision"),
        "rust": read_value(src / "third_party/rust-toolchain/VERSION"),
    }


def sha256(path: pathlib.Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def environment(root: pathlib.Path) -> dict:
    env = dict(os.environ)
    env.update(PATH=os.pathsep.join([str(root / "depot_tools"), env.get("PATH", "")]),
               DEPOT_TOOLS_UPDATE="0", DEPOT_TOOLS_METRICS="0", PYTHONUNBUFFERED="1")
    return env


def announce(command) -> list[str]:
    command = [str(part) for part in command]
    print("+ " + subprocess.list2cmdline(command), flush=True)
    return command


def run(command, cwd=None, env=None):
    subprocess.run(announce(command), cwd=cwd, env=env, check=True)


def output(command, cwd=None, env=None) -> str:
    return subprocess.check_output([str(part) for part in command], cwd=cwd, env=env, text=True).strip()


def run_until(command, cwd, env, minutes) -> bool:
    """Run a resumable build, stopping it after `minutes`. Returns whether it finished."""
    command = announce(command)
    # Its own process group, so the stop reaches ninja and the compilers under autoninja.
    process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL, start_new_session=True)
    try:
        code = process.wait(minutes * 60)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(OSError):
            os.killpg(process.pid, signal.SIGINT)
        try:
            process.wait(120)
        except subprocess.TimeoutExpired:
            # Ninja logs each finished step, so a forced stop only repeats the running ones.
            with contextlib.suppress(OSError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        return False
    if code:
        raise subprocess.CalledProcessError(code, command)
    return True


def require_tools(names, env):
    missing = [name for name in names if not shutil.which(name, path=env.get("PATH"))]
    if missing:
        raise RuntimeError(f"missing build tools: {', '.join(missing)}")


def require_linux_host():
    if sys.platform != "linux" or os.uname().machine not in ("x86_64", "amd64"):
        raise RuntimeError("Chromium for Android builds only on an x86-64 Linux host")


def source_dir(root: pathlib.Path) -> pathlib.Path:
    return root / "chromium/src"


def verify_checkout(root: pathlib.Path):
    src = source_dir(root)
    head = output(["git", "rev-parse", "HEAD"], cwd=src)
    if head != LOCK["chromiumCommit"]:
        raise RuntimeError(f"{src} is at {head}, expected {LOCK['chromiumCommit']}; use a fresh build root")
    version = chromium_version(src)
    if version != LOCK["chromium"]:
        raise RuntimeError(f"Chromium version {version} does not match the lock's {LOCK['chromium']}")


def verify_base(root: pathlib.Path):
    """A restored or reused tree must come from this exact pin and these GN args."""
    stamp = root / BASE_STAMP
    if not stamp.is_file():
        raise RuntimeError(f"{stamp} is missing; the tree was not downloaded by this script")
    recorded = json.loads(stamp.read_text())
    if recorded.get("baseId") != base_id():
        raise RuntimeError(f"the tree was synced for base {recorded.get('baseId')}, not {base_id()}; start from a fresh root")
    verify_checkout(root)


def clone_depot_tools(root: pathlib.Path, env):
    destination = root / "depot_tools"
    revision = LOCK["depotToolsCommit"]
    if not destination.exists():
        run(["git", "clone", "--no-checkout", DEPOT_TOOLS_URL, destination])
        run(["git", "checkout", "--detach", revision], cwd=destination)
    elif output(["git", "rev-parse", "HEAD"], cwd=destination) != revision:
        raise RuntimeError(f"{destination} is not at {revision}; use a fresh build root")
    run([destination / "ensure_bootstrap"], cwd=destination, env=env)


def fetch_source(root: pathlib.Path, env):
    """Fetch only the pinned commit: a shallow clone, unmanaged by gclient, so sync never moves it."""
    src = source_dir(root)
    if not (src / ".git").is_dir():
        src.mkdir(parents=True, exist_ok=True)
        run(["git", "init", "-q"], cwd=src)
        run(["git", "remote", "add", "origin", LOCK["chromiumUrl"]], cwd=src)
        run(["git", "fetch", "--depth", "1", "origin", LOCK["chromiumRef"]], cwd=src, env=env)
        run(["git", "checkout", "-q", "--detach", "FETCH_HEAD"], cwd=src)
    verify_checkout(root)
    (root / "chromium/.gclient").write_text(
        'solutions = [{\n'
        '  "name": "src",\n'
        f'  "url": {json.dumps(LOCK["chromiumUrl"])},\n'
        '  "managed": False,\n'
        '  "custom_deps": {},\n'
        '  "custom_vars": {},\n'
        '}]\n'
        # Added to the host's own (Linux) dependencies, which the host toolchain needs: its sysroot, for one.
        f'target_os = {json.dumps(LOCK["gclientTargetOs"])}\n')


def download(root: pathlib.Path):
    require_linux_host()
    root.mkdir(parents=True, exist_ok=True)
    if (root / BUILD_STAMP).exists() or (source_dir(root) / LOCK["outputDirectory"] / "build.ninja").exists():
        raise RuntimeError("an engine build exists here; run build rather than downloading into it")
    env = environment(root)
    clone_depot_tools(root, env)
    fetch_source(root, env)
    run(["gclient", "sync", "--nohooks", "--no-history", "--jobs", "4"], cwd=root / "chromium", env=env)
    run(["gclient", "runhooks"], cwd=root / "chromium", env=env)
    verify_checkout(root)
    (root / BASE_STAMP).write_text(json.dumps({"baseId": base_id(), "lock": LOCK}, indent=2) + "\n")


def generate(root: pathlib.Path, env):
    src = source_dir(root)
    directory = src / LOCK["outputDirectory"]
    directory.mkdir(parents=True, exist_ok=True)
    args = directory / "args.gn"
    if not args.is_file() or args.read_text() != gn_args_text():
        args.write_text(gn_args_text())
    result = subprocess.run(["gn", "gen", LOCK["outputDirectory"]], cwd=src, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(result.stdout, end="", flush=True)
    if result.returncode:
        raise subprocess.CalledProcessError(result.returncode, "gn gen")
    unused = unused_gn_args(result.stdout)
    if unused:
        raise RuntimeError(f"the pinned tree doesn't declare these GN args: {', '.join(unused)}")


def apply_overlay(root: pathlib.Path):
    """Copies engine/android/src and engine/shared/src into chromium/src, replacing the directories each owns (so a
    deleted file goes too)."""
    src = source_dir(root)
    for layer, directories in ((OVERLAY, OVERLAY_DIRECTORIES), (SHARED, SHARED_DIRECTORIES)):
        for directory in directories:
            target = src / directory
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(layer / directory, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    (src / "bay/mobile/adblock").mkdir(parents=True, exist_ok=True)
    shutil.copy2(ADBLOCK / "include/bay_adblock.h", src / "bay/mobile/adblock/bay_adblock.h")


def build_adblock(src: pathlib.Path, env: dict):
    """Bay's Rust content blocker as a static library for the engine's ABI, where //bay/mobile links it.

    Pure Rust: a static library needs no linker."""
    require_tools(("cargo",), env)
    run(["cargo", "rustc", "--release", "--lib", "--locked", "--target", RUST_TARGET, "--crate-type", "staticlib",
         "--manifest-path", ADBLOCK / "Cargo.toml",
         "--target-dir", src / LOCK["outputDirectory"] / "bay_adblock"], env=env)


def build(root: pathlib.Path, jobs: int | None, ci_minutes: int | None) -> bool:
    require_linux_host()
    verify_base(root)
    env = environment(root)
    (root / BUILD_STAMP).unlink(missing_ok=True)
    apply_overlay(root)
    build_adblock(source_dir(root), env)
    generate(root, env)
    command = ["autoninja", "-C", LOCK["outputDirectory"]]
    if jobs:
        command += ["-j", str(jobs)]
    command.append(LOCK["target"])
    src = source_dir(root)
    if ci_minutes is None:
        run(command, cwd=src, env=env)
    elif not run_until(command, src, env, ci_minutes):
        return False
    (root / BUILD_STAMP).write_text(json.dumps(describe_pin(), indent=2) + "\n")
    return True


def elf_alignment(library: pathlib.Path):
    """The smallest LOAD segment alignment in a 64-bit ELF, or None if it can't be read (16 KB pages need 16384)."""
    with library.open("rb") as stream:
        header = stream.read(64)
        if header[:4] != b"\x7fELF" or header[4] != 2:
            return None
        phoff = int.from_bytes(header[0x20:0x28], "little")
        phentsize = int.from_bytes(header[0x36:0x38], "little")
        phnum = int.from_bytes(header[0x38:0x3a], "little")
        alignments = []
        for index in range(phnum):
            stream.seek(phoff + index * phentsize)
            entry = stream.read(phentsize)
            if int.from_bytes(entry[0:4], "little") == 1:  # PT_LOAD
                alignments.append(int.from_bytes(entry[48:56], "little"))
        return min(alignments) if alignments else None


def archive(root: pathlib.Path, destination: pathlib.Path):
    verify_base(root)
    stamp = root / BUILD_STAMP
    pin = describe_pin()
    if not stamp.is_file() or json.loads(stamp.read_text()) != pin:
        raise RuntimeError("the engine sources changed since the last finished build; run build first")
    src = source_dir(root)
    out = src / LOCK["outputDirectory"]
    aar = out / LOCK["artifact"]
    library = out / "libbay_engine.so"
    unstripped = out / "lib.unstripped/libbay_engine.so"
    for path in (aar, library):
        if not path.is_file():
            raise RuntimeError(f"{path} is missing")
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copy2(aar, destination / aar.name)
    files = {aar.name: {"sha256": sha256(aar), "bytes": aar.stat().st_size}}
    # Symbols stay out of the app and beside the engine, matched to its crash reports by build id.
    if unstripped.is_file():
        symbols = destination / "libbay_engine.so.unstripped"
        shutil.copy2(unstripped, symbols)
        files[symbols.name] = {"sha256": sha256(symbols), "bytes": symbols.stat().st_size}
    manifest = {
        **pin,
        "schema": 1,
        "engineApi": 1,
        "gnArgs": LOCK["gnArgs"],
        "minSdkVersion": min_sdk_version(src),
        "toolchains": toolchains(src),
        "files": files,
        "elfLoadAlignment": elf_alignment(library),
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (destination / "engine.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("pin", "download", "build", "verify", "archive"))
    parser.add_argument("--root", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path, default=REPO / "dist/android-engine")
    parser.add_argument("--jobs", type=int)
    parser.add_argument("--ci-minutes", type=int, help="stop the compile after this long and exit 124")
    args = parser.parse_args()
    if args.command == "pin":
        print(json.dumps(describe_pin(), indent=2))
        return 0
    if args.root is None:
        parser.error(f"{args.command} needs --root")
    root = args.root.expanduser().resolve()
    try:
        if args.command == "download":
            download(root)
        elif args.command == "build":
            if not build(root, args.jobs, args.ci_minutes):
                print("compile paused; save the tree and resume", flush=True)
                return STOPPED_EXIT_CODE
        elif args.command == "verify":
            verify_base(root)
        else:
            archive(root, args.output.resolve())
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        print(f"engine {args.command} failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
