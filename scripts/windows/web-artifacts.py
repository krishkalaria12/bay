"""Validate the local WebUI export and generated Mojo module dependency graph."""
from __future__ import annotations

from html.parser import HTMLParser
import hashlib
import json
import pathlib
import posixpath
import re
import urllib.parse

APP_MANIFEST = "app-manifest.json"
MOJO_ENTRY = "native_host.mojom-webui.js"
SHARED_PREFIXES = ("chrome://resources/", "//resources/")
IMPORT = re.compile(r'''^\s*(?:import|export)\s+(?:[^;]*?\sfrom\s*)?["']([^"']+)["']''', re.MULTILINE)
DYNAMIC_IMPORT = re.compile(r'''\bimport\s*\(\s*["']([^"']+)["']\s*\)''')


def digest(path):
    result = hashlib.sha256()
    with pathlib.Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def local_reference(reference, parent=""):
    parsed = urllib.parse.urlsplit(reference)
    if parsed.scheme or parsed.netloc:
        raise ValueError(f"WebUI resource must be local: {reference}")
    path = urllib.parse.unquote(parsed.path)
    if not path or "\\" in path or ":" in path or "\0" in path:
        raise ValueError(f"invalid WebUI resource path: {reference}")
    # URL resolution permits parent traversal within the bundle, but never out.
    path = posixpath.normpath(path.lstrip("/") if path.startswith("/") else posixpath.join(parent, path))
    if path in (".", "..") or path.startswith("../"):
        raise ValueError(f"WebUI resource escapes its bundle: {reference}")
    return path


def mojo_files(directory):
    """All local ES imports reachable from NativeHost; shared Mojo stays in PAKs.

    M154 mojom_ts_generator._GetBindingsLibraryPath emits
    //resources/mojo/mojo/public/js/bindings.js. That module concatenates control
    messages and interface support; Chromium's SharedResourcesDataSource serves
    it from resources.pak. It must not be copied from the legacy JS generator.
    """
    directory = pathlib.Path(directory)
    pending, found, shared = [MOJO_ENTRY], {}, set()
    while pending:
        name = pending.pop()
        if name in found:
            continue
        path = directory / name
        if not path.is_file():
            raise ValueError(f"generated Mojo module dependency is missing: {path}")
        found[name] = path
        source = path.read_text(encoding="utf-8")
        for reference in [*IMPORT.findall(source), *DYNAMIC_IMPORT.findall(source)]:
            if reference.startswith(SHARED_PREFIXES):
                shared.add(reference)
                continue
            pending.append(local_reference(reference, posixpath.dirname(name)))
    return found, sorted(shared)


class EntryParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.has_root = False
        self.scripts = []
        self.resources = []

    def handle_starttag(self, tag, attributes):
        attributes = dict(attributes)
        self.has_root |= attributes.get("id") == "root"
        if tag == "script":
            if not attributes.get("src"):
                raise ValueError("the WebUI entrypoint must not contain inline executable scripts")
            self.scripts.append((attributes["src"], attributes.get("type", "")))
        if tag == "link" and attributes.get("rel") in ("stylesheet", "modulepreload", "preload"):
            if attributes.get("href"):
                self.resources.append(attributes["href"])


def validate_entrypoint(directory):
    directory = pathlib.Path(directory)
    entrypoint = directory / "index.html"
    if not entrypoint.is_file():
        raise ValueError(f"the web export has no index.html: {directory}")
    parser = EntryParser()
    parser.feed(entrypoint.read_text(encoding="utf-8"))
    if not parser.has_root:
        raise ValueError("the WebUI entrypoint has no root element")
    scripts = [(local_reference(name), kind) for name, kind in parser.scripts]
    if ("bay-native-host.js", "module") not in scripts:
        raise ValueError("the WebUI entrypoint does not load the native Mojo bootstrap module")
    if not any(name != "bay-native-host.js" for name, _ in scripts):
        raise ValueError("the WebUI entrypoint does not load an application script")
    for name in [*(name for name, _ in scripts), *(local_reference(name) for name in parser.resources)]:
        if not (directory / name).is_file():
            raise ValueError(f"the WebUI entrypoint references a missing resource: {name}")
    return {"entrypoint": "bay-ui/index.html", "bootstrap": "bay-ui/bay-native-host.js",
            "scripts": ["bay-ui/" + name for name, _ in scripts]}


def write_manifest(directory, engine_id, platform="windows"):
    directory = pathlib.Path(directory)
    ui = validate_entrypoint(directory / "bay-ui")
    modules, shared = mojo_files(directory / "bay-ui")
    ui.update(nativeHostModule="bay-ui/" + MOJO_ENTRY, sharedMojoImports=shared)
    manifest = {"schemaVersion": 1, "engineId": engine_id, "platform": platform, "architecture": "x64", "ui": ui,
                "files": {path.relative_to(directory).as_posix(): digest(path) for path in sorted(directory.rglob("*"))
                          if path.is_file() and path.relative_to(directory).as_posix() != APP_MANIFEST}}
    (directory / APP_MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def verify_manifest(directory):
    directory = pathlib.Path(directory)
    manifest = json.loads((directory / APP_MANIFEST).read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1:
        raise ValueError("unsupported application manifest schema")
    names = {path.relative_to(directory).as_posix() for path in directory.rglob("*") if path.is_file()}
    if names != {*manifest["files"], APP_MANIFEST}:
        raise ValueError("application files do not match the release manifest")
    for name, checksum in manifest["files"].items():
        if local_reference(name) != name or digest(directory / name) != checksum:
            raise ValueError(f"application checksum mismatch: {name}")
    if validate_entrypoint(directory / "bay-ui") != {key: manifest["ui"][key] for key in ("entrypoint", "bootstrap", "scripts")}:
        raise ValueError("application UI entrypoint does not match the release manifest")
    modules, shared = mojo_files(directory / "bay-ui")
    if manifest["ui"].get("nativeHostModule") != "bay-ui/" + MOJO_ENTRY or manifest["ui"].get("sharedMojoImports") != shared:
        raise ValueError("application Mojo dependencies do not match the release manifest")
    return manifest
