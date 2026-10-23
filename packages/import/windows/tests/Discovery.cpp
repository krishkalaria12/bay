#include "../BrowserDiscovery.h"
#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>

namespace d = bay::importer::discovery;
namespace fs = std::filesystem;
using Json = nlohmann::json;
namespace {
void require(bool condition, const char *message) {
  if (!condition)
    throw std::runtime_error(message);
}
void put(const fs::path &path, const std::string &text = "fixture") {
  fs::create_directories(path.parent_path());
  std::ofstream stream(path, std::ios::binary);
  stream << text;
  require(stream.good(), "failed to write discovery fixture");
}
const d::Browser &browser(const std::vector<d::Browser> &all,
                          const std::string &id) {
  for (auto &entry : all)
    if (entry.id == id)
      return entry;
  throw std::runtime_error("missing browser " + id);
}
const Json &profile(const Json &all, const std::string &id) {
  for (auto &entry : all)
    if (entry.at("id") == id)
      return entry;
  throw std::runtime_error("missing profile " + id);
}
bool includes(const Json &all, const char *kind) {
  return std::find(all.begin(), all.end(), Json(kind)) != all.end();
}
void env(const char *key, const std::string &value) {
#ifdef _WIN32
  _putenv_s(key, value.c_str());
#else
  setenv(key, value.c_str(), 1);
#endif
}
struct SavedEnvironment {
  std::map<std::string, std::string> values;
  std::set<std::string> missing;
  SavedEnvironment() {
    for (auto key : {"HOME", "XDG_CONFIG_HOME"}) {
      auto value = std::getenv(key);
      if (value)
        values[key] = value;
      else
        missing.insert(key);
    }
  }
  ~SavedEnvironment() {
    for (auto &entry : values)
      env(entry.first.c_str(), entry.second);
    for (auto &key : missing) {
#ifdef _WIN32
      _putenv_s(key.c_str(), "");
#else
      unsetenv(key.c_str());
#endif
    }
  }
};
void roots(const fs::path &temporary) {
  auto home = temporary / "roots", config = home / "xdg";
  for (auto name :
       {"google-chrome", "google-chrome-beta", "google-chrome-unstable",
        "google-chrome-canary", "chromium", "BraveSoftware/Brave-Browser",
        "vivaldi", "opera", "microsoft-edge", "net.imput.helium"})
    fs::create_directories(config / name / "Default");
  for (auto name : {".mozilla/firefox", "snap/firefox/common/.mozilla/firefox",
                    ".zen", "xdg/zen"})
    fs::create_directories(home / name);
  auto flatpak = home / ".var/app";
  for (auto name :
       {"org.chromium.Chromium/config/chromium",
        "org.chromium.Second/config/chromium",
        "org.chromium%2eSecond/config/chromium",
        "com.google.Chrome/config/google-chrome",
        "org.mozilla.firefox/.mozilla/firefox", "app.zen_browser.zen/.zen",
        "app.zen_browser.zen/config/zen", "app.zen_browser.zen/zen"})
    fs::create_directories(flatpak / name);
  auto all = d::linuxBrowsers({home, config});
  for (auto id : {"chrome", "chromeBeta", "chromeDev", "chromeCanary",
                  "chromium", "brave", "vivaldi", "opera", "edge", "helium",
                  "firefox", "firefox:snap", "zen", "zen:legacy"})
    require(!browser(all, id).root.empty(), "native root missing");
  require(browser(all, "helium").root == config / "net.imput.helium",
          "Helium directory guessed");
  require(browser(all, "chromeBeta").productId == "chrome" &&
              browser(all, "chromeCanary").productId == "chrome",
          "branded channel secret identity differs");
  std::set<std::string> ids;
  std::map<fs::path, std::string> before;
  for (auto &entry : all) {
    require(ids.insert(entry.id).second, "browser IDs collide");
    require(!entry.productId.empty(), "source lost trusted product identity");
    before[entry.root] = entry.id;
  }
  unsigned chromium = 0, firefox = 0, zen = 0;
  for (auto &entry : all) {
    chromium += entry.productId == "chromium";
    firefox += entry.productId == "firefox";
    zen += entry.productId == "zen";
  }
  require(chromium == 4 && firefox == 3 && zen == 5,
          "packaged installations missing or conflated");
  fs::create_directories(flatpak / "aaa.new/config/chromium");
  for (auto &entry : d::linuxBrowsers({home, config}))
    if (before.count(entry.root))
      require(before.at(entry.root) == entry.id,
              "adding an installation changed existing IDs");
  auto empty = temporary / "empty";
  fs::create_directories(empty);
  require(d::linuxBrowsers({empty, {}}).empty(),
          "missing roots invented browsers");
  require(d::linuxBrowsers({{}, config}).empty(),
          "missing HOME allowed cwd discovery");
  require(d::linuxBrowsers({"relative", config}).empty(),
          "relative HOME accepted");
  put(home / ".config/chromium/Default/Bookmarks");
  auto fallback = d::linuxBrowsers({home, "relative-xdg"});
  require(browser(fallback, "chromium").root == home / ".config/chromium",
          "relative XDG did not fall back to HOME");
  SavedEnvironment saved;
  env("HOME", home.u8string());
  env("XDG_CONFIG_HOME", config.u8string());
  auto environment = d::linuxEnvironment();
  require(environment.home == home && environment.configHome == config,
          "environment seam lost fixture roots");
  require(d::linuxBrowsers(environment).size() == all.size() + 1,
          "environment discovery differs from explicit roots");
}
void chromiumProfiles(const fs::path &temporary) {
  auto root = temporary / "chromium";
  for (auto name : {"Default", "Profile 1", "Profile 2", "Profile invalid",
                    "Guest Profile", "System Profile", "Work"})
    fs::create_directories(root / name);
  put(root / "Default/Bookmarks");
  put(root / "Profile 1/History");
  d::Browser source{"chromium", "Chromium", root, false, false, "chromium"};
  for (auto state : {"", "not json", "[]", "null", "{\"profile\":false}",
                     "{\"profile\":{\"info_cache\":[]}}"}) {
    put(root / "Local State", state);
    auto all = d::linuxProfiles(source);
    require(all.size() == 3 && all[0]["id"] == "Default" &&
                all[0]["isDefault"] == true,
            "malformed Local State prevented directory fallback");
  }
  auto outside = temporary / "chromium-other";
  fs::create_directories(outside);
  fs::create_directory_symlink(outside, root / "Profile 3");
  fs::create_directory_symlink(root / "Default", root / "Profile 4");
  Json info = {{"Default", {{"name", 42}, {"user_name", Json::array()}}},
               {"Profile 1",
                {{"name", "Work account"}, {"user_name", "work@example.test"}}},
               {"Profile 2", false},
               {"Work", Json::object()},
               {"../chromium-other", Json::object()},
               {outside.u8string(), Json::object()}};
  put(root / "Local State",
      Json({{"profile", {{"info_cache", info}, {"last_used", "Profile 1"}}}})
          .dump());
  auto all = d::linuxProfiles(source);
  require(all.size() == 4,
          "unsafe registry profile or symlink escaped, or custom profile lost");
  require(all[0]["id"] == "Profile 1" && all[0]["isDefault"] == true,
          "last-used default ignored");
  require(profile(all, "Default")["name"] == "Default",
          "wrong metadata type broke fallback name");
  require(profile(all, "Profile 1")["email"] == "work@example.test",
          "profile account name lost");
  require(profile(all, "Default")["isDefault"] == false,
          "two Chromium defaults selected");
  require(includes(profile(all, "Default")["available"], "bookmarks"),
          "bookmarks unavailable");
  put(root / "Local State",
      Json({{"profile", {{"info_cache", info}, {"last_used", "Profile 4"}}}})
          .dump());
  all = d::linuxProfiles(source);
  require(profile(all, "Default")["isDefault"] == true,
          "deduplicating Chromium alias lost its last-used default");
  fs::remove(root / "Local State");
  fs::remove_all(root / "Default");
  fs::remove(root / "Profile 4");
  all = d::linuxProfiles(source);
  for (auto &entry : all)
    require(entry["isDefault"] == false,
            "fabricated a default from arbitrary directory order");
  auto opera = temporary / "opera";
  put(opera / "Bookmarks");
  auto operaProfiles =
      d::linuxProfiles({"opera", "Opera", opera, false, true, "opera"});
  require(operaProfiles.size() == 1 &&
              operaProfiles[0]["path"] == fs::canonical(opera).u8string() &&
              operaProfiles[0]["isDefault"] == true,
          "Opera root profile missing");
  fs::remove(opera / "Bookmarks");
  put(opera / "Local State", "{}");
  require(
      d::linuxProfiles({"opera", "Opera", opera, false, true, "opera"}).empty(),
      "empty Opera root invented a profile");
}
void firefoxProfiles(const fs::path &temporary) {
  auto root = temporary / "firefox", external = temporary / "external";
  for (auto path : {root / "abcd.default", root / "efgh.release", external})
    fs::create_directories(path);
  d::Browser source{"firefox", "Firefox", root, true, false, "firefox"};
  require(d::linuxProfiles(source).empty(),
          "missing registry invented Firefox profile");
  put(root / "profiles.ini",
      "[invalid\nPath=abcd.default\n[Profilebad]\nPath=abcd.default\n");
  require(d::linuxProfiles(source).empty(), "malformed registry accepted");
  fs::create_directory_symlink(external, root / "escape");
  std::string registry =
      "\xef\xbb\xbf [General]\r\nStartWithLastProfile=1\r\n"
      " [Profile0] \r\n Name = Main "
      "\r\nIsRelative=1\r\nPath=abcd.default\r\nDefault=1\r\n"
      "[Profile1]\nName=Release\nIsRelative=1\nPath=efgh.release\n"
      "[Profile2]\nName=External\nIsRelative=0\nPath=" +
      external.u8string() +
      "\n"
      "[Profile3]\nIsRelative=1\nPath=../external\n"
      "[Profile4]\nIsRelative=1\nPath=" +
      external.u8string() +
      "\n"
      "[Profile5]\nIsRelative=0\nPath=abcd.default\n"
      "[Profile6]\nIsRelative=1\nPath=escape\n"
      "[Profile7]\nIsRelative=banana\nPath=abcd.default\n"
      "[Profile8]\nIsRelative=1\nPath=.\n"
      "[Profile9]\nPath=missing\n"
      "[InstallABC]\nDefault=efgh.release\n";
  put(root / "profiles.ini", registry);
  put(root / "efgh.release/places.sqlite");
  auto all = d::linuxProfiles(source);
  require(all.size() == 3 && all[0]["id"] == "Profile1" &&
              all[0]["isDefault"] == true,
          "valid registry/default selection failed");
  require(profile(all, "Profile0")["name"] == "Main" &&
              profile(all, "Profile0")["isDefault"] == false,
          "INI trimming/default precedence failed");
  require(profile(all, "Profile2")["path"] ==
              fs::canonical(external).u8string(),
          "registered external absolute profile lost");
  require(includes(profile(all, "Profile1")["available"], "history"),
          "Firefox history unavailable");
  auto aliasRegistry = registry.substr(0, registry.find("[InstallABC]"));
  aliasRegistry.replace(aliasRegistry.find("Default=1"), 9, "Default=0");
  aliasRegistry += "[Profile10]\nPath=abcd.default\nIsRelative=1\nDefault=1\n";
  put(root / "profiles.ini", aliasRegistry);
  all = d::linuxProfiles(source);
  require(all.size() == 3 && profile(all, "Profile0")["isDefault"] == true,
          "deduplicating Firefox registry alias lost its default");
  put(root / "profiles.ini", registry.substr(0, registry.find("[InstallABC]")) +
                                 "[InstallABC]\nDefault=missing\n");
  all = d::linuxProfiles(source);
  require(all[0]["id"] == "Profile0" && all[0]["isDefault"] == true,
          "stale install default suppressed valid profile default");
  put(root / "installs.ini", "[ABC]\nDefault=efgh.release\n");
  all = d::linuxProfiles(source);
  require(all[0]["id"] == "Profile1" && all[0]["isDefault"] == true,
          "installs.ini default ignored");
  fs::remove_all(root / "efgh.release");
  all = d::linuxProfiles(source);
  require(all.size() == 2 && all[0]["id"] == "Profile0",
          "stale registered profile not removed");
}
void available(const fs::path &temporary) {
  auto root = temporary / "available";
  for (auto name : {"Bookmarks", "History", "Login Data", "Web Data", "Cookies",
                    "places.sqlite", "logins.json", "cookies.sqlite"})
    put(root / name);
  fs::create_directories(root / "Sessions");
  fs::create_directories(root / "sessionstore-backups");
  auto chromium = d::linuxAvailable(root, false),
       firefox = d::linuxAvailable(root, true);
  require(chromium ==
              Json({"bookmarks", "history", "passwords", "tabs", "autofill"}),
          "Chromium availability changed or advertised bound cookies");
  require(firefox ==
              Json({"bookmarks", "history", "passwords", "tabs", "cookies"}),
          "Firefox availability changed");
  fs::remove(root / "History");
  fs::create_directories(root / "History");
  require(!includes(d::linuxAvailable(root, false), "history"),
          "directory advertised as readable History file");
  require(d::linuxAvailable(temporary / "missing", false).empty(),
          "missing profile advertises data");
}
} // namespace
int main(int argc, char **argv) {
  try {
    require(argc == 2, "expected an empty temporary fixture directory");
    fs::path temporary = fs::canonical(argv[1]);
    require(fs::is_empty(temporary), "fixture directory must be empty");
    roots(temporary);
    chromiumProfiles(temporary);
    firefoxProfiles(temporary);
    available(temporary);
    std::cout << "Linux discovery portable fixtures passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
