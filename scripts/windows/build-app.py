#!/usr/bin/env python3
"""Build the React web bundle and stage it with the verified Chrome runtime."""
import argparse
import importlib.util
import pathlib
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("fetch_engine", HERE / "fetch-engine.py")
fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch)
REPO = HERE.parents[1]
web_artifacts = fetch.engine.web_artifacts


def stage(engine, web_directory, destination):
    manifest = fetch.verify(engine, fetch.engine.artifact_id())
    runtime = engine / "runtime"
    for name in ("chrome.exe", "chrome.dll", "chrome_elf.dll", "notification_helper.exe", "resources.pak", "icudtl.dat", "bay-ui/native_host.mojom-webui.js"):
        if not (runtime / name).is_file():
            raise ValueError(f"Chrome engine runtime is missing {name}")
    if any(path.name.lower().startswith(("libcef", "nncore", "bootstrap")) for path in runtime.iterdir() if path.is_file()):
        raise ValueError("CEF runtime files are not supported by the Chrome desktop host")
    web_artifacts.validate_entrypoint(web_directory)
    web_artifacts.mojo_files(runtime / "bay-ui")
    if destination.exists():
        raise ValueError(f"{destination} already exists; use a fresh output directory to avoid stale runtime files")
    # All verification finishes before creating the app directory.
    shutil.copytree(runtime, destination)
    shutil.copytree(web_directory, destination / "bay-ui", dirs_exist_ok=True)
    # The generated Mojo bindings belong to the engine revision and take
    # precedence over any stale bindings left in a web export.
    shutil.copytree(runtime / "bay-ui", destination / "bay-ui", dirs_exist_ok=True)
    # Keep the Chrome target's binary unchanged except its browser-facing name.
    (destination / "chrome.exe").rename(destination / "Bay.exe")
    shutil.copy2(engine / "manifest.json", destination / "engine-manifest.json")
    web_artifacts.write_manifest(destination, manifest["id"])
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", type=pathlib.Path)
    parser.add_argument("--verify", type=pathlib.Path, help="verify a staged release including its UI entrypoint")
    parser.add_argument("--web-directory", type=pathlib.Path, default=REPO / "apps/browser/dist")
    parser.add_argument("--output", type=pathlib.Path, default=REPO / "dist/windows-app")
    parser.add_argument("--skip-web-build", action="store_true", help="stage an existing web export")
    args = parser.parse_args()
    if args.verify:
        web_artifacts.verify_manifest(args.verify.resolve())
        print(f"Verified staged release: {args.verify}")
        return
    if args.engine is None:
        parser.error("--engine is required unless --verify is supplied")
    if not args.skip_web_build:
        command = ["pnpm", "--filter", "@bay/browser", "build:web"]
        if sys.platform == "win32":
            command[0] = shutil.which("pnpm.cmd") or shutil.which("pnpm") or "pnpm"
        subprocess.run(command, cwd=REPO, check=True)
    stage(args.engine.resolve(), args.web_directory.resolve(), args.output.resolve())
    print(args.output / "Bay.exe")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
