#!/usr/bin/env python3
"""Pinned Windows/Linux x64 engine: download, prepare, build, archive or describe the pin.

Run on Windows from a VS 2026 Developer PowerShell with C++/ATL/MFC and the
10.0.28000.2270 SDK installed. Use a short NTFS path such as C:\\bay-engine.
Linux requires a native x64 Linux host, Chromium build dependencies, the selected
Linux integration patches and the pinned sysroot. All
subprocess failures stop the build. Existing checkouts are never reset.
"""
from __future__ import annotations

import argparse
import contextlib
import fnmatch
import hashlib
import importlib.util
import json
import os
import pathlib
import platform as host_platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

DRIVER_PATH = pathlib.Path(__file__).resolve()
REPO = DRIVER_PATH.parents[1]
LOCK_PATH = REPO / "engine/patches/build/engine-lock.json"
LOCK_DATA = json.loads(LOCK_PATH.read_text(encoding="utf-8"))


def platform_lock(platform="win"):
    if platform not in LOCK_DATA["platforms"]:
        raise ValueError(f"unsupported engine platform: {platform}")
    return {**{key: value for key, value in LOCK_DATA.items() if key != "platforms"},
            **LOCK_DATA["platforms"][platform]}


# Retain the Windows import interface used by artifact consumers.
LOCK = platform_lock()
WEB_SPEC = importlib.util.spec_from_file_location("bay_web_artifacts", DRIVER_PATH.parent / "windows/web-artifacts.py")
web_artifacts = importlib.util.module_from_spec(WEB_SPEC)
WEB_SPEC.loader.exec_module(web_artifacts)
GN_ARGS = {
    "is_official_build": False, "is_debug": False, "is_component_build": False,
    "target_cpu": "x64", "enable_cef": False, "dcheck_always_on": False, "use_thin_lto": False,
    "chrome_pgo_phase": 0, "symbol_level": 1, "blink_symbol_level": 0,
    "v8_symbol_level": 0, "proprietary_codecs": True, "ffmpeg_branding": "Chrome",
    "enable_mse_mpeg2ts_stream_parser": True, "enable_widevine": True,
    "treat_warnings_as_errors": False, "fatal_linker_warnings": False,
    "disable_fieldtrial_testing_config": True, "enable_hangout_services_extension": False,
    "enable_remoting": False, "exclude_unwind_tables": True,
    "google_api_key": "", "google_default_client_id": "", "google_default_client_secret": "",
    "use_official_google_api_keys": False, "use_unofficial_version_number": False,
    "v8_drumbrake_bounds_checks": True, "enable_iterator_debugging": False,
    "enable_updater": False, "branding_file_path": "//chrome/app/theme/bay/BRANDING",
}


def gn_args(platform="win"):
    args = dict(GN_ARGS)
    if platform == "linux":
        args.pop("enable_iterator_debugging")
        args.update(use_sysroot=True, is_cfi=False, use_vaapi=True, rtc_use_pipewire=True)
        args["target_sysroot"] = "//build/linux/" + platform_lock("linux")["sysroot"]["directory"]
    elif platform != "win":
        raise ValueError(f"unsupported engine platform: {platform}")
    return args


def default_root(platform="win"):
    return pathlib.Path(os.environ.get("BAY_ENGINE_ROOT") or
                        ("C:/bay-engine" if platform == "win" else pathlib.Path.home() / "chromium-build"))


def build_identity(platform="win"):
    return {"lock": platform_lock(platform), "sourceDigest": source_digest(platform)}


def require_linux_integration(env, platform):
    if platform != "linux":
        return
    try:
        listing = subprocess.check_output(
            [sys.executable, REPO / "engine/patches/series.py", "files", "--platform", "linux"],
            env=env, text=True, stderr=subprocess.STDOUT)
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"cannot inspect Linux integration patches:\n{error.output.strip()}") from error
    lines = listing.splitlines()
    for name in ("chromium-bay-layer-linux.patch", "chromium-bay-branding-linux.patch"):
        header = f"chromium {name}:"
        if header not in lines:
            raise RuntimeError(f"Linux engine integration is incomplete: series must route {name} to Linux")
        index = lines.index(header)
        if index + 1 == len(lines) or not lines[index + 1].startswith("  "):
            raise RuntimeError(f"Linux engine integration patch has no target files: {name}")
    require_linux_sysroot(env, platform)


