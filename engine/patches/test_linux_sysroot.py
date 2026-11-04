"""Verify cached Debian payload extraction without a Debian package manager."""
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("linux_sysroot", Path(__file__).parent / "build/linux/sysroot.py")
sysroot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sysroot)


def deb(payload):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:xz") as archive:
        for name, data in payload.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    data = stream.getvalue()
    header = f'{"data.tar.xz":<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(data):<10}`\n'.encode()
    return b"!<arch>\n" + header + data + (b"\n" if len(data) % 2 else b"")


class SysrootTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("ar") and shutil.which("tar"), "requires host ar and tar")
    def test_verified_cache_extracts_with_ar_and_tar_and_repeated_install_works(self):
        payload = {"usr/lib/x86_64-linux-gnu/pkgconfig/libsecret-1.pc": b"prefix=/usr\n",
                   "usr/lib/x86_64-linux-gnu/libsecret-1.so": b"library",
                   "usr/include/libsecret-1/libsecret/secret.h": b"header"}
        data = deb(payload)
        with tempfile.TemporaryDirectory() as temporary, \
             mock.patch.dict(sysroot.PACKAGES, {"fixture.deb": hashlib.sha256(data).hexdigest()}, clear=True), \
             mock.patch.object(sysroot.urllib.request, "urlopen") as urlopen:
            root = Path(temporary)
            cache = root / "libsecret-packages"
            cache.mkdir()
            (cache / "fixture.deb").write_bytes(data)
            target = root / "sysroot"
            target.mkdir()
            def run(command, **kwargs):
                subprocess.run([str(part) for part in command], check=True, **kwargs)
            for _ in range(2):
                sysroot.install(root, target, os.environ, run)
                for name, content in payload.items():
                    self.assertEqual((target / name).read_bytes(), content)
            urlopen.assert_not_called()

    def test_bad_download_never_extracts_or_replaces_cache(self):
        with tempfile.TemporaryDirectory() as temporary, \
             mock.patch.dict(sysroot.PACKAGES, {"fixture.deb": "0" * 64}, clear=True), \
             mock.patch.object(sysroot.urllib.request, "urlopen", return_value=io.BytesIO(b"bad")), \
             mock.patch.object(sysroot.subprocess, "run") as extract:
            root = Path(temporary)
            with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                sysroot.install(root, root / "sysroot", os.environ, mock.Mock())
            extract.assert_not_called()
            self.assertFalse((root / "libsecret-packages/fixture.deb").exists())


if __name__ == "__main__":
    unittest.main()
