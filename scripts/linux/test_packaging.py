"""Linux packaging against fixture engine archives: no engine build or Linux desktop needed."""
import base64
import gzip
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys
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
    """A complete runtime, using real ELF executables on Linux so ldd can read them."""
    runtime = directory / "runtime"
    (runtime / "locales").mkdir(parents=True)
    (runtime / "bay-ui").mkdir()
    for name in ("bay", "chrome_sandbox", "chrome_crashpad_handler"):
        # Copy bytes and mode, not macOS system-file flags that fixtures cannot inherit.
        shutil.copy(ELF, runtime / name)
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


def assert_sandbox_metadata(test, app):
    manifest = build_app.web_artifacts.verify_manifest(app)
    provenance = json.loads((app / "engine-manifest.json").read_text())
    test.assertFalse((app / "chrome_sandbox").exists())
    checksum = engine.sha256(app / "chrome-sandbox")
    test.assertEqual(manifest["files"]["chrome-sandbox"], checksum)
    test.assertNotIn("chrome_sandbox", manifest["files"])
    test.assertEqual(provenance["files"]["runtime/chrome_sandbox"], checksum)
    return manifest


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
        self.assertEqual(assert_sandbox_metadata(self, app)["platform"], "linux")
        self.assertEqual((app / "engine-manifest.json").read_bytes(), (extracted / "manifest.json").read_bytes())
        build_app.fetch.verify(extracted, engine.artifact_id("linux"), platform="linux")

    def test_staged_verification_detects_changed_installed_sandbox(self):
        app = self.root / "app"
        build_app.stage(self.engine, self.web, app)
        (app / "chrome-sandbox").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "checksum mismatch: chrome-sandbox"):
            build_app.web_artifacts.verify_manifest(app)

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

    @unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("cc"), "needs Linux ELF tools and a C compiler")
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


class AppImageInvocationTests(unittest.TestCase):
    """Check the real release script's paths and payload with an argument-checking tool, not a real AppImage build."""

    def test_relative_output_resolves_once_and_preserves_sandbox_metadata(self):
        with tempfile.TemporaryDirectory(prefix="bay-appimage-invocation-") as directory:
            root = pathlib.Path(directory)
            runtime = make_runtime(root / "engine")
            # A portable package must clear inherited setuid bits, even on an input with them set.
            (runtime / "chrome_sandbox").chmod(0o4755)
            write_manifest(root / "engine")
            app = root / "app"
            build_app.stage(root / "engine", make_web(root / "web"), app)
            tools = root / "tools"
            tools.mkdir()
            appimagetool = tools / "appimagetool"
            appimagetool.write_text(f"#!{sys.executable}\n" + '''import json, pathlib, shutil, sys
appdir, image = map(pathlib.Path, sys.argv[-2:])
assert image.parent.resolve() == pathlib.Path.cwd(), (image, pathlib.Path.cwd())
shutil.copytree(appdir / "opt/bay", image.parent / "payload")
image.write_text(json.dumps({"cwd": str(pathlib.Path.cwd()), "image": str(image)}))
pathlib.Path(str(image) + ".zsync").write_text("fixture zsync")
''')
            appimagetool.chmod(0o755)
            (tools / "zsyncmake").write_text("#!/bin/sh\nexit 0\n")
            (tools / "zsyncmake").chmod(0o755)
            if sys.platform == "darwin":
                # BSD install lacks -D. Adapt that option only, leaving the real release script intact.
                install = tools / "install"
                install.write_text('''#!/bin/sh
if [ "$1" = -Dm ]; then
  mkdir -p "$(dirname "$4")"
  shift
  set -- -m "$@"
fi
exec ''' + shlex.quote(shutil.which("install")) + ''' "$@"
''')
                install.chmod(0o755)
            result = subprocess.run([RELEASE, "--app", app, "--version", "1.3.0", "--output", "dist/linux-release",
                                     "--formats", "appimage"], cwd=root, capture_output=True, text=True,
                                    env={**os.environ, "PATH": str(tools) + os.pathsep + os.environ["PATH"], "BAY_GPG_KEY": ""})
            self.assertEqual(result.returncode, 0, result.stderr)
            output = root / "dist/linux-release"
            image = output / "Bay-1.3.0-x86_64.AppImage"
            invocation = json.loads(image.read_text())
            self.assertEqual(pathlib.Path(invocation["cwd"]), output.resolve())
            self.assertEqual(pathlib.Path(invocation["image"]).resolve(), image.resolve())
            self.assertTrue(pathlib.Path(str(image) + ".zsync").is_file())
            payload = output / "payload"
            assert_sandbox_metadata(self, payload)
            self.assertEqual((payload / "chrome-sandbox").stat().st_mode & 0o7777, 0o755)
            for line in (output / "SHA256SUMS").read_text().splitlines():
                checksum, name = line.split()
                self.assertEqual(engine.sha256(output / name), checksum)