def require_linux_sysroot(env, platform):
    if platform != "linux":
        return
    lock = platform_lock("linux")["sysroot"]
    src = pathlib.Path(env["CHROMIUM_SRC"])
    metadata_path = src / lock["metadataFile"]
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))[lock["metadataKey"]]
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise RuntimeError(f"missing or invalid Chromium sysroot metadata: {metadata_path}; "
                           "finish gclient sync/hooks for the pinned checkout") from error
    expected = {"Sha256Sum": lock["revision"], "SysrootDir": lock["directory"],
                "Tarball": lock["tarball"], "URL": lock["url"]}
    if not isinstance(metadata, dict) or any(metadata.get(key) != value for key, value in expected.items()):
        raise RuntimeError(f"Chromium sysroot metadata does not match engine-lock.json: {metadata_path}")
    directory = src / "build/linux" / lock["directory"]
    if not directory.is_dir():
        raise RuntimeError(f"missing pinned Chromium sysroot: {directory}; finish gclient sync/hooks first")
    # Pinned depot_tools verifies and extracts first-class GCS dependencies before
    # writing this pair. Migration markers override any stale installer stamp.
    revision = lock["revision"]
    receipt = directory / f".{revision}_hash"
    marker = directory / f".{revision}_is_first_class_gcs"
    if receipt.exists() or any(directory.glob(".*_is_first_class_gcs")):
        try:
            valid = (receipt.read_text(encoding="utf-8") == revision + "\n" and
                     marker.read_text(encoding="utf-8") == "1\n")
        except (OSError, ValueError):
            valid = False
        if not valid:
            raise RuntimeError(f"invalid pinned Chromium sysroot GCS receipts: {directory}; "
                               "finish gclient sync for the pinned checkout")
        return
    # install-sysroot.py writes the content-addressed URL verbatim after verifying
    # the archive's SHA-256 and extracting it. A directory alone proves nothing.
    stamp = directory / ".stamp"
    try:
        installed = stamp.read_text(encoding="utf-8")
    except (OSError, ValueError) as error:
        raise RuntimeError(f"missing or invalid Chromium sysroot install stamp: {stamp}; "
                           "rerun build/linux/sysroot_scripts/install-sysroot.py --arch=amd64") from error
    if installed != f"{lock['url']}/{lock['revision']}":
        raise RuntimeError(f"Chromium sysroot install stamp does not match engine-lock.json: {stamp}; "
                           "rerun build/linux/sysroot_scripts/install-sysroot.py --arch=amd64")


def require_tools(names, env):
    for name in names:
        if not shutil.which(name, path=env.get("PATH")):
            raise RuntimeError(f"missing required tool: {name}; install Chromium build dependencies "
                               "and finish depot_tools setup")


def check_root_platform(root, platform):
    marker = root / ".bay-engine-platform"
    if marker.exists() and marker.read_text().strip() != platform:
        raise RuntimeError(f"{root} belongs to another platform; use a separate build root")
    for name in ("bay-engine-source.json", "bay-engine-build.json"):
        stamp = root / name
        if stamp.exists() and json.loads(stamp.read_text())["lock"]["platform"] != platform_lock(platform)["platform"]:
            raise RuntimeError(f"{root} contains another platform's engine; use a separate build root")
    if platform == "linux" and (root / "bay-prepare-state.json").exists():
        raise RuntimeError("Windows preparation state exists; use a separate Linux build root")
    marker.write_text(platform + "\n")


