"""Check how bay-engine.aar is finished: assets, the R classes the app must generate, app-supplied classes and the
Java resources classes.jar keeps."""
import importlib.util
import io
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
    " public static int ids() { return org.chromium.ui.R.string.ok + androidx.core.Thing.value()"
    " + android.R.drawable.ic_media_play; } }",
    "android/R.java": "package android; public final class R {"
    " public static final class drawable { public static int ic_media_play = 3; } }",
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
            jar.writestr("META-INF/services/org.chromium.base.Thing", "org.chromium.base.ThingImpl\n")
            jar.writestr("org/chromium/base/data.txt", "data")
            jar.writestr("play-services-basement.properties", "version=1")
            jar.writestr("LICENSE.txt", "licence")
        self.aar = self.base / "base.aar"
        with zipfile.ZipFile(self.aar, "w") as aar:
            aar.write(self.jar, "classes.jar")
            aar.writestr("AndroidManifest.xml", '<manifest package="org.bay.engine"/>')
            aar.writestr("R.txt", "int attr layout 0x0\nint attr layout 0x7f010001\nint string ok 0x7f010001\n"
                         "int styleable Bar_color 1\nint styleable BarLayout_gravity 1\nint styleable Bar_size 1\n"
                         "int[] styleable Bar {0x7f010001}\nint[] styleable BarLayout { 0x0 }\n")
            aar.writestr("res/0_res/layout/item.xml", "<View/>")
            aar.writestr("res/values-de/strings_2.xml", "<resources/>")

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
            self.assertEqual(aar.read("R.txt").decode(), "int attr layout 0x0\nint string ok 0x7f010001\n"
                             "int[] styleable Bar { 0x0, 0x0 }\nint styleable Bar_color 0\nint styleable Bar_size 1\n"
                             "int[] styleable BarLayout { 0x0 }\nint styleable BarLayout_gravity 0\n")
            self.assertIn("res/layout/item.xml", aar.namelist())
            self.assertIn("res/values-de/strings_2.xml", aar.namelist())
            self.assertFalse([name for name in aar.namelist() if name.startswith("res/0_res/")])
            with zipfile.ZipFile(io.BytesIO(aar.read("classes.jar"))) as jar:
                self.assertEqual(sorted(jar.namelist()), ["META-INF/services/org.chromium.base.Thing",
                                                          "org/bay/engine/Uses.class", "org/chromium/base/data.txt"])

    def test_attributes_are_defined_once_per_folder(self):
        files = [
            ("res/0_res/values/attrs_1.xml", b'<resources><declare-styleable name="Stub">'
             b'<attr name="layout" format="reference"/></declare-styleable></resources>'),
            ("res/values/values_2.xml", b'<resources xmlns:tools="http://schemas.android.com/tools">'
             b'<attr name="elevation" format="dimension"/><declare-styleable name="SearchView">'
             b'<attr name="layout" format="reference"/><attr name="android:focusable"/></declare-styleable>'
             b'</resources>'),
            ("res/values/values_3.xml", b'<resources><declare-styleable name="Bar">'
             b'<attr name="elevation" format="dimension"/></declare-styleable><attr name="elevation"'
             b' format="dimension"/></resources>'),
            ("res/values-v21/values_4.xml", b'<resources><attr name="elevation" format="dimension"/></resources>'),
        ]
        changed = package_aar.single_attribute_definitions(files)
        self.assertEqual(sorted(changed), ["res/values/values_2.xml", "res/values/values_3.xml"])
        self.assertIn(b'<attr name="layout" /><attr name="android:focusable" />', changed["res/values/values_2.xml"])
        self.assertIn(b'<attr name="elevation" format="dimension" />', changed["res/values/values_2.xml"])
        self.assertTrue(changed["res/values/values_3.xml"].endswith(
            b'<resources><declare-styleable name="Bar"><attr name="elevation" /></declare-styleable></resources>'))

    def test_gn_lists_parse(self):
        self.assertEqual(package_aar.parse_gn_list('["androidx/*", "kotlin/*"]'), ["androidx/*", "kotlin/*"])
        self.assertEqual(package_aar.parse_gn_list("[]"), [])


if __name__ == "__main__":
    unittest.main()
