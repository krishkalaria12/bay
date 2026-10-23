"""Linux packaging against fixture engine archives: no engine build or Linux desktop needed."""
import importlib.util
import json
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build_app = load("build_app", HERE / "build-app.py")
engine = build_app.engine
ELF = pathlib.Path(shutil.which("true") or "/usr/bin/true")


def make_runtime(directory):
    """A runtime with every file the builder requires; the executables are a real ELF so ldd can read them."""
    runtime = directory / "runtime"
    (runtime / "locales").mkdir(parents=True)
    (runtime / "bay-ui").mkdir()
    for name in ("bay", "chrome_sandbox", "chrome_crashpad_handler"):
        shutil.copy2(ELF, runtime / name)
    for name, text in (("resources.pak", "pak"), ("icudtl.dat", "icu"), ("locales/en-US.pak", "en"), ("xdg-settings", "#!/bin/sh\n")):
        (runtime / name).write_text(text)
    (runtime / "bay-ui" / "native_host.mojom-webui.js").write_text("import '//resources/mojo/mojo/public/js/bindings.js';\n")
    return runtime


def write_manifest(directory, **changes):
    files = {path.relative_to(directory).as_posix(): engine.sha256(path) for path in sorted((directory / "runtime").rglob("*")) if path.is_file()}
    manifest = {"schemaVersion": 1, "id": engine.artifact_id("linux"), "lock": engine.platform_lock("linux"), "files": files, **changes}
    (directory / "manifest.json").write_text(json.dumps(manifest))


def pack(directory, archive):
    with tarfile.open(archive.with_suffix(""), "w") as tar:
        for path in sorted(directory.rglob("*")):
            tar.add(path, arcname=path.relative_to(directory).as_posix(), recursive=False)
    subprocess.run(["zstd", "-q", "-f", "--rm", archive.with_suffix(""), "-o", archive], check=True)
    return archive


def make_web(directory):
    directory.mkdir()
    (directory / "index.html").write_text(
        '<!doctype html><div id="root"></div><script type="module" src="bay-native-host.js"></script><script src="app.js"></script>'
    )
    (directory / "bay-native-host.js").write_text("")
    (directory / "app.js").write_text("")
    return directory


class BuildAppTests(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="bay-packaging-test-"))
        self.addCleanup(shutil.rmtree, self.root)
        self.engine = self.root / "engine"
        make_runtime(self.engine)
        write_manifest(self.engine)
        self.web = make_web(self.root / "web")

    def test_stages_runtime_ui_and_wrapper_with_a_verifiable_manifest(self):
        app = self.root / "app"
        extracted = self.root / "extracted"
        build_app.extract(pack(self.engine, self.root / "engine.tar.zst"), extracted)
        build_app.stage(extracted, self.web, app)
        for name in ("bay", "bay-wrapper", "bay-ui/index.html", "bay-ui/native_host.mojom-webui.js", "engine-manifest.json"):
            self.assertTrue((app / name).is_file(), name)
        self.assertEqual(build_app.web_artifacts.verify_manifest(app)["platform"], "linux")

    def test_rejects_a_runtime_that_does_not_match_its_manifest(self):
        (self.engine / "runtime/resources.pak").write_text("changed")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            build_app.stage(self.engine, self.web, self.root / "app")
        self.assertFalse((self.root / "app").exists())

    def test_rejects_another_platforms_engine(self):
        write_manifest(self.engine, lock=engine.platform_lock("win"))
        with self.assertRaisesRegex(ValueError, "pinned version"):
            build_app.stage(self.engine, self.web, self.root / "app")

    def test_refuses_archive_members_outside_the_destination(self):
        evil = self.root / "evil"
        (evil / "runtime").mkdir(parents=True)
        (evil / "runtime/x").write_text("x")
        archive = self.root / "evil.tar"
        with tarfile.open(archive, "w") as tar:
            tar.add(evil / "runtime/x", arcname="../outside")
        subprocess.run(["zstd", "-q", "-f", archive, "-o", self.root / "evil.tar.zst"], check=True)
        with self.assertRaisesRegex(ValueError, "unsafe artifact path"):
            build_app.extract(self.root / "evil.tar.zst", self.root / "out")
        self.assertFalse((self.root / "outside").exists())

    @unittest.skipUnless(shutil.which("cc"), "needs a C compiler to make a binary with a missing library")
    def test_refuses_an_app_with_an_unresolved_library(self):
        library, program = self.root / "libgone.so", self.root / "uses-gone"
        subprocess.run(["cc", "-shared", "-fPIC", "-x", "c", "-", "-o", library], input=b"int gone(void){return 0;}", check=True)
        source = b"int gone(void); int main(void){return gone();}"
        subprocess.run(["cc", "-x", "c", "-", "-o", program, f"-L{self.root}", "-lgone"], input=source, check=True)
        shutil.copy2(program, self.engine / "runtime/helper")
        write_manifest(self.engine)
        with self.assertRaisesRegex(ValueError, "helper: libgone.so"):
            build_app.stage(self.engine, self.web, self.root / "app")
        self.assertFalse((self.root / "app").exists())


if __name__ == "__main__":
    unittest.main()