def sha256(path):
    digest = hashlib.sha256()
    with pathlib.Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_digest(platform="win"):
    digest = hashlib.sha256(platform.encode() + b"\0")
    for directory in ("engine/patches", "engine/chromium", "engine/nncore",
                      "packages/import/windows", "packages/sync/windows"):
        for path in sorted((REPO / directory).rglob("*")):
            package_test = directory.startswith("packages/") and "tests" in path.relative_to(REPO / directory).parts
            if path.is_file() and not package_test and "__pycache__" not in path.parts and path.suffix != ".pyc":
                digest.update(path.relative_to(REPO).as_posix().encode() + b"\0")
                digest.update(bytes.fromhex(sha256(path)))
    digest.update(bytes.fromhex(sha256(DRIVER_PATH)))
    digest.update(bytes.fromhex(sha256(DRIVER_PATH.parent / "windows/engine.py")))
    digest.update(bytes.fromhex(sha256(DRIVER_PATH.parent / "windows/web-artifacts.py")))
    return digest.hexdigest()


def artifact_id(platform="win"):
    lock = platform_lock(platform)
    return f"bay-engine-{lock['chromium']}-{lock['platform']}-x64-{source_digest(platform)[:16]}"


def run(command, cwd=None, env=None):
    command = [str(part) for part in command]
    # Python on Windows does not resolve depot_tools .bat entry points itself.
    if sys.platform == "win32":
        executable = shutil.which(command[0], path=(env or os.environ).get("PATH"))
        if executable:
            command[0] = executable
    print(subprocess.list2cmdline(command), flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True)


def clone_pin(url, destination, revision):
    if not destination.exists():
        run(["git", "clone", "--no-checkout", url, destination])
        # --no-checkout still creates HEAD at the remote default branch. A
        # fresh clone must select our pin before inspecting reusable state.
        run(["git", "checkout", "--detach", revision], cwd=destination)
        return
    current = subprocess.run(["git", "rev-parse", "HEAD"], cwd=destination,
                             capture_output=True, text=True)
    if current.returncode == 0:
        if current.stdout.strip() != revision:
            raise RuntimeError(f"{destination} is at {current.stdout.strip()}, expected {revision}; use a fresh build root")
        dirty = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=destination, text=True)
        if dirty.strip():
            raise RuntimeError(f"{destination} has modified tracked files; use a fresh build root")
        return
    run(["git", "checkout", "--detach", revision], cwd=destination)


def environment(root, platform="win"):
    env = dict(os.environ)
    paths = [str(root / "depot_tools")]
    git = shutil.which("git")
    if git and platform == "win":
        # Git for Windows ships GNU patch; no MSYS shell is needed.
        paths.append(str(pathlib.Path(git).resolve().parents[1] / "usr/bin"))
    env.update(PATH=os.pathsep.join([*paths, env.get("PATH", "")]),
               CB=str(root), CHROMIUM_SRC=str(root / "chromium_git/chromium/src"),
               NN_REPO=str(REPO), NN_SERIES_BASE=str(root / f"series-base-{platform}"),
               BAY_ENGINE_PLATFORM=platform,
               DEPOT_TOOLS_UPDATE="0", DEPOT_TOOLS_METRICS="0",
               CEF_USE_GN="1", CEF_ENABLE_ARM64="0", GN_OUT_CONFIGS="Release_GN_x64",
               PYTHONUNBUFFERED="1")
    if platform == "win":
        env["DEPOT_TOOLS_WIN_TOOLCHAIN"] = "0"
    else:
        env.pop("DEPOT_TOOLS_WIN_TOOLCHAIN", None)
    env["GN_DEFINES"] = " ".join(f"{key}={json.dumps(value)}" for key, value in gn_args(platform).items())
    return env


@contextlib.contextmanager
def build_lock(root):
    root.mkdir(parents=True, exist_ok=True)
    lock = root / ".bay-build.lock"
    try:
        handle = lock.open("x", encoding="utf-8")
    except FileExistsError:
        raise RuntimeError(f"{lock} exists. Another build may be active; inspect it before removing a stale lock") from None
    try:
        with handle:
            handle.write(str(os.getpid()))
        yield
    finally:
        lock.unlink()


