#include "ChromiumSecrets.h"
#if defined(__linux__) || defined(BAY_IMPORT_SECRET_SERVICE_TEST)
#include "SystemLibrary.h"
#include <cstdlib>
#include <cstring>
#include <gio/gio.h>
#include <memory>
namespace bay::importer {
namespace {
struct Identity {
  const char *application;
  const char *folder;
  const char *label;
};
Identity identity(LinuxChromiumBrowser browser) {
  // Linux identities differ from macOS product names. Interop references:
  // Chromium FreedesktopSecretKeyProvider::kAppName/kKWalletFolder/kKeyName;
  // brave-core/patches/components-os_crypt-async-browser-freedesktop_secret_key_provider.h.patch;
  // yt-dlp/yt_dlp/cookies.py::_get_chromium_based_browser_settings.
  switch (browser) {
  case LinuxChromiumBrowser::Chrome:
  case LinuxChromiumBrowser::Vivaldi:
    return {"chrome", "Chrome Keys", "Chrome Safe Storage"};
  case LinuxChromiumBrowser::Chromium:
  case LinuxChromiumBrowser::Edge:
  case LinuxChromiumBrowser::Opera:
    return {"chromium", "Chromium Keys", "Chromium Safe Storage"};
  case LinuxChromiumBrowser::Brave:
    return {"brave", "Brave Keys", "Brave Safe Storage"};
  case LinuxChromiumBrowser::Helium:
    return {"chromium", "Chromium Keys", "Chromium Safe Storage"};
  }
  throw Failure("unsupported", "Unknown source browser Safe Storage identity");
}
void wipe(char *p) {
  if (!p)
    return;
  auto size = std::strlen(p);
  volatile char *bytes = p;
  for (std::size_t i = 0; i < size; ++i)
    bytes[i] = 0;
}
class Library {
public:
  void *handle;
  explicit Library(void *handle) : handle(handle) {
    if (!handle)
      throw Failure("unsupported",
                    "The system secret storage library is unavailable");
  }
  // libsecret registers static GTypes and asynchronous service callbacks.
  // Its code must remain resident for the lifetime of the process.
  ~Library() = default;
  template <class T> T function(const char *name) {
    auto p = dlsym(handle, name);
    if (!p)
      throw Failure("unsupported",
                    "The system secret storage library is incompatible");
    return reinterpret_cast<T>(p);
  }
};
// Opaque libsecret API types, from secret-schema.h. Keep the schema layout out
// of the importer and resolve functions without a libsecret link dependency.
struct SecretSchema;
enum SchemaFlags { SchemaDontMatchName = 1 << 1 };
enum AttributeType { AttributeString = 0 };
Bytes secretService(const Identity &id) {
  static Library library(linux_secrets::openSystemLibrary(
      {"/usr/lib/x86_64-linux-gnu/libsecret-1.so.0",
       "/usr/lib64/libsecret-1.so.0", "/usr/lib/libsecret-1.so.0",
       "/usr/lib/aarch64-linux-gnu/libsecret-1.so.0"}));
  auto schemaNew =
      library.function<SecretSchema *(*)(const char *, SchemaFlags, ...)>(
          "secret_schema_new");
  auto schemaFree =
      library.function<void (*)(SecretSchema *)>("secret_schema_unref");
  auto lookup = library.function<char *(*)(const SecretSchema *, GCancellable *,
                                           GError **, ...)>(
      "secret_password_lookup_sync");
  auto passwordFree =
      library.function<void (*)(char *)>("secret_password_free");
  // Chromium also matches older items by application alone, including items
  // with no xdg:schema attribute. Never create or migrate an item on import.
  auto *schema =
      schemaNew("chrome_libsecret_os_crypt_password_v2", SchemaDontMatchName,
                "application", AttributeString, nullptr);
  if (!schema)
    throw Failure("unreadable", "Could not initialize Safe Storage lookup");
  std::unique_ptr<SecretSchema, decltype(schemaFree)> freeSchema(schema,
                                                                 schemaFree);
  GError *error = nullptr;
  char *password =
      lookup(schema, nullptr, &error, "application", id.application, nullptr);
  struct FreePassword {
    char *p;
    decltype(passwordFree) free;
    ~FreePassword() {
      wipe(p);
      if (p)
        free(p);
    }
  } freePassword{password, passwordFree};
  if (error) {
    g_error_free(error);
    throw Failure(
        "locked",
        "The source browser Safe Storage lookup failed or was cancelled");
  }
  if (!password || !*password)
    throw Failure("locked",
                  "The source browser Safe Storage item is unavailable");
  return Bytes(password, password + std::strlen(password));
}
struct UnrefVariant {
  void operator()(GVariant *p) const {
    if (p)
      g_variant_unref(p);
  }
};
using Variant = std::unique_ptr<GVariant, UnrefVariant>;
Bytes kwallet(const Identity &id, LinuxSecretBackend backend) {
  const char *service =
      backend == LinuxSecretBackend::KWallet6   ? "org.kde.kwalletd6"
      : backend == LinuxSecretBackend::KWallet5 ? "org.kde.kwalletd5"
                                                : "org.kde.kwalletd";
  const char *path =
      backend == LinuxSecretBackend::KWallet6   ? "/modules/kwalletd6"
      : backend == LinuxSecretBackend::KWallet5 ? "/modules/kwalletd5"
                                                : "/modules/kwalletd";
  GError *error = nullptr;
  auto *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &error);
  if (error)
    g_error_free(error);
  if (!bus)
    throw Failure("locked", "The desktop secret service is unavailable");
  std::unique_ptr<GDBusConnection, void (*)(GDBusConnection *)> freeBus(
      bus, [](GDBusConnection *p) { g_object_unref(p); });
  auto call = [&](const char *method, GVariant *args, const char *type) {
    GError *failure = nullptr;
    Variant result(g_dbus_connection_call_sync(
        bus, service, path, "org.kde.KWallet", method, args,
        G_VARIANT_TYPE(type), G_DBUS_CALL_FLAGS_NONE, 30000, nullptr,
        &failure));
    if (failure)
      g_error_free(failure);
    if (!result)
      throw Failure("locked",
                    "The source browser wallet lookup failed or was cancelled");
    return result;
  };
  auto wallet = call("networkWallet", nullptr, "(s)");
  const char *name = nullptr;
  g_variant_get(wallet.get(), "(&s)", &name);
  if (!name || !*name)
    throw Failure("locked", "The desktop wallet is unavailable");
  // open() may create a wallet. Import only reads an existing one.
  auto wallets = call("wallets", nullptr, "(as)");
  gchar **names = nullptr;
  g_variant_get(wallets.get(), "(^as)", &names);
  bool exists = false;
  if (names) {
    for (auto current = names; *current; ++current)
      exists |= std::strcmp(*current, name) == 0;
    g_strfreev(names);
  }
  if (!exists)
    throw Failure("locked", "The source browser wallet does not exist");
  // This is the requester shown in authorization prompts and remembered grants,
  // independent of the source browser's folder, label and lookup attributes.
  constexpr char caller[] = "Bay";
  auto opened =
      call("open", g_variant_new("(sxs)", name, gint64(0), caller), "(i)");
  gint32 handle = -1;
  g_variant_get(opened.get(), "(i)", &handle);
  if (handle < 0)
    throw Failure("locked", "The desktop wallet was not unlocked");
  struct Close {
    decltype(call) &invoke;
    gint32 handle;
    const char *application;
    ~Close() {
      try {
        invoke("close", g_variant_new("(ibs)", handle, FALSE, application),
               "(i)");
      } catch (...) {
      }
    }
  } close{call, handle, caller};
  auto folder = call("hasFolder",
                     g_variant_new("(iss)", handle, id.folder, caller), "(b)");
  gboolean found = FALSE;
  g_variant_get(folder.get(), "(b)", &found);
  if (!found)
    throw Failure("locked", "The source browser wallet folder is unavailable");
  auto entry =
      call("hasEntry",
           g_variant_new("(isss)", handle, id.folder, id.label, caller), "(b)");
  g_variant_get(entry.get(), "(b)", &found);
  if (!found)
    throw Failure("locked",
                  "The source browser Safe Storage item is unavailable");
  auto reply =
      call("readPassword",
           g_variant_new("(isss)", handle, id.folder, id.label, caller), "(s)");
  char *password = nullptr;
  g_variant_get(reply.get(), "(s)", &password);
  struct Free {
    char *p;
    ~Free() {
      wipe(p);
      g_free(p);
    }
  } free{password};
  if (!password || !*password)
    throw Failure("locked", "The source browser Safe Storage item is empty");
  return Bytes(password, password + std::strlen(password));
}
} // namespace
Bytes lookupLinuxSafeStorage(LinuxChromiumBrowser browser,
                             LinuxSecretBackend backend) {
  auto id = identity(browser);
  if (backend == LinuxSecretBackend::Automatic) {
    auto *desktop = std::getenv("XDG_CURRENT_DESKTOP");
    auto *version = std::getenv("KDE_SESSION_VERSION");
    if (desktop && std::strstr(desktop, "KDE"))
      backend = version && std::strcmp(version, "6") == 0
                    ? LinuxSecretBackend::KWallet6
                : version && std::strcmp(version, "5") == 0
                    ? LinuxSecretBackend::KWallet5
                    : LinuxSecretBackend::KWallet;
    else
      backend = LinuxSecretBackend::SecretService;
  }
  switch (backend) {
  case LinuxSecretBackend::SecretService:
    return secretService(id);
  case LinuxSecretBackend::KWallet:
  case LinuxSecretBackend::KWallet5:
  case LinuxSecretBackend::KWallet6:
    return kwallet(id, backend);
  default:
    throw Failure("unsupported", "Unknown source browser secret backend");
  }
}
} // namespace bay::importer
#else
namespace bay::importer {
Bytes lookupLinuxSafeStorage(LinuxChromiumBrowser, LinuxSecretBackend) {
  throw Failure("unsupported", "Desktop secret lookup requires Linux");
}
} // namespace bay::importer
#endif