@unittest.skipUnless(sys.platform.startswith("linux"), "package formats require Linux/GNU tools")
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
        self.assertNotIn("bay-1.3.0/opt/bay/chrome_sandbox", members)
        self.assertEqual(members["bay-1.3.0/opt/bay/chrome-sandbox"].mode, 0o755, "a tarball never ships a setuid sandbox")
        self.assertTrue(all(member.uid == 0 and member.gid == 0 for member in members.values()))
        metainfo = tarfile.open(output / "bay-1.3.0-linux-x64.tar.xz").extractfile("bay-1.3.0/usr/share/metainfo/in.krishkalaria.bay.metainfo.xml").read()
        self.assertIn(b'<release version="1.3.0" date="2026-10-15" />', metainfo, "dated from release-notes/1.3.0.md")
        self.assertIn("bay-1.3.0-linux-x64.tar.xz", (output / "SHA256SUMS").read_text())
        with tarfile.open(output / "bay-1.3.0-linux-x64.tar.xz") as tar:
            tar.extractall(output, members=[member for member in tar if member.name.startswith("bay-1.3.0/opt/bay/")], filter="data")
        assert_sandbox_metadata(self, output / "bay-1.3.0/opt/bay")

    @unittest.skipUnless(shutil.which("desktop-file-validate") and shutil.which("appstreamcli"), "needs desktop-file-utils and appstream")
    def test_desktop_entry_and_metainfo_validate(self):
        output = self.root / "validate"
        self.release("tar", output)
        share = output / "bay-1.3.0/usr/share"
        with tarfile.open(output / "bay-1.3.0-linux-x64.tar.xz") as tar:
            for name in ("applications/bay.desktop", "metainfo/in.krishkalaria.bay.metainfo.xml"):
                tar.extract(f"bay-1.3.0/usr/share/{name}", output, filter="data")
        subprocess.run(["desktop-file-validate", share / "applications/bay.desktop"], check=True)
        subprocess.run(["appstreamcli", "validate", "--no-net", "--pedantic", share / "metainfo/in.krishkalaria.bay.metainfo.xml"],
                       check=True, capture_output=True)

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
        self.assertNotIn("opt/bay/chrome_sandbox", members)
        sandbox = members["opt/bay/chrome-sandbox"]
        self.assertEqual((sandbox.mode & 0o7777, sandbox.uid, sandbox.gid), (0o4755, 0, 0))

    def test_srcinfo_lists_the_pkgbuild_without_makepkg(self):
        output = self.root / "srcinfo"
        self.release("tar,aur", output)
        checksum = engine.sha256(output / "bay-1.3.0-linux-x64.tar.xz")
        lines = (output / "aur/.SRCINFO").read_text().splitlines()
        self.assertEqual(lines[:5], ["pkgbase = bay-bin", "\tpkgdesc = A fast browser with your tabs in a sidebar, on Chromium",
                                     "\tpkgver = 1.3.0", "\tpkgrel = 1", "\turl = https://bay.krishkalaria.in"])
        for line in ("\tarch = x86_64", "\tdepends = gtk3", "\tdepends = xdg-utils",
                     "\toptdepends = kwallet: keep saved passwords in KWallet", "\toptions = !strip", "\toptions = !debug",
                     "\tsource = https://github.com/krishkalaria12/bay/releases/download/v1.3.0/bay-1.3.0-linux-x64.tar.xz",
                     f"\tsha256sums = {checksum}"):
            self.assertIn(line, lines)
        self.assertEqual(lines[-2:], ["", "pkgname = bay-bin"])

    def test_flathub_and_nixpkgs_files_name_this_release(self):
        output = self.root / "stores"
        self.release("tar,flatpak,nixpkgs", output)
        tarball = output / "bay-1.3.0-linux-x64.tar.xz"
        manifest = (output / "flatpak/in.krishkalaria.bay.yaml").read_text()
        self.assertIn("url: https://github.com/krishkalaria12/bay/releases/download/v1.3.0/bay-1.3.0-linux-x64.tar.xz\n", manifest)
        self.assertIn(f'sha256: "{engine.sha256(tarball)}"', manifest)
        self.assertNotIn("@", manifest.replace("@v", ""))
        for name in ("bay.sh", "cobalt.ini", "flathub.json"):
            self.assertTrue((output / "flatpak" / name).is_file(), name)
        package = (output / "nixpkgs/package.nix").read_text()
        self.assertIn('version = "1.3.0";', package)
        digest = base64.b64encode(hashlib.sha256(tarball.read_bytes()).digest()).decode()
        self.assertIn(f'hash = "sha256-{digest}";', package)
        self.assertNotIn("SHA256SUMS", [path.name for path in (output / "flatpak").iterdir()])

    @unittest.skipUnless(shutil.which("dpkg-deb"), "needs dpkg-deb")
    def test_deb_installs_a_setuid_sandbox_and_its_scripts(self):
        output = self.root / "deb"
        self.release("deb", output)
        deb = output / "bay_1.3.0_amd64.deb"
        contents = subprocess.run(["dpkg-deb", "--contents", deb], check=True, capture_output=True, text=True).stdout
        self.assertRegex(contents, r"-rwsr-xr-x root/root .* \./opt/bay/chrome-sandbox")
        self.assertNotIn("./opt/bay/chrome_sandbox", contents)
        unpacked = output / "unpacked"
        subprocess.run(["dpkg-deb", "--extract", deb, unpacked], check=True)
        assert_sandbox_metadata(self, unpacked / "opt/bay")
        self.assertEqual(subprocess.run(["dpkg-deb", "--field", deb, "Version"], capture_output=True, text=True).stdout.strip(), "1.3.0")

    @unittest.skipUnless(shutil.which("rpmbuild") and shutil.which("rpm"), "needs rpmbuild")
    def test_rpm_installs_a_setuid_sandbox(self):
        output = self.root / "rpm"
        self.release("rpm", output)
        listing = subprocess.run(["rpm", "-qlvp", output / "bay-1.3.0-1.x86_64.rpm"], check=True, capture_output=True, text=True).stdout
        self.assertRegex(listing, r"-rwsr-xr-x .* root +root .* /opt/bay/chrome-sandbox")
        self.assertNotIn("/opt/bay/chrome_sandbox", listing)

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


