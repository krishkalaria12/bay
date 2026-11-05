#!/usr/bin/env python3
"""Mac portable fixture proof only. Creates fresh fake profiles, never keyring data.

Requires Homebrew nss/nspr/openssl@3 and the vendored JSON header. Does not
configure GN, build/link Linux, or run a Linux binary.
"""
import argparse
import base64
import ctypes as c
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import sys


class Item(c.Structure):
    _fields_ = [("type", c.c_int), ("data", c.c_void_p), ("len", c.c_uint)]


def nss_profile(path, password, username, value):
    path.mkdir()
    nss = c.CDLL("/opt/homebrew/opt/nss/lib/libnss3.dylib")
    nss.NSS_InitReadWrite.argtypes = [c.c_char_p]
    nss.NSS_InitReadWrite.restype = c.c_int
    nss.PK11_GetInternalKeySlot.restype = c.c_void_p
    nss.PK11_InitPin.argtypes = [c.c_void_p, c.c_char_p, c.c_char_p]
    nss.PK11_CheckUserPassword.argtypes = [c.c_void_p, c.c_char_p]
    nss.PK11_FreeSlot.argtypes = [c.c_void_p]
    nss.PK11SDR_Encrypt.argtypes = [c.POINTER(Item), c.POINTER(Item), c.POINTER(Item), c.c_void_p]
    nss.SECITEM_ZfreeItem.argtypes = [c.POINTER(Item), c.c_int]
    assert nss.NSS_InitReadWrite(("sql:" + str(path)).encode()) == 0
    slot = nss.PK11_GetInternalKeySlot()
    assert slot
    assert nss.PK11_InitPin(slot, None, password.encode()) == 0
    assert nss.PK11_CheckUserPassword(slot, password.encode()) == 0

    def encrypt(text):
        raw = c.create_string_buffer(text.encode())
        key = Item(0, None, 0)
        plain = Item(0, c.cast(raw, c.c_void_p), len(text.encode()))
        result = Item()
        assert nss.PK11SDR_Encrypt(c.byref(key), c.byref(plain), c.byref(result), None) == 0
        value = base64.b64encode(c.string_at(result.data, result.len)).decode()
        nss.SECITEM_ZfreeItem(c.byref(result), 0)
        return value

    row = {"hostname": "https://fixture.invalid", "formSubmitURL": "https://fixture.invalid/login",
           "httpRealm": None, "encryptedUsername": encrypt(username), "encryptedPassword": encrypt(value),
           "timeCreated": 123, "timeLastUsed": 456, "timesUsed": 2}
    (path / "logins.json").write_text(json.dumps({"logins": [row]}))
    nss.PK11_FreeSlot(slot)
    assert nss.NSS_Shutdown() == 0  # Generator runs outside the application.


def cbc(secret, plain, prefix, nopad=False):
    key = hashlib.pbkdf2_hmac("sha1", secret, b"saltysalt", 1, 16)
    args = ["openssl", "enc", "-aes-128-cbc", "-K", key.hex(), "-iv", (b" " * 16).hex()]
    if nopad:
        args.append("-nopad")
    return prefix + subprocess.run(args, input=plain, check=True, capture_output=True).stdout


def fixtures(root):
    vectors = {"v10": cbc(b"peanuts", b"fixed password", b"v10"),
               "v11": cbc(b"test-safe-storage-secret", b"keyring password", b"v11"),
               "badPadding": cbc(b"peanuts", b"X" * 16, b"v10", True)}
    (root / "vectors.json").write_text(json.dumps({k: base64.b64encode(v).decode() for k, v in vectors.items()}))
    chromium = root / "chromium"
    chromium.mkdir()
    with sqlite3.connect(chromium / "Login Data") as db:
        db.execute("CREATE TABLE logins (origin_url TEXT, signon_realm TEXT, username_value TEXT, password_value BLOB)")
        for i, value in enumerate([vectors["v10"], vectors["v11"], vectors["badPadding"], b"v20bad", b"v12bad"]):
            db.execute("INSERT INTO logins VALUES (?,?,?,?)", (f"https://{i}.invalid", f"https://{i}.invalid", "fixture", value))
    with sqlite3.connect(chromium / "Web Data") as db:
        db.execute("CREATE TABLE credit_cards (card_number_encrypted BLOB)")
        db.executemany("INSERT INTO credit_cards VALUES (?)", [(cbc(b"test-safe-storage-secret", b"4111111111111111", b"v11"),), (vectors["badPadding"],)])
    nss_profile(root / "firefox", "fixture-primary", "fixture-user", "fixture-password")
    nss_profile(root / "firefox-empty", "", "other-user", "other-password")
    nss_profile(root / "sentinel", "", "sentinel-user", "sentinel-password")


def main():
    if sys.platform != "darwin":
        raise SystemExit("this stage-1 runner is Mac-only")
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", type=Path, help="keep generated fake fixtures and binary in this directory")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[4]
    test = Path(__file__).resolve().parent
    sources = [test / "SecretsTest.cpp", test.parent / "ChromiumSecrets.cpp", test.parent / "SecretService.cpp",
               test.parent / "FirefoxNSS.cpp", repo / "packages/import/windows/Secrets.cpp", repo / "packages/import/windows/Readers.cpp"]
    includes = [repo / "engine/chromium/src/chrome/browser/bay/data/vendor",
                Path("/opt/homebrew/opt/openssl@3/include"), Path("/opt/homebrew/opt/nss/include/nss"),
                Path("/opt/homebrew/opt/nspr/include/nspr")]
    with tempfile.TemporaryDirectory(prefix="bay-linux-secret-test-") as temporary:
        root = args.keep.resolve() if args.keep else Path(temporary)
        root.mkdir(parents=True, exist_ok=True)
        fixtures(root)
        command = ["clang++", "-std=c++17", "-DBAY_IMPORT_LINUX_TEST", "-Wall", "-Wextra"]
        for include in includes:
            command += ["-I", str(include)]
        command += [str(s) for s in sources]
        command += ["/opt/homebrew/opt/openssl@3/lib/libcrypto.dylib", "-lsqlite3", "-o", str(root / "secrets-test")]
        subprocess.run(command, check=True)
        subprocess.run([str(root / "secrets-test"), str(root)], check=True)


if __name__ == "__main__":
    main()
