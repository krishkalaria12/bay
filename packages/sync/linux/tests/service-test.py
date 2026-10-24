#!/usr/bin/env python3
"""Compile real Linux crypto/key store/service with a fake Secret Service API."""
import pathlib
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parents[4]
sync = root / "packages/sync"
with tempfile.TemporaryDirectory() as temporary:
    temporary = pathlib.Path(temporary)
    (temporary / "libsecret").mkdir()
    (temporary / "libsecret/secret.h").write_text(r'''
#pragma once
struct GError {};
using gchar = char;
enum { SECRET_SCHEMA_NONE, SECRET_SCHEMA_ATTRIBUTE_STRING };
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
int secret_password_store_sync(const SecretSchema *, const char *, const char *, const char *, void *, GError **, ...);
char *secret_password_lookup_sync(const SecretSchema *, void *, GError **, ...);
int secret_password_clear_sync(const SecretSchema *, void *, GError **, ...);
void secret_password_free(char *);
void g_error_free(GError *);
}
''')
    sources = [sync / path for path in [
        "windows/SyncCrypto.cpp", "linux/SyncCryptoLinux.cpp", "linux/SyncKeyStore.cpp",
        "windows/SyncVault.cpp", "windows/SyncService.cpp", "windows/RecoveryKit.cpp",
        "windows/vendor/qrcodegen.cpp", "linux/tests/Service.cpp",
    ]]
    binary = temporary / "service-test"
    subprocess.run(["c++", "-std=c++17", "-Wall", "-Wextra", "-Werror",
                    "-Wno-missing-field-initializers", "-pthread", "-I", str(temporary),
                    "-I", str(root / "engine/chromium/src/chrome/browser/bay/data/vendor"),
                    *map(str, sources), "-lcrypto", "-o", str(binary)], check=True)
    subprocess.run([str(binary), str(temporary)], check=True)
