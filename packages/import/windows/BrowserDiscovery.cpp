#include "BrowserDiscovery.h"
#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <map>
#include <set>
#include <sstream>

namespace bay::importer::discovery {
namespace fs = std::filesystem;
using Json = nlohmann::json;
namespace {
bool directory(const fs::path &path) {
  std::error_code error;
  return fs::is_directory(path, error);
}
bool regular(const fs::path &path) {
  std::error_code error;
  return fs::is_regular_file(path, error);
}
fs::path canonicalPath(const fs::path &path) {
  std::error_code error;
  auto result = fs::canonical(path, error);
  return error ? fs::path{} : result;
}
bool within(const fs::path &root, const fs::path &path) {
  auto r = root.begin(), p = path.begin();
  for (; r != root.end(); ++r, ++p)
    if (p == path.end() || *r != *p)
      return false;
  return true;
}
fs::path relativeDirectory(const fs::path &root, const fs::path &path) {
  if (path.empty() || path.is_absolute())
    return {};
  for (const auto &part : path)
    if (part == "..")
      return {};
  auto base = canonicalPath(root), resolved = canonicalPath(root / path);
  return !base.empty() && !resolved.empty() && resolved != base &&
                 within(base, resolved) && directory(resolved)
             ? resolved
             : fs::path{};
}
std::string read(const fs::path &path) {
  std::ifstream input(path, std::ios::binary);
  std::ostringstream out;
  out << input.rdbuf();
  return out.str();
}
std::string string(const Json &value, const char *key) {
  auto it = value.find(key);
  return it != value.end() && it->is_string() ? it->get<std::string>() : "";
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
std::string trim(std::string text) {
  auto start = text.find_first_not_of(" \t\r\n");
  if (start == std::string::npos)
    return "";
  return text.substr(start, text.find_last_not_of(" \t\r\n") - start + 1);
}
using Registry = std::map<std::string, std::map<std::string, std::string>>;
Registry ini(const fs::path &path) {
  std::istringstream input(read(path));
  Registry sections;
  std::string line, section;
  bool first = true;
  while (std::getline(input, line)) {
    if (first && line.compare(0, 3, "\xef\xbb\xbf") == 0)
      line.erase(0, 3);
    first = false;
    line = trim(line);
    if (line.empty() || line[0] == '#' || line[0] == ';')
      continue;
    if (line.front() == '[') {
      section = line.back() == ']' ? trim(line.substr(1, line.size() - 2)) : "";
      continue;
    }
    auto eq = line.find('=');
    if (!section.empty() && eq != std::string::npos)
      sections[section][trim(line.substr(0, eq))] = trim(line.substr(eq + 1));
  }
  return sections;
}
bool numbered(const std::string &value, const std::string &prefix) {
  return value.size() > prefix.size() &&
         value.compare(0, prefix.size(), prefix) == 0 &&
         std::all_of(value.begin() + prefix.size(), value.end(),
                     [](char c) { return c >= '0' && c <= '9'; });
}
fs::path registeredPath(const fs::path &root, const std::string &text,
                        bool absolute) {
  if (text.empty() || text.find('\0') != std::string::npos)
    return {};
  auto path = fs::u8path(text);
  if (!absolute)
    return relativeDirectory(root, path);
  // Firefox explicitly supports external absolute profiles. They are registered
  // sources, not claimed to be contained in the browser's data root.
  return path.is_absolute() && directory(path) ? canonicalPath(path)
                                               : fs::path{};
}
Json firefoxProfiles(const Browser &browser) {
  auto sections = ini(browser.root / "profiles.ini");
  auto installs = ini(browser.root / "installs.ini");
  std::set<fs::path> defaults;
  auto addDefault = [&](const std::string &text) {
    auto path =
        registeredPath(browser.root, text, fs::u8path(text).is_absolute());
    if (!path.empty())
      defaults.insert(path);
  };
  for (auto &entry : sections)
    if (entry.first.rfind("Install", 0) == 0)
      addDefault(entry.second["Default"]);
  for (auto &entry : installs)
    addDefault(entry.second["Default"]);
  Json out = Json::array();
  std::set<fs::path> seen, profileDefaults;
  for (auto &entry : sections) {
    if (!numbered(entry.first, "Profile"))
      continue;
    auto &values = entry.second;
    auto relative = values["IsRelative"];
    if (!relative.empty() && relative != "0" && relative != "1")
      continue;
    auto path = registeredPath(browser.root, values["Path"], relative == "0");
    if (path.empty())
      continue;
    if (values["Default"] == "1")
      profileDefaults.insert(path);
    if (!seen.insert(path).second)
      continue;
    out.push_back(
        {{"id", entry.first},
         {"name", values["Name"].empty() ? entry.first : values["Name"]},
         {"path", path.u8string()},
         {"isDefault", false},
         {"available", linuxAvailable(path, true)}});
  }
  // A stale install default must not suppress a valid profile-level default.
  bool hasInstallDefault =
      std::any_of(out.begin(), out.end(), [&](const Json &p) {
        return defaults.count(fs::u8path(p.at("path").get<std::string>()));
      });
  for (auto &profile : out)
    profile["isDefault"] =
        hasInstallDefault
            ? defaults.count(
                  fs::u8path(profile.at("path").get<std::string>())) != 0
            : profileDefaults.count(
                  fs::u8path(profile.at("path").get<std::string>())) != 0;
  return out;
}
Json chromiumProfiles(const Browser &browser) {
  Json state = Json::parse(read(browser.root / "Local State"), nullptr, false);
  Json info = Json::object();
  std::string lastUsed;
  if (state.is_object() && state.contains("profile") &&
      state["profile"].is_object()) {
    auto &profile = state["profile"];
    lastUsed = string(profile, "last_used");
    if (profile.contains("info_cache") && profile["info_cache"].is_object())
      info = profile["info_cache"];
  }
  std::map<std::string, fs::path> paths;
  auto add = [&](const std::string &id) {
    auto leaf = fs::u8path(id);
    if (id.empty() || leaf.filename() != leaf || id == "." || id == ".." ||
        id.find('\0') != std::string::npos)
      return;
    auto path = relativeDirectory(browser.root, leaf);
    if (!path.empty())
      paths.emplace(id, path);
  };
  std::error_code error;
  for (fs::directory_iterator it(browser.root, error), end; !error && it != end;
       it.increment(error)) {
    auto id = it->path().filename().u8string();
    if (id == "Default" || numbered(id, "Profile "))
      add(id);
  }
  for (auto it = info.begin(); it != info.end(); ++it)
    if (it.value().is_object())
      add(it.key());
  // Older Opera versions keep data directly in the user-data root. Avoid
  // inventing a root profile just because Local State exists.
  bool root =
      browser.rootProfile && (!linuxAvailable(browser.root, false).empty() ||
                              regular(browser.root / "Preferences"));
  if (root)
    paths.emplace("Root", canonicalPath(browser.root));
  if (!paths.count(lastUsed))
    lastUsed = paths.count("Default") ? "Default" : root ? "Root" : "";
  auto defaultPath = paths.count(lastUsed) ? paths.at(lastUsed) : fs::path{};
  Json out = Json::array();
  std::set<fs::path> seen;
  for (auto &entry : paths) {
    if (!seen.insert(entry.second).second)
      continue;
    auto metadata =
        info.contains(entry.first) ? info[entry.first] : Json::object();
    auto name = string(metadata, "name"), email = string(metadata, "user_name");
    Json profile = {{"id", entry.first},
                    {"name", name.empty() ? entry.first : name},
                    {"path", entry.second.u8string()},
                    {"isDefault", entry.second == defaultPath},
                    {"available", linuxAvailable(entry.second, false)}};
    if (!email.empty())
      profile["email"] = email;
    out.push_back(std::move(profile));
  }
  return out;
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
Json linuxAvailable(const fs::path &profile, bool firefox) {
  Json out = Json::array();
  auto file = [&](const char *name) { return regular(profile / name); };
  auto dir = [&](const char *name) { return directory(profile / name); };
  auto add = [&](const char *kind, bool present) {
    if (present)
      out.push_back(kind);
  };
  add("bookmarks", firefox ? file("places.sqlite")
                           : file("Bookmarks") || file("AccountBookmarks"));
  add("history", file(firefox ? "places.sqlite" : "History"));
  add("passwords", file(firefox ? "logins.json" : "Login Data"));
  add("tabs", firefox
                  ? dir("sessionstore-backups") ||
                        file("sessionstore.jsonlz4") || file("sessionstore.js")
                  : dir("Sessions") || dir("Sessions_Encrypted") ||
                        file("Current Session") || file("Last Session"));
  add("cookies", firefox && file("cookies.sqlite"));
  add("autofill", !firefox && file("Web Data"));
  return out;
}
Json linuxProfiles(const Browser &browser) {
  Json out =
      browser.firefox ? firefoxProfiles(browser) : chromiumProfiles(browser);
  std::stable_sort(out.begin(), out.end(), [](const Json &a, const Json &b) {
    return a.at("isDefault").get<bool>() && !b.at("isDefault").get<bool>();
  });
  return out;
}
} // namespace bay::importer::discovery
