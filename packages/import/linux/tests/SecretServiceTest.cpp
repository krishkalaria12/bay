// Run the production libsecret lookup against fake dynamically loaded symbols.
// This process never connects to a bus or loads a system secret library.
#include "../SystemLibrary.h"
#include <cstdarg>
#include <cstring>
#include <gio/gio.h>
#include <stdexcept>
#include <string>

namespace bay::importer::linux_secrets {
void *FakeLibrary(std::initializer_list<const char *>);
}
void *FakeSymbol(void *, const char *);
#define BAY_IMPORT_SECRET_SERVICE_TEST
#define openSystemLibrary FakeLibrary
#define dlsym FakeSymbol
#include "../SecretService.cpp"
#undef dlsym
#undef openSystemLibrary

using namespace bay::importer;
namespace {
bool missing = false, denied = false;
int schemas = 0, lookups = 0, freed = 0;
std::string expectedApplication;
void require(bool value, const char *message) {
  if (!value)
    throw std::runtime_error(message);
}
SecretSchema *NewSchema(const char *name, SchemaFlags flags, ...) {
  require(std::strcmp(name, "chrome_libsecret_os_crypt_password_v2") == 0 &&
              static_cast<int>(flags) == (1 << 1),
          "legacy items must match without an xdg:schema name");
  ++schemas;
  return reinterpret_cast<SecretSchema *>(&schemas);
}
void FreeSchema(SecretSchema *) { --schemas; }
char *Lookup(const SecretSchema *, GCancellable *, GError **error, ...) {
  va_list args;
  va_start(args, error);
  const char *attribute = va_arg(args, const char *);
  const char *value = va_arg(args, const char *);
  const auto *end = va_arg(args, const char *);
  va_end(args);
  require(std::string(attribute) == "application" &&
              value == expectedApplication && !end,
          "wrong source application");
  ++lookups;
  if (denied) {
    g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_CANCELLED, "fake denial");
    return nullptr;
  }
  return missing ? nullptr : g_strdup("fake-existing-secret");
}
void FreePassword(char *password) {
  for (unsigned i = 0; i < std::strlen("fake-existing-secret"); ++i)
    require(password[i] == 0, "password was not wiped before release");
  ++freed;
  g_free(password);
}
} // namespace

namespace bay::importer::linux_secrets {
void *FakeLibrary(std::initializer_list<const char *>) { return &schemas; }
} // namespace bay::importer::linux_secrets
void *FakeSymbol(void *, const char *name) {
  if (std::strcmp(name, "secret_schema_new") == 0)
    return reinterpret_cast<void *>(&NewSchema);
  if (std::strcmp(name, "secret_schema_unref") == 0)
    return reinterpret_cast<void *>(&FreeSchema);
  if (std::strcmp(name, "secret_password_lookup_sync") == 0)
    return reinterpret_cast<void *>(&Lookup);
  if (std::strcmp(name, "secret_password_free") == 0)
    return reinterpret_cast<void *>(&FreePassword);
  throw std::runtime_error(std::string("unexpected secret operation: ") + name);
}
int main() {
  try {
    for (auto browser :
         {LinuxChromiumBrowser::Chrome, LinuxChromiumBrowser::Chromium,
          LinuxChromiumBrowser::Brave, LinuxChromiumBrowser::Edge,
          LinuxChromiumBrowser::Vivaldi, LinuxChromiumBrowser::Opera,
          LinuxChromiumBrowser::Helium}) {
      expectedApplication = browser == LinuxChromiumBrowser::Brave ? "brave"
                            : browser == LinuxChromiumBrowser::Chrome ||
                                    browser == LinuxChromiumBrowser::Vivaldi
                                ? "chrome"
                                : "chromium";
      auto secret =
          lookupLinuxSafeStorage(browser, LinuxSecretBackend::SecretService);
      require(std::string(secret.begin(), secret.end()) ==
                      "fake-existing-secret" &&
                  !schemas,
              "lookup or schema release failed");
    }
    for (auto fail : {&missing, &denied}) {
      *fail = true;
      bool locked = false;
      try {
        lookupLinuxSafeStorage(LinuxChromiumBrowser::Chromium,
                               LinuxSecretBackend::SecretService);
      } catch (const Failure &error) {
        locked = error.code == "locked";
      }
      require(locked && !schemas, "missing or denied item did not fail closed");
      *fail = false;
    }
    require(lookups == 9 && freed == 7, "unexpected secret operations");
    g_print(
        "Read-only libsecret schema, identity and denial fixtures passed\n");
    return 0;
  } catch (const std::exception &error) {
    g_printerr("%s\n", error.what());
    return 1;
  }
}