def download(root, env, platform="win"):
    lock = platform_lock(platform)
    if platform == "linux":
        require_tools(("git",), env)
    if (root / "chromium_git/chromium/src" / lock["outputDirectory"] / "build.ninja").exists():
        raise RuntimeError("an engine build exists; use build rather than downloading into a prepared tree")
    for name, url, revision in (
        ("depot_tools", "https://chromium.googlesource.com/chromium/tools/depot_tools.git", lock["depotToolsCommit"]),
        ("ungoogled", "https://github.com/ungoogled-software/ungoogled-chromium.git", lock["ungoogledCommit"]),
    ):
        clone_pin(url, root / name, revision)
    automate = root / "automate/automate-git.py"
    automate.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://raw.githubusercontent.com/chromiumembedded/cef/{lock['cefCommit']}/tools/automate/automate-git.py"
    with urllib.request.urlopen(url, timeout=90) as response:
        automate.write_bytes(response.read())
    run([sys.executable, automate, f"--download-dir={root / 'chromium_git'}",
         f"--depot-tools-dir={root / 'depot_tools'}", f"--branch={lock['cefBranch']}",
         f"--checkout={lock['cefCommit']}", "--no-chromium-history", "--x64-build",
         "--no-debug-build", "--no-build", "--no-distrib"], env=env)
    verify_checkout(root, platform)


def verify_checkout(root, platform="win"):
    lock = platform_lock(platform)
    src = root / "chromium_git/chromium/src"
    version = dict(line.split("=", 1) for line in (src / "chrome/VERSION").read_text().splitlines() if "=" in line)
    actual = ".".join(version[key] for key in ("MAJOR", "MINOR", "BUILD", "PATCH"))
    if actual != lock["chromium"]:
        raise RuntimeError(f"Chromium version {actual} does not match {lock['chromium']}")
    actual_cef = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=src / "cef", text=True).strip()
    if actual_cef != lock["cefCommit"]:
        raise RuntimeError(f"CEF revision {actual_cef} does not match engine-lock.json")


def series(root, env, command, *options):
    run([sys.executable, REPO / "engine/patches/series.py", command, "--platform", env.get("BAY_ENGINE_PLATFORM", "win"), *options], env=env)


def prepare(root, env, platform="win"):
    require_linux_integration(env, platform)
    if platform == "linux":
        require_tools(("git", "patch", "gn"), env)
    verify_checkout(root, platform)
    src = pathlib.Path(env["CHROMIUM_SRC"])
    state = root / ("bay-prepare-state.json" if platform == "win" else "bay-prepare-state-linux.json")
    completed = json.loads(state.read_text()) if state.exists() else []

    def step(name, action):
        if name not in completed:
            action()
            completed.append(name)
            state.write_text(json.dumps(completed, indent=2) + "\n")

    def compatibility():
        # Retain the pinned source patch baseline shared with macOS, while
        # compiling Chrome with ENABLE_CEF=false. Bay's CEF-only API patches
        # are macOS-only in series and are never installed on Windows.
        run([sys.executable, "tools/patcher.py"], cwd=src / "cef", env=env)
    step("chromium-compat", compatibility)
    step("ungoogled", lambda: run([sys.executable, REPO / "engine/patches/build/03-ungoogled.py"], env=env))

    def substitute():
        ug = root / "ungoogled"
        patterns = [line.strip() for line in (REPO / "engine/patches/build/domsub-keep-store.txt").read_text().splitlines()
                    if line.strip() and not line.startswith("#")]
        filtered = root / "domain_substitution.filtered.list"
        filtered.write_text("\n".join(line for line in (ug / "domain_substitution.list").read_text().splitlines()
                                      if line and not any(fnmatch.fnmatch(line, pattern) for pattern in patterns)) + "\n")
        cache = root / "domsubcache.tar.gz"
        if cache.exists():
            raise RuntimeError(f"{cache} already exists without a completed domain step; inspect/revert it before retrying")
        run([sys.executable, ug / "utils/domain_substitution.py", "apply", "-r", ug / "domain_regex.list",
             "-f", filtered, "-c", cache, src], cwd=ug, env=env)
    step("domains", substitute)
    series(root, env, "capture-base", "--phase", "chromium")
    series(root, env, "apply", "--phase", "chromium")
    generate_gn(root, env, platform)
    (root / "bay-engine-source.json").write_text(json.dumps(build_identity(platform), indent=2) + "\n")


