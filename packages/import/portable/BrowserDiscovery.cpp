#include "BrowserDiscovery.h"
#include "bay_import.h"
#include <algorithm>
#include <cstdlib>
#include <set>

namespace bay::importer::discovery {
namespace fs = std::filesystem;
using Json = nlohmann::json;
namespace {
bool directory(const fs::path &path) {
  std::error_code error;
  return fs::is_directory(path, error);
}
fs::path canonicalPath(const fs::path &path) {
  std::error_code error;
  auto result = fs::canonical(path, error);
  return error ? fs::path{} : result;
}
// Percent encoding is injective, unlike truncation or an implementation-defined
// hash. Include both app ID and root suffix for multiple roots in one sandbox.
std::string encode(const std::string &value) {
  std::string out;
  constexpr char hex[] = "0123456789abcdef";
  for (unsigned char c : value) {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') || c == '-' || c == '_')
      out += c;
    else {
      out += '%';
      out += hex[c >> 4];
      out += hex[c & 15];
    }
  }
  return out;
}
struct Product {
  const char *id, *name, *directory;
  bool rootProfile = false;
};
// Chrome channel directories: chromium/src/docs/user_data_dir.md.
// Helium: helium-linux 473c0f72, change-chromium-branding.patch.
constexpr Product chromiumProducts[] = {
    {"chrome", "Google Chrome", "google-chrome"},
    {"chromeBeta", "Google Chrome Beta", "google-chrome-beta"},
    {"chromeDev", "Google Chrome Dev", "google-chrome-unstable"},
    {"chromeCanary", "Google Chrome Canary", "google-chrome-canary"},
    {"chromium", "Chromium", "chromium"},
    {"brave", "Brave", "BraveSoftware/Brave-Browser"},
    {"vivaldi", "Vivaldi", "vivaldi"},
    {"opera", "Opera", "opera", true},
    {"edge", "Microsoft Edge", "microsoft-edge"},
    {"helium", "Helium", "net.imput.helium"}};
// The shared reader (bay-import's discovery), as the C ABI gives it.
Json shared(const Json &request) {
  auto text = request.dump();
  char *answer = bay_import_read(text.c_str(), nullptr, nullptr);
  auto parsed = Json::parse(answer ? answer : "null", nullptr, false);
  bay_import_string_free(answer);
  return parsed.is_object() && parsed.contains("value") ? parsed["value"]
                                                        : Json::array();
}
} // namespace

Environment linuxEnvironment() {
  auto env = [](const char *name) {
    auto value = std::getenv(name);
    return value ? fs::u8path(value) : fs::path{};
  };
  return {env("HOME"), env("XDG_CONFIG_HOME")};
}
std::vector<Browser> linuxBrowsers(const Environment &environment) {
  // XDG requires absolute paths; a missing HOME must never scan the cwd.
  if (!environment.home.is_absolute())
    return {};
  auto home = environment.home.lexically_normal();
  auto config = environment.configHome.is_absolute()
                    ? environment.configHome.lexically_normal()
                    : home / ".config";
  std::vector<Browser> out;
  std::set<fs::path> seen;
  auto add = [&](std::string id, std::string name, const fs::path &root,
                 const std::string &product, bool firefox = false,
                 bool rootProfile = false) {
    if (!directory(root))
      return;
    auto resolved = canonicalPath(root);
    if (resolved.empty() || !seen.insert(resolved).second)
      return;
    out.push_back({std::move(id), std::move(name), resolved, firefox,
                   rootProfile, product});
  };
  auto identity = [](const Product &product) {
    return std::string(product.id).rfind("chrome", 0) == 0 ? "chrome"
                                                           : product.id;
  };
  for (auto &product : chromiumProducts)
    add(product.id, product.name, config / product.directory, identity(product),
        false, product.rootProfile);
  add("chromium:snap", "Chromium (Snap)",
      home / "snap/chromium/common/chromium", "chromium");
  add("firefox", "Firefox", home / ".mozilla/firefox", "firefox", true);
  // Firefox 147+ uses XDG for new installations; existing ones keep .mozilla.
  add("firefox:xdg", "Firefox (XDG)", config / "mozilla/firefox", "firefox",
      true);
  add("firefox:snap", "Firefox (Snap)",
      home / "snap/firefox/common/.mozilla/firefox", "firefox", true);
  // Zen fb80623e, nsXREDirProvider-cpp.patch: XDG plus legacy .zen.
  add("zen", "Zen", config / "zen", "zen", true);
  add("zen:legacy", "Zen (legacy)", home / ".zen", "zen", true);
  auto flatpak = home / ".var/app";
  std::vector<fs::path> apps;
  std::error_code error;
  for (fs::directory_iterator it(flatpak, error), end; !error && it != end;
       it.increment(error))
    if (directory(it->path()))
      apps.push_back(it->path());
  std::sort(apps.begin(), apps.end());
  for (auto &app : apps) {
    auto appId = app.filename().u8string();
    for (auto &product : chromiumProducts) {
      auto id = std::string(product.id) + ":flatpak:" + encode(appId);
      add(id, std::string(product.name) + " (Flatpak: " + appId + ")",
          app / "config" / product.directory, identity(product), false,
          product.rootProfile);
    }
    if (appId == "org.mozilla.firefox") {
      add("firefox:flatpak:" + encode(appId), "Firefox (Flatpak)",
          app / ".mozilla/firefox", "firefox", true);
      add("firefox:flatpak:" + encode(appId) + ":xdg", "Firefox (Flatpak XDG)",
          app / "config/mozilla/firefox", "firefox", true);
    }
    if (appId == "app.zen_browser.zen") {
      // The manifest persists .zen; official FAQ also documents zen.
      for (auto suffix : {"config/zen", ".zen", "zen"})
        add("zen:flatpak:" + encode(appId) + ":" + encode(suffix),
            "Zen (Flatpak: " + std::string(suffix) + ")", app / suffix, "zen",
            true);
    }
  }
  return out;
}
Json available(const fs::path &profile, bool firefox) {
  return shared({{"reader", "available"},
                 {"profile", profile.u8string()},
                 {"firefox", firefox}});
}
Json profiles(const Browser &browser, const std::string &rootId,
              const fs::path &arcSidebar) {
  Json request = {{"reader", "profiles"},
                  {"root", browser.root.u8string()},
                  {"firefox", browser.firefox},
                  {"rootIsProfile", browser.rootProfile},
                  {"rootId", rootId}};
  if (!arcSidebar.empty())
    request["arcSidebar"] = arcSidebar.u8string();
  return shared(request);
}
Json linuxAvailable(const fs::path &profile, bool firefox) {
  return available(profile, firefox);
}
Json linuxProfiles(const Browser &browser) {
  return profiles(browser, "Root", {});
}
} // namespace bay::importer::discovery
