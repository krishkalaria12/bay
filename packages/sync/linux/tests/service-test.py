#!/usr/bin/env python3
"""Compile real Linux crypto/key store/service with a fake Secret Service API."""
import pathlib
import shlex
import sys
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parents[4]
sync = root / "packages/sync"
with tempfile.TemporaryDirectory() as temporary:
    temporary = pathlib.Path(temporary)
    (temporary / "libsecret").mkdir()
    (temporary / "libsecret/secret.h").write_text(r'''
#pragma once
#include <gio/gio.h>
using SecretItem = GObject;
struct SecretService;
enum SecretSearchFlags {
  SECRET_SEARCH_NONE = 0, SECRET_SEARCH_ALL = 1 << 1,
  SECRET_SEARCH_UNLOCK = 1 << 2, SECRET_SEARCH_LOAD_SECRETS = 1 << 3
};
enum { SECRET_SCHEMA_NONE = 0, SECRET_SCHEMA_ATTRIBUTE_STRING = 0 };
#define SECRET_COLLECTION_DEFAULT "default"
struct SecretSchemaAttribute { const char *name; int type; };
struct SecretSchema {
  const char *name;
  int flags;
  SecretSchemaAttribute attributes[32];
  int reserved;
  void *reserved1, *reserved2, *reserved3, *reserved4, *reserved5, *reserved6, *reserved7;
};
extern "C" {
int secret_password_store_sync(const SecretSchema *, const char *, const char *, const char *, GCancellable *, GError **, ...);
char *secret_password_lookup_sync(const SecretSchema *, GCancellable *, GError **, ...);
int secret_password_clear_sync(const SecretSchema *, GCancellable *, GError **, ...);
void secret_password_free(char *);
GHashTable *secret_attributes_build(const SecretSchema *, ...);
GList *secret_service_search_sync(SecretService *, const SecretSchema *, GHashTable *, SecretSearchFlags, GCancellable *, GError **);
gboolean secret_item_get_locked(SecretItem *);
gboolean secret_item_delete_sync(SecretItem *, GCancellable *, GError **);
}
''')
    sources = [sync / path for path in [
        "windows/SyncCrypto.cpp", "linux/SyncCryptoLinux.cpp", "linux/SyncKeyStore.cpp",
        "windows/SyncVault.cpp", "windows/SyncService.cpp", "windows/RecoveryKit.cpp",
        "windows/vendor/qrcodegen.cpp", "linux/tests/Service.cpp",
    ]]
    # The shared service links the real import reader. macOS exercises Linux
    # service policy and POSIX crypto with fake desktop/keyring edges only.
    sources += [root / "packages/import" / path for path in [
        "windows/Secrets.cpp", "windows/Readers.cpp", "linux/ChromiumSecrets.cpp",
        "linux/SecretService.cpp", "linux/FirefoxNSS.cpp",
    ]]
    flags = shlex.split(subprocess.check_output(
        ["pkg-config", "--cflags", "--libs", "openssl"], text=True))
    flags += shlex.split(subprocess.check_output(
        ["pkg-config", "--cflags", "nss"], text=True))
    flags += shlex.split(subprocess.check_output(
        ["pkg-config", "--cflags", "--libs", "gio-2.0"], text=True))
    if sys.platform == "darwin":
        flags += ["-DBAY_SYNC_LINUX_TEST", "-DBAY_IMPORT_LINUX_TEST"]
    else:
        # Use standalone SQLite rather than Chromium's vendored header.
        flags += ["-DBAY_IMPORT_LINUX_TEST", "-ldl"]
    binary = temporary / "service-test"
    subprocess.run(["c++", "-std=c++17", "-Wall", "-Wextra", "-Werror",
                    "-Wno-missing-field-initializers", "-pthread", "-I", str(temporary),
                    "-I", str(root / "engine/chromium/src/chrome/browser/bay/data/vendor"),
                    *map(str, sources), "-lsqlite3", *flags, "-o", str(binary)], check=True)
    subprocess.run([str(binary), str(temporary)], check=True)
