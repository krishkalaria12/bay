"""Bay's libsecret build dependency, extracted only into Chromium's pinned sysroot.

Use ar and tar from the host's binutils/tar packages, including on RPM and Arch
hosts. No Debian package manager, root access or host library installation.
"""
import hashlib
import pathlib
import subprocess
import tempfile
import urllib.request

PACKAGES = {
    "libsecret-1-dev_0.20.4-2_amd64.deb": "8b3c260998f236751456f73250280f8ddfc1dc5ae719e21ab147345a3b393e9c",
    "libsecret-1-0_0.20.4-2_amd64.deb": "b34b1471fdf786cc28912b7130d4db00b54807ffe9133fed03673b54651a62d2",
}
URL = "https://deb.debian.org/debian/pool/main/libs/libsecret/"


def checksum(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def install(root, sysroot, env, run):
    cache = root / "libsecret-packages"
    cache.mkdir(parents=True, exist_ok=True)
    # Verify every package before changing the sysroot. Interrupted downloads
    # never replace a verified cache entry.
    for name, digest in PACKAGES.items():
        package = cache / name
        if package.is_file() and checksum(package) == digest:
            continue
        with tempfile.TemporaryDirectory(dir=cache, prefix="download-") as temporary:
            pending = pathlib.Path(temporary) / name
            with urllib.request.urlopen(URL + name, timeout=90) as response, pending.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if checksum(pending) != digest:
                raise RuntimeError(f"SHA-256 mismatch for {name}; sysroot left unchanged")
            pending.replace(package)
    for name in PACKAGES:
        with tempfile.TemporaryDirectory(prefix="bay-libsecret-") as temporary:
            archive = pathlib.Path(temporary) / "data.tar.xz"
            with archive.open("wb") as output:
                subprocess.run(["ar", "p", str(cache / name), "data.tar.xz"],
                               stdout=output, env=env, check=True)
            run(["tar", "-xJf", archive, "-C", sysroot], env=env)
    for relative in ("usr/lib/x86_64-linux-gnu/pkgconfig/libsecret-1.pc",
                     "usr/include/libsecret-1/libsecret/secret.h",
                     "usr/lib/x86_64-linux-gnu/libsecret-1.so"):
        if not (sysroot / relative).is_file():
            raise RuntimeError(f"libsecret sysroot overlay is incomplete: {relative}")
