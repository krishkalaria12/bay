"""Check how bay-engine.aar is finished: assets, the R classes the app must generate, and app-supplied classes."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "engine/android/src/bay/mobile/package_aar.py"
SPEC = importlib.util.spec_from_file_location("bay_package_aar", SCRIPT)
package_aar = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package_aar)

SOURCES = {
    "org/chromium/ui/R.java": "package org.chromium.ui; public final class R {"
    " public static final class string { public static int ok = 1; } }",
    "androidx/core/Thing.java": "package androidx.core; public final class Thing { public static int value() { return 2; } }",
    "org/bay/engine/Uses.java": "package org.bay.engine; public final class Uses {"
    " public static int ids() { return org.chromium.ui.R.string.ok + androidx.core.Thing.value(); } }",
}


@unittest.skipUnless(shutil.which("javac"), "javac compiles the sample classes")
class PackageAarTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base)
        source = self.base / "src"
        for name, text in SOURCES.items():
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        classes = self.base / "classes"
        subprocess.run(["javac", "-d", classes, *[source / name for name in SOURCES]], check=True)
        # Like dist_aar's output: Chromium's R classes and the app-supplied ones aren't in the jar.
        self.jar = self.base / "classes.jar"
        with zipfile.ZipFile(self.jar, "w") as jar:
            jar.write(classes / "org/bay/engine/Uses.class", "org/bay/engine/Uses.class")
        self.aar = self.base / "base.aar"
        with zipfile.ZipFile(self.aar, "w") as aar:
            aar.write(self.jar, "classes.jar")
            aar.writestr("AndroidManifest.xml", '<manifest package="org.bay.engine"/>')
            aar.writestr("R.txt", "int string ok 0x7f010001\n")

    def test_scan_finds_missing_r_and_app_classes(self):
        defined, referenced = package_aar.scan_jar(self.jar.read_bytes())
        self.assertEqual(package_aar.missing_r_packages(defined, referenced), ["org.chromium.ui"])
        self.assertEqual(package_aar.app_supplied_packages(defined, referenced, ["androidx/*"]), ["androidx.core"])

    def test_package_adds_assets_and_lists(self):
        pak = self.base / "bay_engine.pak"
        pak.write_bytes(b"pak")
        output = self.base / "bay-engine.aar"
        package_aar.main(["--base-aar", str(self.aar), "--output", str(output), "--asset", f"{pak}:bay_engine.pak",
                          '--excluded-classes=["androidx/*", "com/google/*"]'])
        with zipfile.ZipFile(output) as aar:
            self.assertEqual(aar.read("assets/bay_engine.pak"), b"pak")
            self.assertEqual(aar.getinfo("assets/bay_engine.pak").compress_type, zipfile.ZIP_STORED)
            self.assertEqual(aar.read("bay-engine/r-packages.txt"), b"org.chromium.ui\n")
            self.assertEqual(aar.read("bay-engine/app-classes.txt"), b"androidx.core\n")
            self.assertIn("classes.jar", aar.namelist())
            self.assertIn("AndroidManifest.xml", aar.namelist())

    def test_gn_lists_parse(self):
        self.assertEqual(package_aar.parse_gn_list('["androidx/*", "kotlin/*"]'), ["androidx/*", "kotlin/*"])
        self.assertEqual(package_aar.parse_gn_list("[]"), [])


if __name__ == "__main__":
    unittest.main()
