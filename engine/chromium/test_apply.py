"""The package overlay must be reproducible without editing the checkout source."""
import importlib.util
import hashlib
import json
import os
import re
import shutil
import struct
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zlib

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


icons = load_module("bay_windows_icons_test", HERE / "windows_icons.py")
apply = load_module("bay_chromium_apply_test", HERE / "apply.py")


class ChromiumLayerTests(unittest.TestCase):
    def test_package_overlay_is_idempotent_and_detects_drift(self):
        with tempfile.TemporaryDirectory(prefix="bay-apply-test-") as directory:
            # Freeze the inputs before applying/checking, so concurrent edits in
            # a development checkout cannot look like an overlay regression.
            checkout = Path(directory) / "checkout"
            here = checkout / "engine/chromium"
            shutil.copytree(HERE, here, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            for package in ("import", "sync"):
                for platform in ("windows", "linux"):
                    source = REPO / "packages" / package / platform
                    if source.exists():
                        shutil.copytree(source, checkout / "packages" / package / platform)
            root = Path(directory) / "chromium"
            environment = dict(os.environ, CHROMIUM_SRC=str(root), BAY_ENGINE_PLATFORM="mac")
            command = [sys.executable, str(here / "apply.py")]
            subprocess.run(command, env=environment, check=True, capture_output=True)
            target = root / "chrome/browser/bay/data/packages"
            for package, source in (("import", "ImportService.cpp"), ("sync", "SyncService.cpp")):
                copied = target / package / "windows" / source
                self.assertEqual(copied.read_bytes(), (checkout / "packages" / package / "windows" / source).read_bytes())
                self.assertFalse((target / package / "windows/tests").exists())
            for source in (checkout / "packages/import").rglob("*"):
                relative = source.relative_to(checkout / "packages/import")
                if (source.is_file() and "tests" not in relative.parts
                        and "__pycache__" not in relative.parts and source.suffix != ".pyc"):
                    self.assertEqual((target / "import" / relative).read_bytes(), source.read_bytes())
            data = target.parent
            for source in re.findall(r'"([^"\n]+\.(?:cc|cpp|h))"', (data / "BUILD.gn").read_text()):
                self.assertTrue((data / source).is_file(), f"Missing GN source {source}")
            self.assertEqual(
                hashlib.sha256((data / "vendor/nlohmann/json.hpp").read_bytes()).hexdigest(),
                "9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6",
            )
            subprocess.run([*command, "--check"], env=environment, check=True, capture_output=True)
            changed = target / "import/windows/Readers.cpp"
            changed.write_text("drift\n")
            result = subprocess.run([*command, "--check"], env=environment, capture_output=True)
            self.assertEqual(result.returncode, 1)
            subprocess.run(command, env=environment, check=True, capture_output=True)
            subprocess.run([*command, "--check"], env=environment, check=True, capture_output=True)

    def test_linux_overlay_tracks_canonical_sources_and_prunes_drift(self):
        with tempfile.TemporaryDirectory(prefix="bay-linux-overlay-test-") as directory:
            checkout = Path(directory) / "checkout"
            here = checkout / "engine/chromium"
            shutil.copytree(HERE, here, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            for package in ("import", "sync"):
                for platform in ("windows", "linux"):
                    source = REPO / "packages" / package / platform
                    if source.exists():
                        shutil.copytree(source, checkout / "packages" / package / platform)
            # Fixture-only source proves the overlay copies canonical Linux code
            # even before another platform backend has landed.
            source = checkout / "packages/import/linux/OverlayFixture.cpp"
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text("canonical linux source\n")
            tests = source.parent / "tests"
            tests.mkdir(exist_ok=True)
            (tests / "OverlayFixture.cpp").write_text("test only\n")
            root = Path(directory) / "chromium"
            environment = dict(os.environ, CHROMIUM_SRC=str(root), BAY_ENGINE_PLATFORM="linux")
            command = [sys.executable, str(here / "apply.py")]
            subprocess.run(command, env=environment, check=True, capture_output=True)
            copied = root / "chrome/browser/bay/data/packages/import/linux/OverlayFixture.cpp"
            self.assertEqual(copied.read_bytes(), source.read_bytes())
            self.assertFalse((copied.parent / "tests").exists())
            before = copied.stat().st_mtime_ns
            subprocess.run(command, env=environment, check=True, capture_output=True)
            self.assertEqual(before, copied.stat().st_mtime_ns)
            source.write_text("changed canonical linux source\n")
            result = subprocess.run([*command, "--check"], env=environment, capture_output=True)
            self.assertEqual(result.returncode, 1)
            subprocess.run(command, env=environment, check=True, capture_output=True)
            self.assertEqual(copied.read_bytes(), source.read_bytes())
            source.unlink()
            subprocess.run(command, env=environment, check=True, capture_output=True)
            self.assertFalse(copied.exists())
            subprocess.run([*command, "--check"], env=environment, check=True, capture_output=True)

    def test_windows_icons_are_owned_as_files_and_other_platforms_leave_them_alone(self):
        with tempfile.TemporaryDirectory(prefix="bay-icon-overlay-test-") as directory:
            checkout = Path(directory) / "checkout"
            here = checkout / "engine/chromium"
            shutil.copytree(HERE, here, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            for package in ("import", "sync"):
                for platform in ("windows", "linux"):
                    source = REPO / "packages" / package / platform
                    if source.exists():
                        shutil.copytree(source, checkout / "packages" / package / platform)
            root = Path(directory) / "chromium"
            environment = dict(os.environ, CHROMIUM_SRC=str(root), BAY_ENGINE_PLATFORM="win")
            command = [sys.executable, str(here / "apply.py")]
            untouched = root / "chrome/app/theme/chromium/win/incognito.ico"
            untouched.parent.mkdir(parents=True)
            untouched.write_bytes(b"upstream privacy icon")
            subprocess.run(command, env=environment, check=True, capture_output=True)
            expected = (here / "assets/windows/bay.ico").read_bytes()
            for path in apply.WINDOWS_ICONS:
                self.assertEqual((root / path).read_bytes(), expected)
            paths = json.loads(subprocess.check_output([*command, "--list-paths"], env=environment))
            for path in apply.WINDOWS_ICONS:
                self.assertIn([path, False], paths)
            modified = {path: (root / path).stat().st_mtime_ns for path in apply.WINDOWS_ICONS}
            subprocess.run(command, env=environment, check=True, capture_output=True)
            self.assertEqual(modified, {path: (root / path).stat().st_mtime_ns
                                       for path in apply.WINDOWS_ICONS})
            target = root / apply.WINDOWS_ICONS[0]
            target.write_bytes(b"drift")
            checked = subprocess.run([*command, "--check"], env=environment, capture_output=True)
            self.assertEqual(checked.returncode, 1)
            self.assertIn(apply.WINDOWS_ICONS[0].encode(), checked.stdout)
            for platform in ("mac", "linux"):
                environment["BAY_ENGINE_PLATFORM"] = platform
                subprocess.run(command, env=environment, check=True, capture_output=True)
                subprocess.run([*command, "--check"], env=environment, check=True, capture_output=True)
                self.assertEqual(target.read_bytes(), b"drift")
                paths = json.loads(subprocess.check_output([*command, "--list-paths"], env=environment))
                self.assertFalse(any(path in apply.WINDOWS_ICONS for path, _ in paths))
            environment["BAY_ENGINE_PLATFORM"] = "win"
            subprocess.run(command, env=environment, check=True, capture_output=True)
            subprocess.run([*command, "--check"], env=environment, check=True, capture_output=True)
            self.assertEqual(target.read_bytes(), expected)
            self.assertEqual(untouched.read_bytes(), b"upstream privacy icon")

    def test_engine_digest_tracks_production_data_code(self):
        spec = importlib.util.spec_from_file_location("bay_engine_digest_test", REPO / "scripts/windows/engine.py")
        engine = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(engine)
        with tempfile.TemporaryDirectory(prefix="bay-digest-test-") as directory:
            original = engine.REPO
            engine.REPO = Path(directory)
            try:
                production = engine.REPO / "packages/import/windows/Readers.cpp"
                production.parent.mkdir(parents=True)
                production.write_text("before\n")
                before = engine.source_digest()
                production.write_text("after\n")
                after = engine.source_digest()
                self.assertNotEqual(before, after)
                test_file = production.parent / "tests/Readers.cpp"
                test_file.parent.mkdir()
                test_file.write_text("test-only\n")
                self.assertEqual(after, engine.source_digest())
                for relative in ("packages/import/windows/BrowserDiscovery.cpp",
                                 "packages/import/linux/ChromiumSecrets.cpp",
                                 "packages/sync/linux/Backend.cpp"):
                    source = engine.REPO / relative
                    source.parent.mkdir(parents=True, exist_ok=True)
                    source.write_text("before\n")
                    before = engine.source_digest("linux")
                    source.write_text("after\n")
                    after = engine.source_digest("linux")
                    self.assertNotEqual(before, after, relative)
                    test = source.parent / "tests/DigestFixture.cpp"
                    test.parent.mkdir(exist_ok=True)
                    test.write_text("test-only\n")
                    self.assertEqual(after, engine.source_digest("linux"))
                icon = engine.REPO / "engine/chromium/assets/windows/bay.ico"
                icon.parent.mkdir(parents=True)
                icon.write_bytes(b"before")
                before = engine.source_digest()
                icon.write_bytes(b"after")
                self.assertNotEqual(before, engine.source_digest())
            finally:
                engine.REPO = original


class WindowsIconTests(unittest.TestCase):
    def test_committed_icon_matches_assets_and_has_valid_rgba_entries(self):
        icon = icons.OUTPUT.read_bytes()
        self.assertEqual(icon, icons.build_icon())
        self.assertEqual(struct.unpack_from("<HHH", icon), (0, 1, 5))
        offset = 6 + 5 * 16
        for i, (size, name) in enumerate(icons.IMAGES):
            width, height, colors, reserved, planes, bits, length, start = struct.unpack_from(
                "<BBBBHHII", icon, 6 + i * 16)
            self.assertEqual((width or 256, height or 256, colors, reserved, planes, bits),
                             (size, size, 0, 0, 1, 32))
            self.assertEqual(start, offset)
            png = icon[start:start + length]
            self.assertEqual(len(png), length)
            parts = icons.chunks(png)  # Checks every PNG chunk length and CRC.
            self.assertEqual(struct.unpack(">IIBBBBB", parts[0][1]), (size, size, 8, 6, 0, 0, 0))
            raw = zlib.decompress(b"".join(data for kind, data in parts if kind == b"IDAT"))
            self.assertEqual(len(raw), (size * 4 + 1) * size)
            if size != 16:
                self.assertEqual(png, (icons.ASSETS / name).read_bytes())
            offset += length
        self.assertEqual(offset, len(icon))

    def test_palette_expansion_preserves_pixels_for_every_png_filter(self):
        # These scanlines encode the five known pixel rows using filters 0..4.
        rows = ((0, 1, 2, 1, 0), (2, 2, 1, 0, 1), (1, 0, 2, 2, 1),
                (0, 1, 1, 2, 0), (2, 0, 1, 0, 2))
        filtered = bytes((0, 0, 1, 2, 1, 0,
                          1, 2, 0, 255, 255, 1,
                          2, 255, 254, 1, 2, 0,
                          3, 0, 1, 0, 1, 255,
                          4, 2, 254, 1, 254, 2))
        png = (icons.PNG_SIGNATURE + icons.chunk(b"IHDR", struct.pack(">IIBBBBB", 5, 5, 8, 3, 0, 0, 0)) +
               icons.chunk(b"PLTE", bytes((255, 0, 0, 0, 255, 0, 0, 0, 255))) +
               icons.chunk(b"tRNS", bytes((0, 128))) +
               icons.chunk(b"IDAT", zlib.compress(filtered)) + icons.chunk(b"IEND", b""))
        converted = icons.chunks(icons.rgba_png(png, 5))
        pixels = (b"\xff\x00\x00\x00", b"\x00\xff\x00\x80", b"\x00\x00\xff\xff")
        expected = b"".join(b"\x00" + b"".join(pixels[index] for index in row) for row in rows)
        actual = zlib.decompress(b"".join(data for kind, data in converted if kind == b"IDAT"))
        self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
