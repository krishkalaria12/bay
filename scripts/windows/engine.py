#!/usr/bin/env python3
"""Pinned Windows x64 engine: download, prepare, build, archive or describe the pin.

Run on Windows from a VS 2026 Developer PowerShell with C++/ATL/MFC and the
10.0.28000.2270 SDK installed. Use a short NTFS path such as C:\\bay-engine.
All subprocess failures stop the build. Existing checkouts are never reset.
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
import shutil
import subprocess
import sys
import urllib.request
import zipfile

REPO = pathlib.Path(__file__).resolve().parents[2]
LOCK_PATH = REPO / "engine/patches/build/engine-lock.json"
LOCK = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
WEB_SPEC = importlib.util.spec_from_file_location("bay_web_artifacts", pathlib.Path(__file__).with_name("web-artifacts.py"))
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


def sha256(path):
    digest = hashlib.sha256()
    with pathlib.Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_digest():
    digest = hashlib.sha256()
    for directory in ("engine/patches", "engine/chromium", "engine/nncore",
                      "packages/import/windows", "packages/sync/windows"):
        for path in sorted((REPO / directory).rglob("*")):
            package_test = directory.startswith("packages/") and "tests" in path.relative_to(REPO / directory).parts
            if path.is_file() and not package_test and "__pycache__" not in path.parts and path.suffix != ".pyc":
                digest.update(path.relative_to(REPO).as_posix().encode() + b"\0")
                digest.update(bytes.fromhex(sha256(path)))
    digest.update(bytes.fromhex(sha256(pathlib.Path(__file__))))
    digest.update(bytes.fromhex(sha256(pathlib.Path(__file__).with_name("web-artifacts.py"))))
    return digest.hexdigest()


def artifact_id():
    return f"bay-engine-{LOCK['chromium']}-windows-x64-{source_digest()[:16]}"


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


def environment(root):
    env = dict(os.environ)
    paths = [str(root / "depot_tools")]
    git = shutil.which("git")
    if git:
        # Git for Windows ships GNU patch; no MSYS shell is needed.
        paths.append(str(pathlib.Path(git).resolve().parents[1] / "usr/bin"))
    env.update(PATH=os.pathsep.join([*paths, env.get("PATH", "")]),
               CB=str(root), CHROMIUM_SRC=str(root / "chromium_git/chromium/src"),
               NN_REPO=str(REPO), NN_SERIES_BASE=str(root / "series-base-win"),
               DEPOT_TOOLS_WIN_TOOLCHAIN="0", DEPOT_TOOLS_UPDATE="0", DEPOT_TOOLS_METRICS="0",
               CEF_USE_GN="1", CEF_ENABLE_ARM64="0", GN_OUT_CONFIGS="Release_GN_x64",
               PYTHONUNBUFFERED="1")
    env["GN_DEFINES"] = " ".join(f"{key}={json.dumps(value)}" for key, value in GN_ARGS.items())
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


def download(root, env):
    if (root / "chromium_git/chromium/src/out/Release_GN_x64/build.ninja").exists():
        raise RuntimeError("an engine build exists; use build rather than downloading into a prepared tree")
    for name, url, revision in (
        ("depot_tools", "https://chromium.googlesource.com/chromium/tools/depot_tools.git", LOCK["depotToolsCommit"]),
        ("ungoogled", "https://github.com/ungoogled-software/ungoogled-chromium.git", LOCK["ungoogledCommit"]),
    ):
        clone_pin(url, root / name, revision)
    automate = root / "automate/automate-git.py"
    automate.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://raw.githubusercontent.com/chromiumembedded/cef/{LOCK['cefCommit']}/tools/automate/automate-git.py"
    with urllib.request.urlopen(url, timeout=90) as response:
        automate.write_bytes(response.read())
    run([sys.executable, automate, f"--download-dir={root / 'chromium_git'}",
         f"--depot-tools-dir={root / 'depot_tools'}", f"--branch={LOCK['cefBranch']}",
         f"--checkout={LOCK['cefCommit']}", "--no-chromium-history", "--x64-build",
         "--no-debug-build", "--no-build", "--no-distrib"], env=env)
    verify_checkout(root)


def verify_checkout(root):
    src = root / "chromium_git/chromium/src"
    version = dict(line.split("=", 1) for line in (src / "chrome/VERSION").read_text().splitlines() if "=" in line)
    actual = ".".join(version[key] for key in ("MAJOR", "MINOR", "BUILD", "PATCH"))
    if actual != LOCK["chromium"]:
        raise RuntimeError(f"Chromium version {actual} does not match {LOCK['chromium']}")
    actual_cef = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=src / "cef", text=True).strip()
    if actual_cef != LOCK["cefCommit"]:
        raise RuntimeError(f"CEF revision {actual_cef} does not match engine-lock.json")


def series(root, env, command, *options):
    run([sys.executable, REPO / "engine/patches/series.py", command, "--platform", "win", *options], env=env)


def prepare(root, env):
    verify_checkout(root)
    src = pathlib.Path(env["CHROMIUM_SRC"])
    state = root / "bay-prepare-state.json"
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
    generate_gn(root, env)
    (root / "bay-engine-source.json").write_text(json.dumps({"lock": LOCK, "sourceDigest": source_digest()}, indent=2) + "\n")


def generate_gn(root, env):
    src = pathlib.Path(env["CHROMIUM_SRC"])
    # Chrome uses ordinary GN args. CEF's config merger would add client API
    # and CDM requirements that this desktop Chrome target does not need.
    directory = src / LOCK["outputDirectory"]
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "args.gn").write_text("\n".join(f"{key} = {json.dumps(value)}" for key, value in GN_ARGS.items()) + "\n")
    run(["gn", "gen", LOCK["outputDirectory"]], cwd=src, env=env)


def build(root, env, targets, jobs):
    verify_checkout(root)
    series(root, env, "apply", "--phase", "chromium")
    series(root, env, "check")
    generate_gn(root, env)
    src = pathlib.Path(env["CHROMIUM_SRC"])
    args = ["autoninja", "-C", LOCK["outputDirectory"]]
    if jobs:
        args += ["-j", str(jobs)]
    run([*args, *(targets or ["chrome"])], cwd=src, env=env)
    (root / "bay-engine-build.json").write_text(json.dumps({"lock": LOCK, "sourceDigest": source_digest()}, indent=2) + "\n")


def archive(root, output):
    verify_checkout(root)
    stamp = root / "bay-engine-build.json"
    if not stamp.exists() or json.loads(stamp.read_text()) != {"lock": LOCK, "sourceDigest": source_digest()}:
        raise RuntimeError("engine sources changed since the last successful build; run build before archiving")
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
        if path.is_file() and path.suffix.lower() in (".dll", ".exe", ".lib", ".pak", ".dat", ".bin", ".json") and not path.name.lower().startswith(("libcef", "nncore", "bootstrap")):
            files[f"{'lib' if path.suffix.lower() == '.lib' else 'runtime'}/{path.name}"] = path
    for name in ("locales", "swiftshader", "resources", "WidevineCdm", "MEIPreload", "PrivacySandboxAttestationsPreloaded", "hyphen-data"):
        if (binaries / name).is_dir():
            for path in (binaries / name).rglob("*"):
                if path.is_file():
                    files[f"runtime/{path.relative_to(binaries).as_posix()}"] = path
    generated_mojo = binaries / "gen/chrome/browser/bay/webui/resources/tsc"
    modules, shared_imports = web_artifacts.mojo_files(generated_mojo)
    for name, path in modules.items():
        files[f"runtime/bay-ui/{name}"] = path
    for prefix, directory in (("include/nncore", REPO / "engine/nncore/src/bay/core/public"),
                              ("include/bay", REPO / "engine/chromium/src/chrome/browser/bay/public")):
        for path in directory.rglob("*.h"):
            files[f"{prefix}/{path.relative_to(directory).as_posix()}"] = path
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("pin", "download", "prepare", "build", "archive", "all"))
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path(os.environ.get("BAY_ENGINE_ROOT", "C:/bay-engine")))
    parser.add_argument("--output", type=pathlib.Path, default=REPO / "dist/engine")
    parser.add_argument("--jobs", type=int)
    parser.add_argument("--target", action="append", default=[])
    args = parser.parse_args()
    if args.command == "pin":
        print(json.dumps({"id": artifact_id(), **LOCK}, indent=2))
        return
    if sys.platform != "win32":
        parser.error("Windows engine builds require Windows; pin and the script tests run on macOS")
    root = args.root.resolve()
    env = environment(root)
    (root / "logs").mkdir(parents=True, exist_ok=True)
    with build_lock(root):
        if args.command in ("download", "all"):
            download(root, env)
        if args.command in ("prepare", "all"):
            prepare(root, env)
        if args.command in ("build", "all"):
            build(root, env, args.target, args.jobs)
        if args.command in ("archive", "all"):
            archive(root, args.output)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        sys.exit(str(error))
