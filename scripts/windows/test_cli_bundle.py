"""Desktop CLI staging verifies the platform and executable before copying it."""
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("build_cli", ROOT / "scripts/build-cli.py")
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class CliBundleTests(unittest.TestCase):
    def test_platform_bundle_stages_only_verified_files_and_refuses_tampering(self):
        for platform, (_, name, label) in bundle.TARGETS.items():
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                source = root / "source"
                source.mkdir()
                (source / name).write_bytes(b"standalone cli")
                (source / "manifest.json").write_text(json.dumps({
                    "version": "1.2.3-beta.1", "platform": label,
                    "sha256": hashlib.sha256(b"standalone cli").hexdigest()}))
                (source / "unrelated.txt").write_text("do not ship")
                bundle.stage(source, root / "app", platform)
                self.assertEqual({path.name for path in (root / "app").iterdir()}, {name, "manifest.json"})
                with self.assertRaisesRegex(ValueError, "platform"):
                    bundle.validate(source, "win" if platform == "linux" else "linux")
                (source / name).write_bytes(b"changed")
                with self.assertRaisesRegex(ValueError, "checksum"):
                    bundle.stage(source, root / "bad", platform)
                self.assertFalse((root / "bad").exists())

    def test_invalid_version_is_not_used_as_a_bundled_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "bay").write_bytes(b"standalone cli")
            (root / "manifest.json").write_text(json.dumps({
                "version": "../../1.2.3", "platform": "linux-x64",
                "sha256": hashlib.sha256(b"standalone cli").hexdigest()}))
            with self.assertRaisesRegex(ValueError, "version"):
                bundle.validate(root, "linux")


if __name__ == "__main__":
    unittest.main()
