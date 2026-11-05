// Exercise production KWallet protocol code with an in-process transport fake.
// No D-Bus connection, wallet or desktop service is opened.
#include <gio/gio.h>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
std::vector<std::string> calls;
bool missingWallet = false, missingFolder = false, missingEntry = false;
bool denied = false, failedRead = false;
std::string expectedService, expectedPath;
std::string expectedFolder = "Chrome Keys",
            expectedLabel = "Chrome Safe Storage";
void require(bool value, const char *message) {
  if (!value)
    throw std::runtime_error(message);
}
GDBusConnection *FakeBus(GBusType type, GCancellable *, GError **) {
  require(type == G_BUS_TYPE_SESSION, "wrong bus");
  return reinterpret_cast<GDBusConnection *>(
      g_object_new(G_TYPE_OBJECT, nullptr));
}
GVariant *FakeCall(GDBusConnection *, const gchar *service, const gchar *path,
                   const gchar *interface, const gchar *method,
                   GVariant *arguments, const GVariantType *, GDBusCallFlags,
                   gint timeout, GCancellable *, GError **error) {
  require(service == expectedService && path == expectedPath &&
              std::string(interface) == "org.kde.KWallet" && timeout == 30000,
          "wrong wallet endpoint or deadline");
  calls.push_back(method);
  std::string name = method;
  if (arguments) {
    g_variant_ref_sink(arguments);
    struct Release {
      GVariant *p;
      ~Release() { g_variant_unref(p); }
    } release{arguments};
    auto *last = g_variant_get_child_value(arguments,
                                           g_variant_n_children(arguments) - 1);
    require(g_variant_is_of_type(last, G_VARIANT_TYPE_STRING) &&
                std::string(g_variant_get_string(last, nullptr)) == "Bay",
            "authorization identified the source browser instead of Bay");
    g_variant_unref(last);
    if (name == "open") {
      const gchar *wallet = nullptr, *caller = nullptr;
      gint64 window;
      g_variant_get(arguments, "(&sx&s)", &wallet, &window, &caller);
      require(std::string(wallet) == "existing" && window == 0,
              "wrong existing wallet");
    } else if (name == "hasFolder") {
      const gchar *folder = nullptr;
      g_variant_get_child(arguments, 1, "&s", &folder);
      require(std::string(folder) == expectedFolder, "source folder changed");
    } else if (name == "hasEntry" || name == "readPassword") {
      const gchar *folder = nullptr, *label = nullptr;
      g_variant_get_child(arguments, 1, "&s", &folder);
      g_variant_get_child(arguments, 2, "&s", &label);
      require(std::string(folder) == expectedFolder &&
                  std::string(label) == expectedLabel,
              "source item changed");
    }
  }
  GVariant *reply = nullptr;
  if (name == "networkWallet")
    reply = g_variant_new("(s)", "existing");
  else if (name == "wallets") {
    const gchar *names[] = {missingWallet ? "other" : "existing", nullptr};
    reply = g_variant_new("(^as)", names);
  } else if (name == "open")
    reply = g_variant_new("(i)", denied ? -1 : 7);
  else if (name == "hasFolder")
    reply = g_variant_new("(b)", !missingFolder);
  else if (name == "hasEntry")
    reply = g_variant_new("(b)", !missingEntry);
  else if (name == "readPassword") {
    if (failedRead) {
      g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED, "fake denial");
      return nullptr;
    }
    reply = g_variant_new("(s)", "fake-existing-secret");
  } else if (name == "close")
    reply = g_variant_new("(i)", 0);
  else
    throw std::runtime_error("unexpected or mutating wallet operation: " +
                             name);
  return g_variant_ref_sink(reply);
}
} // namespace

#define BAY_IMPORT_SECRET_SERVICE_TEST
#define g_bus_get_sync FakeBus
#define g_dbus_connection_call_sync FakeCall
#include "../SecretService.cpp"
#undef g_dbus_connection_call_sync
#undef g_bus_get_sync

int main() {
  using namespace bay::importer;
  try {
    for (auto backend :
         {LinuxSecretBackend::KWallet, LinuxSecretBackend::KWallet5,
          LinuxSecretBackend::KWallet6}) {
      auto suffix = backend == LinuxSecretBackend::KWallet5   ? "5"
                    : backend == LinuxSecretBackend::KWallet6 ? "6"
                                                              : "";
      expectedService = std::string("org.kde.kwalletd") + suffix;
      expectedPath = std::string("/modules/kwalletd") + suffix;
      expectedFolder = "Chrome Keys";
      expectedLabel = "Chrome Safe Storage";
      auto read = [&] {
        return lookupLinuxSafeStorage(LinuxChromiumBrowser::Chrome, backend);
      };
      auto fails = [&] {
        bool failed = false;
        try {
          read();
        } catch (const Failure &error) {
          failed = error.code == "locked";
        }
        require(failed, "expected locked failure");
      };
      calls.clear();
      missingWallet = true;
      fails();
      require(calls == std::vector<std::string>{"networkWallet", "wallets"},
              "missing wallet reached create-capable open");
      missingWallet = false;
      denied = true;
      calls.clear();
      fails();
      require(calls ==
                  std::vector<std::string>{"networkWallet", "wallets", "open"},
              "denied open reached item lookup");
      denied = false;
      missingFolder = true;
      calls.clear();
      fails();
      require(calls.back() == "close" && calls[calls.size() - 2] == "hasFolder",
              "missing folder caused writes or leaked handle");
      missingFolder = false;
      missingEntry = true;
      calls.clear();
      fails();
      require(calls.back() == "close" && calls[calls.size() - 2] == "hasEntry",
              "missing entry caused writes or leaked handle");
      missingEntry = false;
      failedRead = true;
      calls.clear();
      fails();
      require(calls.back() == "close", "failed read leaked handle");
      failedRead = false;
      calls.clear();
      auto secret = read();
      require(
          std::string(secret.begin(), secret.end()) == "fake-existing-secret" &&
              calls == std::vector<std::string>{"networkWallet", "wallets",
                                                "open", "hasFolder", "hasEntry",
                                                "readPassword", "close"},
          "existing wallet protocol differs");
    }
    for (auto browser :
         {LinuxChromiumBrowser::Chrome, LinuxChromiumBrowser::Chromium,
          LinuxChromiumBrowser::Brave, LinuxChromiumBrowser::Edge,
          LinuxChromiumBrowser::Vivaldi, LinuxChromiumBrowser::Opera,
          LinuxChromiumBrowser::Helium}) {
      const auto prefix = browser == LinuxChromiumBrowser::Brave ? "Brave"
                          : browser == LinuxChromiumBrowser::Chrome ||
                                  browser == LinuxChromiumBrowser::Vivaldi
                              ? "Chrome"
                              : "Chromium";
      const auto application = browser == LinuxChromiumBrowser::Brave ? "brave"
                               : std::string(prefix) == "Chrome"      ? "chrome"
                                                                 : "chromium";
      require(std::string(identity(browser).application) == application,
              "Secret Service application identity differs");
      expectedFolder = std::string(prefix) + " Keys";
      expectedLabel = std::string(prefix) + " Safe Storage";
      calls.clear();
      auto secret =
          lookupLinuxSafeStorage(browser, LinuxSecretBackend::KWallet6);
      require(std::string(secret.begin(), secret.end()) ==
                      "fake-existing-secret" &&
                  calls.back() == "close",
              "browser identity lookup failed");
    }
    g_print(
        "Read-only KWallet protocol and Bay authorization fixtures passed\n");
    return 0;
  } catch (const std::exception &error) {
    g_printerr("%s\n", error.what());
    return 1;
  }
}