def generate_gn(root, env, platform="win"):
    lock = platform_lock(platform)
    require_linux_sysroot(env, platform)
    src = pathlib.Path(env["CHROMIUM_SRC"])
    # Chrome uses ordinary GN args. CEF's config merger would add client API
    # and CDM requirements that this desktop Chrome target does not need.
    directory = src / lock["outputDirectory"]
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "args.gn").write_text("\n".join(f"{key} = {json.dumps(value)}" for key, value in gn_args(platform).items()) + "\n")
    run(["gn", "gen", lock["outputDirectory"]], cwd=src, env=env)


def build(root, env, targets, jobs, platform="win"):
    lock = platform_lock(platform)
    require_linux_integration(env, platform)
    if platform == "linux":
        require_tools(("git", "gn", "autoninja"), env)
    verify_checkout(root, platform)
    (root / "bay-engine-build.json").unlink(missing_ok=True)
    series(root, env, "apply", "--phase", "chromium")
    series(root, env, "check")
    generate_gn(root, env, platform)
    src = pathlib.Path(env["CHROMIUM_SRC"])
    args = ["autoninja", "-C", lock["outputDirectory"]]
    if jobs:
        args += ["-j", str(jobs)]
    run([*args, *(targets or (["chrome", "chrome_sandbox"] if platform == "linux" else ["chrome"]))], cwd=src, env=env)
    (root / "bay-engine-build.json").write_text(json.dumps(build_identity(platform), indent=2) + "\n")


