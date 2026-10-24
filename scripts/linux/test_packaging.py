"""Linux packaging against fixture engine archives: no engine build or Linux desktop needed."""
import importlib.util
import json
import os
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


RELEASE = HERE / "release.sh"


class ReleaseTests(unittest.TestCase):
    """release.sh on a staged fixture app. Formats whose tool isn't installed are skipped, not faked."""

    @classmethod
    def setUpClass(cls):
        cls.root = pathlib.Path(tempfile.mkdtemp(prefix="bay-release-test-"))
        make_runtime(cls.root / "engine")
        write_manifest(cls.root / "engine")
        cls.app = cls.root / "app"
        build_app.stage(cls.root / "engine", make_web(cls.root / "web"), cls.app)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root)

    def release(self, formats, output, **env):
        return subprocess.run(
            [RELEASE, "--app", self.app, "--version", "1.3.0", "--output", output, "--formats", formats],
            check=True, capture_output=True, text=True, env={**os.environ, **env},
        )

    def listing(self, tarball):
        return {member.name: member for member in tarfile.open(tarball)}

    def test_tarball_holds_the_installed_tree(self):
        output = self.root / "tar"
        self.release("tar", output)
        members = self.listing(output / "bay-1.3.0-linux-x64.tar.xz")
        for name in ("opt/bay/bay", "opt/bay/bay-wrapper", "opt/bay/bay-ui/index.html", "usr/share/applications/bay.desktop",
                     "usr/share/icons/hicolor/16x16/apps/bay.png", "usr/share/icons/hicolor/512x512/apps/bay.png",
                     "usr/share/icons/hicolor/scalable/apps/bay.svg", "etc/apparmor.d/bay", "etc/bay/native-messaging-hosts"):
            self.assertIn(f"bay-1.3.0/{name}", members)
        self.assertEqual(members["bay-1.3.0/usr/bin/bay"].linkname, "/opt/bay/bay-wrapper")
        self.assertFalse(members["bay-1.3.0/opt/bay/chrome_sandbox"].mode & 0o4000, "a tarball never ships a setuid sandbox")
        self.assertTrue(all(member.uid == 0 and member.gid == 0 for member in members.values()))
        metainfo = tarfile.open(output / "bay-1.3.0-linux-x64.tar.xz").extractfile("bay-1.3.0/usr/share/metainfo/in.krishkalaria.bay.metainfo.xml").read()
        self.assertIn(b'<release version="1.3.0" date="2026-10-15" />', metainfo, "dated from release-notes/1.3.0.md")
        self.assertIn("bay-1.3.0-linux-x64.tar.xz", (output / "SHA256SUMS").read_text())

    def test_rejects_a_version_that_is_not_x_y_z(self):
        command = [RELEASE, "--app", self.app, "--version", "1.3", "--output", self.root / "bad", "--formats", "tar"]
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 2)
        self.assertFalse((self.root / "bad").exists())

    @unittest.skipUnless(shutil.which("makepkg"), "needs makepkg")
    def test_aur_package_installs_a_setuid_sandbox(self):
        output = self.root / "aur"
        self.release("tar,aur", output)
        aur = output / "aur"
        self.assertIn("pkgver = 1.3.0", (aur / ".SRCINFO").read_text())
        shutil.copy2(output / "bay-1.3.0-linux-x64.tar.xz", aur)
        subprocess.run(["makepkg", "-f", "--nodeps", "--noconfirm"], cwd=aur, check=True, capture_output=True)
        members = self.listing(next(aur.glob("bay-bin-1.3.0-1-x86_64.pkg.tar.*")))
        sandbox = members["opt/bay/chrome_sandbox"]
        self.assertEqual((sandbox.mode & 0o7777, sandbox.uid), (0o4755, 0))

    @unittest.skipUnless(shutil.which("dpkg-deb"), "needs dpkg-deb")
    def test_deb_installs_a_setuid_sandbox_and_its_scripts(self):
        output = self.root / "deb"
        self.release("deb", output)
        deb = output / "bay_1.3.0_amd64.deb"
        contents = subprocess.run(["dpkg-deb", "--contents", deb], check=True, capture_output=True, text=True).stdout
        self.assertRegex(contents, r"-rwsr-xr-x root/root .* \./opt/bay/chrome_sandbox")
        self.assertEqual(subprocess.run(["dpkg-deb", "--field", deb, "Version"], capture_output=True, text=True).stdout.strip(), "1.3.0")

    @unittest.skipUnless(shutil.which("rpmbuild") and shutil.which("rpm"), "needs rpmbuild")
    def test_rpm_installs_a_setuid_sandbox(self):
        output = self.root / "rpm"
        self.release("rpm", output)
        listing = subprocess.run(["rpm", "-qlvp", output / "bay-1.3.0-1.x86_64.rpm"], check=True, capture_output=True, text=True).stdout
        self.assertRegex(listing, r"-rwsr-xr-x .* root +root .* /opt/bay/chrome_sandbox")

    @unittest.skipUnless(shutil.which("appimagetool") and shutil.which("zsyncmake"), "needs appimagetool and zsyncmake")
    def test_appimage_and_its_zsync_file(self):
        output = self.root / "appimage"
        self.release("appimage", output)
        image = output / "Bay-1.3.0-x86_64.AppImage"
        self.assertTrue(image.is_file() and (output / "Bay-1.3.0-x86_64.AppImage.zsync").is_file())

    @unittest.skipUnless(shutil.which("gpg"), "needs gpg")
    def test_signs_every_artifact_and_the_checksums(self):
        home = self.root / "gnupg"
        home.mkdir(mode=0o700)
        env = {"GNUPGHOME": str(home)}
        subprocess.run(["gpg", "--batch", "--passphrase", "", "--quick-gen-key", "Bay Test <test@invalid>", "ed25519", "sign", "never"],
                       check=True, capture_output=True, env={**os.environ, **env})
        output = self.root / "signed"
        self.release("tar", output, BAY_GPG_KEY="test@invalid", **env)
        for name in ("bay-1.3.0-linux-x64.tar.xz", "SHA256SUMS"):
            subprocess.run(["gpg", "--verify", output / f"{name}.asc", output / name], check=True, capture_output=True,
                           env={**os.environ, **env})


if __name__ == "__main__":
    unittest.main()
