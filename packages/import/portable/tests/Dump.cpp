// Writes what the shared C++ readers give for every fixture profile, one JSON file each, so a port can be checked
// against today's answers (packages/import/fixtures/wire, docs/shared-desktop-core-plan.html Phase 0). Only the
// readers that need no secret: the credential readers are checked by their own tests.
//
//   python3 packages/import/scripts/record-wire.py   (compiles this and rewrites fixtures/wire)
#include "../ImportCore.h"
#include <fstream>
#include <iostream>

using namespace bay::importer;

namespace {
Path fixtures, output, scratch;
std::atomic_bool cancelled{false};

void write(const std::string &name, const Json &value) {
  std::ofstream(output / (name + ".json")) << value.dump(2) << "\n";
}

// A copy, as the readers would see a profile another browser has open: places.sqlite's WAL must survive.
Path copied(const Path &profile, const std::string &name) {
  auto target = scratch / name;
  std::filesystem::remove_all(target);
  std::filesystem::copy(profile, target, std::filesystem::copy_options::recursive);
  return target;
}

Path support(const std::string &relative) {
  return fixtures / "home/Library/Application Support" / relative;
}
} // namespace

int main(int argc, char **argv) {
  try {
    if (argc != 4)
      throw std::runtime_error("usage: dump <fixtures> <output> <scratch>");
    fixtures = argv[1];
    output = argv[2];
    scratch = argv[3];
    std::filesystem::create_directories(output);
    std::filesystem::create_directories(scratch);

    for (const char *name : {"chrome-passwords", "bitwarden", "firefox-passwords"})
      write(std::string("csv-") + name, parsePasswordsCSV(readText(fixtures / "csv" / (std::string(name) + ".csv"))));
    write("html-chrome-bookmarks", parseNetscapeBookmarks(readText(fixtures / "html/chrome-bookmarks.html")));

    const std::pair<const char *, const char *> chromium[] = {
        {"chrome-default", "Google/Chrome/Default"},
        {"chrome-profile-1", "Google/Chrome/Profile 1"},
        {"brave-default", "BraveSoftware/Brave-Browser/Default"},
        {"dia-default", "Dia/User Data/Default"},
        {"dia-profile-2", "Dia/User Data/Profile 2"},
        {"arc-default", "Arc/User Data/Default"},
        {"opera", "com.operasoftware.Opera"},
        {"helium-default", "net.imput.helium/Default"},
    };
    for (const auto &[name, relative] : chromium) {
      auto profile = copied(support(relative), name);
      if (std::filesystem::exists(profile / "Bookmarks"))
        write(std::string("bookmarks-") + name, chromiumBookmarks(profile));
      if (std::filesystem::exists(profile / "History")) {
        int count = 0;
        write(std::string("history-") + name, history(profile, false, Options{}, [](const Json &) {}, cancelled, count));
      }
      if (std::filesystem::exists(profile / "Sessions"))
        write(std::string("tabs-") + name, chromiumTabs(profile, cancelled));
      write(std::string("extensions-") + name, extensions(profile));
    }

    auto firefox = copied(support("Firefox/Profiles/abcd1234.default-release"), "firefox-default");
    write("bookmarks-firefox-default", firefoxBookmarks(firefox, cancelled));
    int count = 0;
    write("history-firefox-default", history(firefox, true, Options{}, [](const Json &) {}, cancelled, count));
    write("tabs-firefox-default", firefoxTabs(firefox, cancelled));
    write("extensions-firefox-default", extensions(firefox));
    write("extensions-firefox-extensions", extensions(copied(fixtures / "firefox-extensions/profile", "firefox-extensions")));
    write("extensions-chromium-extensions", extensions(copied(fixtures / "extensions/Default", "chromium-extensions")));

    write("arc-sidebar", arcSidebar(support("Arc/StorableSidebar.json")));
    write("arc-nested-sidebar", arcSidebar(fixtures / "arc/nested-sidebar.json"));
    write("zen-spaces-firefox-default", zenSpaces(firefox, "Profiles/abcd1234.default-release"));
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "dump: " << error.what() << "\n";
    return 1;
  }
}