class NixLibraryTests(unittest.TestCase):
    def test_the_nixpkgs_package_links_the_build_shells_libraries(self):
        """package.nix (nixpkgs' argument names) and libraries.nix (the build shell's) must list the same libraries."""
        nix = HERE.parents[1] / "packaging/linux/nix"
        shell = (nix / "libraries.nix").read_text()
        names = set(re.findall(r"^  ([a-z][\w.-]*)$", shell, re.M))
        names |= set(re.findall(r'^  \(x11 "(\w+)"', shell, re.M))
        names |= {"libgbm"} if "pkgs.libgbm or mesa" in shell else set()
        package = (nix / "package.nix").read_text()
        block = package[package.index("  libraries = [\n"):package.index("  ]\n", package.index("  libraries = [\n"))]
        self.assertEqual(set(re.findall(r"^    ([a-z][\w.-]*)$", block, re.M)), names)
        self.assertIn("libsForQt5.qtbase", shell)
        self.assertIn("libsForQt5.qtbase", package)


PUBLISH_TOOLS = ("gpg", "rpmsign", "rpmkeys", "rpmbuild", "dpkg-deb", "apt-ftparchive", "createrepo_c")


@unittest.skipUnless(sys.platform.startswith("linux") and all(map(shutil.which, PUBLISH_TOOLS)),
                     "needs " + ", ".join(PUBLISH_TOOLS))