def archive(root, output, platform="win"):
    verify_checkout(root, platform)
    stamp = root / "bay-engine-build.json"
    if not stamp.exists() or json.loads(stamp.read_text()) != build_identity(platform):
        raise RuntimeError("engine sources changed since the last successful build; run build before archiving")
    if platform == "linux":
        return archive_linux(root, output)
    src = root / "chromium_git/chromium/src"
    binaries = src / LOCK["outputDirectory"]
    for required in ("chrome.exe", "chrome.dll", "chrome_elf.dll", "notification_helper.exe", "icudtl.dat", "resources.pak", "locales"):
        if not (binaries / required).exists():
            raise RuntimeError(f"missing engine output: {binaries / required}")
    files = {}
    pdbs = sorted(binaries.glob("*.pdb"))
    if not pdbs:
        raise RuntimeError("no PDBs found; symbol_level=1 and a full build are required for release artifacts")
    for path in binaries.iterdir():
        if path.is_file() and path.suffix.lower() in (".dll", ".exe", ".pak", ".dat", ".bin", ".json"):
            files[f"runtime/{path.name}"] = path
    for name in ("locales", "swiftshader", "resources", "WidevineCdm", "MEIPreload", "PrivacySandboxAttestationsPreloaded", "hyphen-data"):
        if (binaries / name).is_dir():
            for path in (binaries / name).rglob("*"):
                if path.is_file():
                    files[f"runtime/{path.relative_to(binaries).as_posix()}"] = path
    generated_mojo = binaries / "gen/chrome/browser/bay/webui/resources/tsc"
    modules, shared_imports = web_artifacts.mojo_files(generated_mojo)
    for name, path in modules.items():
        files[f"runtime/bay-ui/{name}"] = path
    manifest = {"schemaVersion": 1, "id": artifact_id(), "lock": LOCK, "sourceDigest": source_digest(),
                "files": {name: sha256(path) for name, path in sorted(files.items())},
                "mojo": {"entrypoint": "runtime/bay-ui/" + web_artifacts.MOJO_ENTRY, "sharedImports": shared_imports}}
    output.mkdir(parents=True, exist_ok=True)
    artifact = output / f"{artifact_id()}.zip"
    with zipfile.ZipFile(artifact, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zip_file:
        for name, path in sorted(files.items()):
            zip_file.write(path, name)
        zip_file.writestr("manifest.json", json.dumps(manifest, indent=2) + "\n")
    with zipfile.ZipFile(output / f"{artifact_id()}-symbols.zip", "w", zipfile.ZIP_DEFLATED) as zip_file:
        for path in pdbs:
            zip_file.write(path, path.name)
    artifact.with_suffix(".zip.sha256").write_text(f"{sha256(artifact)}  {artifact.name}\n")
    print(artifact)


def archive_linux(root, output):
    """Package a completed Linux build, extracting symbols from copies of ELF files."""
    require_tools(("zstd", "objcopy", "strip", "readelf"), os.environ)
    binaries = root / "chromium_git/chromium/src" / platform_lock("linux")["outputDirectory"]
    executables = ("bay", "chrome_sandbox", "chrome_crashpad_handler")
    for name in (*executables, "icudtl.dat", "resources.pak", "locales"):
        path = binaries / name
        valid_type = path.is_dir() if name == "locales" else path.is_file()
        if not valid_type or path.is_symlink():
            raise RuntimeError(f"missing or symlinked Linux engine output: {path}")
        if name in executables and not os.access(path, os.X_OK):
            raise RuntimeError(f"Linux engine output is not executable: {path}")
    if not any((binaries / "locales").glob("*.pak")):
        raise RuntimeError("Linux locales output has no locale PAKs")
    files = {}
    for path in binaries.iterdir():
        if path.is_file() and (path.name in executables or path.suffix in (".so", ".pak", ".dat", ".bin", ".json")
                               or ".so." in path.name):
            files[f"runtime/{path.name}"] = path
    for name in ("locales", "swiftshader", "resources", "WidevineCdm", "MEIPreload",
                 "PrivacySandboxAttestationsPreloaded", "hyphen-data"):
        if (binaries / name).is_symlink():
            raise RuntimeError(f"Linux archive does not accept symlinks: {binaries / name}")
        if (binaries / name).is_dir():
            for path in (binaries / name).rglob("*"):
                if path.is_symlink():
                    raise RuntimeError(f"Linux archive does not accept symlinks: {path}")
                if path.is_file():
                    files[f"runtime/{path.relative_to(binaries).as_posix()}"] = path
    modules, shared_imports = web_artifacts.mojo_files(binaries / "gen/chrome/browser/bay/webui/resources/tsc")
    files.update({f"runtime/bay-ui/{name}": path for name, path in modules.items()})
    # Chromium's default-browser worker uses these sibling helpers. Keep the
    # pinned scripts and their attribution in every Linux runtime, as Helium
    # does, without depending on the build machine's xdg-utils installation.
    xdg_utils = REPO / "engine/patches/build/linux/xdg-utils"
    for name in ("xdg-settings", "xdg-mime", "LICENSE", "README.chromium", "README.bay"):
        source = xdg_utils / name
        if not source.is_file() or source.is_symlink():
            raise RuntimeError(f"missing or symlinked bundled XDG helper: {source}")
        destination = name if name.startswith("xdg-") else f"licenses/xdg-utils/{name}"
        files[f"runtime/{destination}"] = source
    identity = build_identity("linux")
    identifier = artifact_id("linux")
    with tempfile.TemporaryDirectory(prefix="bay-linux-archive-") as temporary:
        staging = pathlib.Path(temporary)
        runtime = staging / "engine"
        symbols = staging / "symbols"
        for name, source in sorted(files.items()):
            if source.is_symlink():
                raise RuntimeError(f"Linux archive does not accept symlinks: {source}")
            target = runtime / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            # Never distribute a setuid sandbox. Installation policy is separate.
            target.chmod(target.stat().st_mode & 0o777)
            if name in ("runtime/xdg-settings", "runtime/xdg-mime"):
                target.chmod(0o755)
            with target.open("rb") as stream:
                is_elf = stream.read(4) == b"\x7fELF"
            if name.removeprefix("runtime/") in executables and not is_elf:
                raise RuntimeError(f"Linux executable is not ELF: {source}")
            if is_elf:
                sections = subprocess.check_output(["readelf", "--sections", "--wide", source], text=True)
                if ".debug_info" not in sections:
                    if name.removeprefix("runtime/") in executables:
                        raise RuntimeError(f"no debug info in {source}; rebuild with symbol_level=1")
                    continue
                debug = symbols / pathlib.Path(name).parent / ".debug" / (target.name + ".debug")
                debug.parent.mkdir(parents=True, exist_ok=True)
                run(["objcopy", "--only-keep-debug", source, debug])
                debug.chmod(0o644)
                run(["strip", "--strip-debug", target])
                run(["objcopy", f"--add-gnu-debuglink={debug}", target])
        manifest = {"schemaVersion": 1, "id": identifier, **identity,
                    "files": {name: sha256(runtime / name) for name in sorted(files)},
                    "mojo": {"entrypoint": "runtime/bay-ui/" + web_artifacts.MOJO_ENTRY,
                             "sharedImports": shared_imports}}
        (runtime / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        # Finish validation and compression before publishing either archive.
        archives = []
        for directory, suffix in ((runtime, ""), (symbols, "-symbols")):
            tar_path = staging / f"{identifier}{suffix}.tar"
            with tarfile.open(tar_path, "w") as archive_file:
                for path in sorted(directory.rglob("*")):
                    if path.is_file():
                        archive_file.add(path, arcname=path.relative_to(directory).as_posix(), recursive=False)
            compressed = tar_path.with_suffix(".tar.zst")
            run(["zstd", "-T0", "-f", tar_path, "-o", compressed])
            archives.append(compressed)
        output.mkdir(parents=True, exist_ok=True)
        for path in archives:
            destination = output / path.name
            shutil.copy2(path, destination)
            destination.with_suffix(destination.suffix + ".sha256").write_text(
                f"{sha256(destination)}  {destination.name}\n")
    print(output / f"{identifier}.tar.zst")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("pin", "download", "prepare", "build", "archive", "all"))
    parser.add_argument("--platform", choices=("win", "linux"), default="win")
    parser.add_argument("--root", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path, default=REPO / "dist/engine")
    parser.add_argument("--jobs", type=int)
    parser.add_argument("--target", action="append", default=[])
    args = parser.parse_args()
    platform = args.platform
    if args.command == "pin":
        print(json.dumps({"id": artifact_id(platform), **platform_lock(platform)}, indent=2))
        return
    if sys.platform != {"win": "win32", "linux": "linux"}[platform]:
        parser.error(f"{platform} engine commands require a native {platform} host; pin works on any host")
    if platform == "linux" and host_platform.machine().lower() not in ("x86_64", "amd64"):
        parser.error("Linux engine commands require an x64 host; cross-compilation is not supported")
    if args.jobs is not None and args.jobs < 1:
        parser.error("--jobs must be positive")
    root = (args.root or default_root(platform)).resolve()
    env = environment(root, platform)
    with build_lock(root):
        check_root_platform(root, platform)
        (root / "logs").mkdir(parents=True, exist_ok=True)
        if args.command in ("download", "all"):
            download(root, env, platform)
        if args.command in ("prepare", "all"):
            prepare(root, env, platform)
        if args.command in ("build", "all"):
            build(root, env, args.target, args.jobs, platform)
        if args.command in ("archive", "all"):
            archive(root, args.output, platform)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        sys.exit(str(error))