class PublishTests(unittest.TestCase):
    """publish.sh --dry-run on real fixture packages: everything it would upload, signed by a throwaway key."""

    @classmethod
    def setUpClass(cls):
        cls.root = pathlib.Path(tempfile.mkdtemp(prefix="bay-publish-test-"))
        make_runtime(cls.root / "engine")
        write_manifest(cls.root / "engine")
        build_app.stage(cls.root / "engine", make_web(cls.root / "web"), cls.root / "app")
        home = cls.root / "gnupg"
        home.mkdir(mode=0o700)
        cls.env = {**os.environ, "GNUPGHOME": str(home), "BAY_GPG_KEY": "test@invalid"}
        subprocess.run(["gpg", "--batch", "--passphrase", "", "--quick-gen-key", "Bay Test <test@invalid>", "rsa3072", "sign", "never"],
                       check=True, capture_output=True, env=cls.env)
        cls.packages = cls.root / "packages"
        subprocess.run([RELEASE, "--app", cls.root / "app", "--version", "1.3.0", "--output", cls.packages, "--formats", "tar,deb,rpm,aur"],
                       check=True, capture_output=True, env={**os.environ, "BAY_GPG_KEY": ""})
        # appimagetool's output, stood in for: an image and the zsync file it makes for the image beside it.
        image = cls.packages / "Bay-1.3.0-x86_64.AppImage"
        image.write_bytes(b"fixture image")
        pathlib.Path(f"{image}.zsync").write_bytes(b"zsync: 0.6.2\nFilename: Bay-1.3.0-x86_64.AppImage\nURL: Bay-1.3.0-x86_64.AppImage\n\n\x00\x01")
        with open(cls.packages / "SHA256SUMS", "a") as sums:
            for path in (image, pathlib.Path(f"{image}.zsync")):
                sums.write(f"{engine.sha256(path)}  {path.name}\n")
        cls.result = subprocess.run([HERE / "publish.sh", "--packages", cls.packages, "--version", "1.3.0", "--dry-run"],
                                    capture_output=True, text=True, env=cls.env)
        cls.out = cls.packages / "publish"

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root)

    def verify(self, signature, data):
        subprocess.run(["gpg", "--verify", signature, data], check=True, capture_output=True, env=self.env)

    def test_dry_run_succeeds_without_gh_or_the_aur(self):
        self.assertEqual(self.result.returncode, 0, self.result.stderr)
        self.assertIn("nothing uploaded", self.result.stdout)

    def test_release_assets_are_signed_and_checksummed_after_the_rpm_is_signed(self):
        release = self.out / "release"
        sums = release / "bay-1.3.0-linux-SHA256SUMS"
        self.verify(f"{sums}.asc", sums)
        names = []
        for line in sums.read_text().splitlines():
            checksum, name = line.split()
            names.append(name)
            self.assertEqual(engine.sha256(release / name), checksum)
            self.verify(release / f"{name}.asc", release / name)
        self.assertEqual(set(names), {"bay-1.3.0-linux-x64.tar.xz", "bay_1.3.0_amd64.deb", "bay-1.3.0-1.x86_64.rpm",
                                      "Bay-1.3.0-x86_64.AppImage", "Bay-1.3.0-x86_64.AppImage.zsync"})
        database = self.root / "rpmdb"
        database.mkdir(exist_ok=True)
        subprocess.run(["rpmkeys", "--dbpath", database, "--import", self.out / "repo/bay.asc"], check=True)
        checked = subprocess.run(["rpmkeys", "--dbpath", database, "--checksig", release / "bay-1.3.0-1.x86_64.rpm"],
                                 check=True, capture_output=True, text=True).stdout
        self.assertIn("signatures OK", checked)

    def test_apt_repository_is_signed_and_names_the_release_asset(self):
        repo = self.out / "repo"
        subprocess.run(["gpg", "--verify", repo / "InRelease"], check=True, capture_output=True, env=self.env)
        self.verify(repo / "Release.gpg", repo / "Release")
        packages = (repo / "Packages").read_text()
        self.assertIn("Filename: pool/v1.3.0/bay_1.3.0_amd64.deb\n", packages)
        self.assertIn("SHA256: " + engine.sha256(self.out / "release/bay_1.3.0_amd64.deb"), packages)
        release = (repo / "Release").read_text()
        self.assertIn(engine.sha256(repo / "Packages"), release)
        self.assertIn(engine.sha256(repo / "Packages.gz"), release)
        self.assertIn("Architectures: amd64", release)

    def test_rpm_repository_is_signed_and_names_the_signed_package(self):
        repo = self.out / "repo"
        self.verify(repo / "repomd.xml.asc", repo / "repomd.xml")
        primary = next(repo.glob("*-primary.xml.gz"))
        self.assertIn(primary.name, (repo / "repomd.xml").read_text())
        listing = gzip.decompress(primary.read_bytes()).decode()
        self.assertIn('<location href="pool/v1.3.0/bay-1.3.0-1.x86_64.rpm"/>', listing)
        self.assertIn(engine.sha256(self.out / "release/bay-1.3.0-1.x86_64.rpm"), listing)
        config = (repo / "bay.repo").read_text()
        self.assertIn("baseurl=https://bay.krishkalaria.in/linux/rpm\n", config)
        self.assertIn("repo_gpgcheck=1\n", config)

    def test_appimage_update_file_points_at_the_release_image(self):
        data = (self.out / "repo/Bay-x86_64.AppImage.zsync").read_bytes()
        self.assertIn(b"\nURL: https://github.com/krishkalaria12/bay/releases/download/v1.3.0/Bay-1.3.0-x86_64.AppImage\n\n", data)
        self.assertTrue(data.endswith(b"\n\n\x00\x01"), "the block checksums after the header are untouched")


if __name__ == "__main__":
    unittest.main()
