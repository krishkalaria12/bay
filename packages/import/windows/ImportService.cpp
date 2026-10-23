#include "ImportCore.h"
#include "BrowserDiscovery.h"
#include <algorithm>
#include <chrono>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#ifdef _WIN32
#include <windows.h>

#include <shobjidl.h>
#include <wrl/client.h>
#endif
namespace bay::importer {
namespace fs = std::filesystem;
namespace {
std::mutex stateMutex;
EventSink eventSink;
ImportWriter importWriter;
std::map<std::string, Bytes> browserKeys;
std::map<std::string, std::string> firefoxPasswords;
std::map<std::string, std::shared_ptr<std::atomic_bool>> jobs;
std::set<std::string> cancelledJobs;
struct Entry {
  SensitiveImport data;
  std::chrono::steady_clock::time_point time;
};
std::map<std::string, Entry> vault;
#if !defined(__linux__) && !defined(BAY_IMPORT_LINUX_TEST)
Path environment(const wchar_t *name) {
#ifdef _WIN32
  wchar_t value[32768]{};
  auto n = GetEnvironmentVariableW(name, value, 32768);
  return n && n < 32768 ? Path(value) : Path{};
#else
  (void)name;
  return {};
#endif
}
#endif
using Browser = discovery::Browser;
std::vector<Browser> browsers() {
#if defined(__linux__) || defined(BAY_IMPORT_LINUX_TEST)
  return discovery::linuxBrowsers(discovery::linuxEnvironment());
#else
  auto local = environment(L"LOCALAPPDATA"), roaming = environment(L"APPDATA");
  std::vector<Browser> definitions;
  if (!local.empty())
    definitions = {
        {"chrome", "Google Chrome", local / "Google/Chrome/User Data"},
        {"edge", "Microsoft Edge", local / "Microsoft/Edge/User Data"},
        {"brave", "Brave", local / "BraveSoftware/Brave-Browser/User Data"},
        {"vivaldi", "Vivaldi", local / "Vivaldi/User Data"},
        {"chromium", "Chromium", local / "Chromium/User Data"},
        {"chromeBeta", "Google Chrome Beta",
         local / "Google/Chrome Beta/User Data"},
        {"chromeDev", "Google Chrome Dev",
         local / "Google/Chrome Dev/User Data"},
        {"chromeCanary", "Google Chrome Canary",
         local / "Google/Chrome SxS/User Data"}};
  if (!roaming.empty()) {
    definitions.push_back({"opera", "Opera",
                           roaming / "Opera Software/Opera Stable", false,
                           true});
    definitions.push_back({"operaGX", "Opera GX",
                           roaming / "Opera Software/Opera GX Stable", false,
                           true});
    definitions.push_back(
        {"firefox", "Firefox", roaming / "Mozilla/Firefox", true});
  }
  if (!local.empty()) {
    std::error_code error;
    for (fs::directory_iterator it(local / "Packages", error), end;
         !error && it != end; it.increment(error)) {
      auto name = it->path().filename().u8string();
      if (name.rfind("TheBrowserCompany.Arc_", 0) == 0)
        definitions.push_back(
            {"arc", "Arc", it->path() / "LocalCache/Local/Arc/User Data"});
    }
  }
  std::vector<Browser> out;
  for (auto &browser : definitions)
    if (fs::is_directory(browser.root))
      out.push_back(browser);
  return out;
#endif
}
#if !defined(__linux__) && !defined(BAY_IMPORT_LINUX_TEST)
Json available(const Path &profile, bool firefox) {
  Json kinds = Json::array();
  auto add = [&](const char *kind, bool exists) {
    if (exists)
      kinds.push_back(kind);
  };
  add("bookmarks",
      fs::exists(profile / (firefox ? "places.sqlite" : "Bookmarks")) ||
          (!firefox && fs::exists(profile / "AccountBookmarks")));
  add("history", fs::exists(profile / (firefox ? "places.sqlite" : "History")));
  add("passwords",
      fs::exists(profile / (firefox ? "logins.json" : "Login Data")));
  add("tabs", firefox ? (fs::exists(profile / "sessionstore-backups") ||
                         fs::exists(profile / "sessionstore.jsonlz4") ||
                         fs::exists(profile / "sessionstore.js"))
                      : (fs::exists(profile / "Sessions") ||
                         fs::exists(profile / "Sessions_Encrypted") ||
                         fs::exists(profile / "Current Session") ||
                         fs::exists(profile / "Last Session")));
  add("cookies",
      firefox &&
          fs::exists(profile / "cookies.sqlite")); // Chromium cookies remain
                                                   // source-browser bound.
  add("autofill", !firefox && fs::exists(profile / "Web Data"));
  return kinds;
}
#endif
Json profiles(const Browser &browser) {
#if defined(__linux__) || defined(BAY_IMPORT_LINUX_TEST)
  return discovery::linuxProfiles(browser);
#else
  Json out = Json::array();
  if (browser.firefox) {
    if (!fs::exists(browser.root / "profiles.ini"))
      return out;
    std::istringstream input(readText(browser.root / "profiles.ini"));
    std::string line, section;
    std::map<std::string, std::map<std::string, std::string>> sections;
    std::set<std::string> defaults;
    while (std::getline(input, line)) {
      if (!line.empty() && line.back() == '\r')
        line.pop_back();
      if (line.empty() || line[0] == '#' || line[0] == ';')
        continue;
      if (line.front() == '[' && line.back() == ']')
        section = line.substr(1, line.size() - 2);
      else {
        auto eq = line.find('=');
        if (eq != std::string::npos)
          sections[section][line.substr(0, eq)] = line.substr(eq + 1);
      }
    }
    for (auto &entry : sections)
      if (entry.first.rfind("Install", 0) == 0 &&
          !entry.second["Default"].empty())
        defaults.insert(entry.second["Default"]);
    for (auto &entry : sections)
      if (entry.first.rfind("Profile", 0) == 0) {
        auto &v = entry.second;
        if (v["Path"].empty())
          continue;
        auto path = fs::u8path(v["Path"]);
        if (v["IsRelative"] != "0")
          path = browser.root / path;
        if (!fs::is_directory(path))
          continue;
        out.push_back(
            {{"id", entry.first},
             {"name", v["Name"].empty() ? entry.first : v["Name"]},
             {"path", path.u8string()},
             {"isDefault", defaults.empty() ? v["Default"] == "1"
                                            : defaults.count(v["Path"]) != 0},
             {"available", available(path, true)}});
      }
  } else {
    Json info = Json::object();
    try {
      info = Json::parse(readText(browser.root / "Local State"))
                 .value("profile", Json::object())
                 .value("info_cache", Json::object());
    } catch (const std::exception &) {
    }
    std::vector<Path> paths;
    if (browser.rootProfile)
      paths.push_back(browser.root);
    else {
      std::error_code error;
      for (fs::directory_iterator it(browser.root, error), end;
           !error && it != end; it.increment(error)) {
        auto name = it->path().filename().u8string();
        if (it->is_directory() &&
            (name == "Default" || name.rfind("Profile ", 0) == 0))
          paths.push_back(it->path());
      }
    }
    std::sort(paths.begin(), paths.end());
    for (auto &path : paths) {
      auto id = browser.rootProfile ? "Default" : path.filename().u8string();
      auto metadata = info.value(id, Json::object());
      auto name = metadata.value("name", id);
      Json profile = {{"id", id},
                      {"name", name.empty() ? id : name},
                      {"path", path.u8string()},
                      {"isDefault", id == "Default"},
                      {"available", available(path, false)}};
      auto email = metadata.value("user_name", "");
      if (!email.empty())
        profile["email"] = email;
      out.push_back(profile);
    }
  }
  if (browser.id == "arc" &&
      fs::exists(browser.root.parent_path() / "StorableSidebar.json")) {
    try {
      auto sidebar =
          arcSidebar(browser.root.parent_path() / "StorableSidebar.json");
      std::function<unsigned(const Json &)> links = [&](const Json &node) {
        if (node.value("type", "") == "url")
          return 1u;
        unsigned count = 0;
        for (auto &child : node.value("children", Json::array()))
          count += links(child);
        return count;
      };
      for (auto &profile : out) {
        Json spaces = Json::array();
        bool favorites =
            sidebar["favorites"].contains(profile["id"].get<std::string>());
        for (auto &space : sidebar["spaces"])
          if (space["profileId"] == profile["id"]) {
            Json summary = {{"id", space["id"]},
                            {"name", space["name"]},
                            {"tabCount", space["tabs"].size()}};
            unsigned count = 0;
            for (auto &node : space["pinned"])
              count += links(node);
            summary["pinnedCount"] = count;
            for (auto key : {"color", "emoji", "icon"})
              if (space.contains(key))
                summary[key] = space[key];
            spaces.push_back(summary);
          }
        if (!spaces.empty()) {
          profile["spaces"] = spaces;
          for (auto kind : {"spaces", "pinnedTabs", "tabs"})
            if (std::find(profile["available"].begin(),
                          profile["available"].end(),
                          kind) == profile["available"].end())
              profile["available"].push_back(kind);
        }
        if (favorites)
          profile["available"].push_back("favorites");
      }
    } catch (
        const std::exception &) { /* Ordinary Chromium data can still be
                                     imported if Arc's sidebar is unreadable. */
    }
  }
  std::stable_sort(out.begin(), out.end(), [](const Json &a, const Json &b) {
    return a.value("isDefault", false) && !b.value("isDefault", false);
  });
  return out;
#endif
}
std::pair<Browser, Json> resolve(const std::string &id,
                                 const std::string &profile) {
  for (auto &browser : browsers())
    if (browser.id == id)
      for (auto &p : profiles(browser))
        if (p.value("id", "") == profile)
          return {browser, p};
  throw Failure("notFound", "The browser profile is no longer available");
}
void purge() {
  auto now = std::chrono::steady_clock::now();
  for (auto it = vault.begin(); it != vault.end();)
    if (now - it->second.time > std::chrono::minutes(10))
      it = vault.erase(it);
    else
      ++it;
}
std::string keep(SensitiveImport data) {
  if (data.cookies.empty() && data.addresses.empty() && data.cards.empty())
    return "";
  std::lock_guard<std::mutex> lock(stateMutex);
  purge();
  auto token = bay::sync::base32(bay::sync::randomBytes(16));
  vault.emplace(token,
                Entry{std::move(data), std::chrono::steady_clock::now()});
  return token;
}
Json import(const Json &args) {
  auto job = args.at(0).get<std::string>(), id = args.at(1).get<std::string>(),
       profileId = args.at(2).get<std::string>();
  auto resolved = resolve(id, profileId);
  auto browser = resolved.first;
  auto p = resolved.second;
  auto path = fs::u8path(p.at("path").get<std::string>());
  auto kinds = args.at(3).get<std::vector<std::string>>();
  auto settings = args.size() > 4 ? args[4] : Json::object();
  Options options;
  if (settings.contains("historyLimit") && !settings["historyLimit"].is_null())
    options.historyLimit = std::max(0, settings["historyLimit"].get<int>());
  if (settings.contains("historySince") && !settings["historySince"].is_null())
    options.historySince = settings["historySince"].get<double>();
  if (settings.contains("chunkSize") && !settings["chunkSize"].is_null())
    options.chunkSize = std::clamp(settings["chunkSize"].get<int>(), 1, 10000);
  options.streamHistory = settings.value("streamHistory", false);
  auto cancelled = std::make_shared<std::atomic_bool>(false);
  Bytes key;
  std::string primary;
  {
    std::lock_guard<std::mutex> lock(stateMutex);
    jobs[job] = cancelled;
    if (cancelledJobs.erase(job))
      cancelled->store(true);
    if (browserKeys.count(id))
      key = browserKeys[id];
    if (firefoxPasswords.count(id))
      primary = firefoxPasswords[id];
  }
  struct Cleanup {
    std::string job;
    Bytes &key;
    std::string &password;
    ~Cleanup() {
      bay::sync::erase(key);
      volatile char *p = password.data();
      for (std::size_t i = 0; i < password.size(); ++i)
        p[i] = 0;
      std::lock_guard<std::mutex> lock(stateMutex);
      jobs.erase(job);
      cancelledJobs.erase(job);
    }
  } cleanup{job, key, primary};
  auto observer = [&](Json event) {
    event["jobId"] = job;
    EventSink sink;
    {
      std::lock_guard<std::mutex> lock(stateMutex);
      sink = eventSink;
    }
    if (sink)
      sink("BayImport", "onImportEvent", event.dump());
  };
  Json result = {{"browserId", id},
                 {"profileId", profileId},
                 {"profile", {{"name", p["name"]}}},
                 {"history", Json::array()},
                 {"historyCount", 0},
                 {"tabs", Json::array()},
                 {"tabGroups", Json::array()},
                 {"credentials", Json::array()},
                 {"spaces", Json::array()},
                 {"favorites", Json::array()},
                 {"failed", Json::array()},
                 {"warnings", Json::array()},
                 {"cookieCount", 0},
                 {"addressCount", 0},
                 {"cardCount", 0}};
  SensitiveImport sensitive;
  for (auto &kind : kinds) {
    checkCancelled(*cancelled);
    if (kind != "history")
      observer({{"type", "progress"},
                {"kind", kind},
                {"phase", "start"},
                {"processed", 0}});
    try {
      if (kind == "bookmarks")
        result["bookmarks"] = browser.firefox
                                  ? firefoxBookmarks(path, *cancelled)
                                  : chromiumBookmarks(path);
      else if (kind == "history") {
        int count = 0;
        result["history"] = history(path, browser.firefox, options, observer,
                                    *cancelled, count);
        result["historyCount"] = count;
      } else if (browser.id == "arc" &&
                 (kind == "spaces" || kind == "pinnedTabs" || kind == "tabs" ||
                  kind == "favorites")) {
        auto sidebar =
            arcSidebar(browser.root.parent_path() / "StorableSidebar.json");
        if (kind == "favorites")
          result["favorites"] =
              sidebar["favorites"].value(profileId, Json::array());
        else {
          Json spaces = Json::array();
          for (auto space : sidebar["spaces"]) {
            if (space["profileId"] != profileId)
              continue;
            if (settings.contains("spaceIds") &&
                settings["spaceIds"].is_array() &&
                std::find(settings["spaceIds"].begin(),
                          settings["spaceIds"].end(),
                          space["id"]) == settings["spaceIds"].end())
              continue;
            if (std::find(kinds.begin(), kinds.end(), "pinnedTabs") ==
                kinds.end())
              space["pinned"] = Json::array();
            if (std::find(kinds.begin(), kinds.end(), "tabs") == kinds.end())
              space["tabs"] = Json::array();
            spaces.push_back(space);
          }
          result["spaces"] = spaces;
          if (kind == "tabs") {
            result["tabs"] = Json::array();
            for (auto &space : spaces)
              for (auto &tab : space["tabs"])
                result["tabs"].push_back(tab);
          }
        }
      } else if (kind == "tabs") {
        auto tabs = browser.firefox ? firefoxTabs(path, *cancelled)
                                    : chromiumTabs(path, *cancelled);
        result["tabs"] = tabs["tabs"];
        result["tabGroups"] = tabs["groups"];
      } else if (kind == "passwords") {
        if (browser.firefox)
          result["credentials"] = firefoxLogins(path, primary, *cancelled);
        else {
          int blocked = 0;
          result["credentials"] =
              chromiumLogins(path, key, *cancelled, blocked);
          if (blocked && result["credentials"].empty())
            result["failed"].push_back(kind);
          if (blocked)
            result["warnings"].push_back(
                {{"kind", kind},
                 {"code", "passwordExportRequired"},
                 {"message",
                  std::to_string(blocked) +
                      " passwords are protected by the source browser. Export "
                      "its password CSV and import that file"}});
        }
      } else if (kind == "autofill" && !browser.firefox) {
        int blocked = 0;
        auto loaded = chromiumAutofill(path, key, *cancelled, blocked);
        sensitive.addresses = std::move(loaded.addresses);
        sensitive.cards = std::move(loaded.cards);
        if (blocked)
          result["warnings"].push_back(
              {{"kind", kind},
               {"code", "appBound"},
               {"message", "Protected payment cards were skipped. Their source "
                           "browser must export them"}});
      } else if (kind == "cookies" && browser.firefox) {
        auto loaded = firefoxCookies(path, *cancelled);
        sensitive.cookies = std::move(loaded.cookies);
      } else
        throw Failure(
            "unsupported",
            kind == "cookies"
                ? "Chromium cookies stay protected by their source browser. "
                  "Sign in again in Bay"
                : "This import kind is unavailable for this Windows browser");
    } catch (const Failure &error) {
      if (error.code == "cancelled")
        throw;
      result["failed"].push_back(kind);
      result["warnings"].push_back(
          {{"kind", kind}, {"code", error.code}, {"message", error.what()}});
    } catch (const std::exception &) {
      result["failed"].push_back(kind);
      result["warnings"].push_back(
          {{"kind", kind},
           {"code", "unreadable"},
           {"message", "The source browser data could not be read"}});
    }
    if (kind != "history")
      observer({{"type", "progress"},
                {"kind", kind},
                {"phase", "end"},
                {"processed", 0}});
  }
  checkCancelled(*cancelled);
  result["cookieCount"] = sensitive.cookies.size();
  result["addressCount"] = sensitive.addresses.size();
  result["cardCount"] = sensitive.cards.size();
  auto token = keep(std::move(sensitive));
  if (!token.empty())
    result["vaultToken"] = token;
  return result;
}
Json chooseFile(const std::string &kind) {
#ifdef _WIN32
  Microsoft::WRL::ComPtr<IFileOpenDialog> dialog;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr,
                              CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog))))
    throw Failure("dialog", "Could not open the file chooser");
  COMDLG_FILTERSPEC filter{kind == "passwordsCSV" ? L"Password CSV"
                                                  : L"Bookmarks HTML",
                           kind == "passwordsCSV" ? L"*.csv" : L"*.html;*.htm"};
  dialog->SetFileTypes(1, &filter);
  dialog->SetOptions(FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST |
                     FOS_FORCEFILESYSTEM);
  auto response = dialog->Show(GetActiveWindow());
  if (response == HRESULT_FROM_WIN32(ERROR_CANCELLED))
    return nullptr;
  if (FAILED(response))
    throw Failure("dialog", "File chooser failed");
  Microsoft::WRL::ComPtr<IShellItem> item;
  dialog->GetResult(&item);
  PWSTR value = nullptr;
  if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &value)))
    throw Failure("dialog", "Selected file has no local path");
  auto path = Path(value).u8string();
  CoTaskMemFree(value);
  return path;
#else
  (void)kind;
  return nullptr;
#endif
}
} // namespace
void SetEventSink(EventSink sink) {
  std::lock_guard<std::mutex> lock(stateMutex);
  eventSink = std::move(sink);
}
void SetImportWriter(ImportWriter writer) {
  std::lock_guard<std::mutex> lock(stateMutex);
  importWriter = std::move(writer);
}
std::string Invoke(const std::string &, const std::string &method,
                   const std::string &argsJson) {
  auto args = Json::parse(argsJson);
  Json result;
  if (method == "listBrowsers") {
    Json sources = Json::array();
    for (auto &browser : browsers()) {
      auto found = profiles(browser);
      if (found.empty())
        continue;
      sources.push_back({{"id", browser.id},
                         {"name", browser.name},
                         {"family", browser.firefox       ? "firefox"
                                    : browser.id == "arc" ? "arc"
                                                          : "chromium"},
                         {"requiresExport", false},
                         {"needsKeychain", !browser.firefox},
                         {"profiles", found}});
    }
    result = sources.dump();
  } else if (method == "importData")
    result = import(args).dump();
  else if (method == "cancelImport") {
    std::lock_guard<std::mutex> lock(stateMutex);
    auto it = jobs.find(args.at(0).get<std::string>());
    if (it != jobs.end())
      it->second->store(true);
    else if (cancelledJobs.size() < 1024)
      cancelledJobs.insert(args.at(0).get<std::string>());
  } else if (method == "unlockBrowser") {
    auto id = args.at(0).get<std::string>();
    bool found = false;
    for (auto &browser : browsers())
      if (browser.id == id) {
        found = true;
        if (browser.firefox) {
          std::lock_guard<std::mutex> lock(stateMutex);
          firefoxPasswords[id] = args.size() > 1 && !args[1].is_null()
                                     ? args[1].get<std::string>()
                                     : "";
        } else {
          auto key = chromiumKey(browser.root);
          std::lock_guard<std::mutex> lock(stateMutex);
          if (browserKeys.count(id))
            bay::sync::erase(browserKeys[id]);
          browserKeys[id] = std::move(key);
        }
        break;
      }
    if (!found)
      throw Failure("notFound", "Browser is unavailable");
  } else if (method == "isBrowserUnlocked") {
    std::lock_guard<std::mutex> lock(stateMutex);
    auto id = args.at(0).get<std::string>();
    result = browserKeys.count(id) != 0 || firefoxPasswords.count(id) != 0;
  } else if (method == "forgetUnlockedKeys") {
    std::lock_guard<std::mutex> lock(stateMutex);
    for (auto &key : browserKeys)
      bay::sync::erase(key.second);
    browserKeys.clear();
    for (auto &password : firefoxPasswords) {
      volatile char *p = password.second.data();
      for (std::size_t i = 0; i < password.second.size(); ++i)
        p[i] = 0;
    }
    firefoxPasswords.clear();
    vault.clear();
  } else if (method == "discardImported") {
    std::lock_guard<std::mutex> lock(stateMutex);
    vault.erase(args.at(0).get<std::string>());
  } else if (method == "writeImported") {
    SensitiveImport data;
    ImportWriter writer;
    {
      std::lock_guard<std::mutex> lock(stateMutex);
      purge();
      auto it = vault.find(args.at(0).get<std::string>());
      if (it == vault.end())
        throw Failure("notFound",
                      "The imported secrets expired. Run the import again");
      data = std::move(it->second.data);
      vault.erase(it);
      writer = importWriter;
    }
    if (!writer)
      throw Failure(
          "unavailable",
          "The browser engine is not ready to accept imported secrets");
    result = writer(args.at(1).get<std::string>(),
                    args.at(2).get<std::vector<std::string>>(), data)
                 .dump();
  } else if (method == "listExtensions") {
    auto found = resolve(args.at(0), args.at(1));
    result = (found.first.firefox
                  ? Json::array()
                  : extensions(
                        fs::u8path(found.second.at("path").get<std::string>())))
                 .dump();
  } else if (method == "importBookmarksHTML")
    result = parseNetscapeBookmarks(
                 readText(fs::u8path(args.at(0).get<std::string>())))
                 .dump();
  else if (method == "importPasswordsCSV")
    result =
        parsePasswordsCSV(readText(fs::u8path(args.at(0).get<std::string>())))
            .dump();
  else if (method == "chooseImportFile") {
    auto kind = args.at(0).get<std::string>();
    if (kind == "safariExport")
      throw Failure("unsupported", "Safari import is available on macOS");
    result = chooseFile(kind);
  } else if (method == "safariHasFullDiskAccess")
    result = false;
  else if (method == "diaAutomationStatus" || method == "requestDiaAutomation")
    result = Json("notInstalled").dump();
  else
    throw Failure("unsupported",
                  "This import method is unavailable on Windows");
  return result.dump();
}
const std::vector<std::string> &MethodNames() {
  static const std::vector<std::string> methods = {
      "listBrowsers",        "importData",         "cancelImport",
      "unlockBrowser",       "isBrowserUnlocked",  "forgetUnlockedKeys",
      "writeImported",       "discardImported",    "listExtensions",
      "importBookmarksHTML", "importPasswordsCSV", "chooseImportFile"};
  return methods;
}
bool RequiresUIThread(const std::string &method) {
  static const std::vector<std::string> methods = {"chooseImportFile"};
  return std::find(methods.begin(), methods.end(), method) != methods.end();
}
std::string InvokeEnvelope(const std::string &method,
                           const std::string &argsJson) {
  try {
    auto &methods = MethodNames();
    if (std::find(methods.begin(), methods.end(), method) == methods.end())
      throw Failure("unsupported",
                    "This native method is unavailable on Windows");
    if (!Json::parse(argsJson).is_array())
      throw Failure("invalid_arguments",
                    "Native method arguments must be a JSON array");
    return Json{{"value", Json::parse(Invoke(kModuleName, method, argsJson))}}
        .dump();
  } catch (const Failure &error) {
    return Json{{"error", {{"code", error.code}, {"message", error.what()}}}}
        .dump();
  } catch (const Json::exception &) {
    return Json{{"error",
                 {{"code", "invalid_arguments"},
                  {"message", "Invalid native method arguments"}}}}
        .dump();
  } catch (const std::exception &error) {
    return Json{
        {"error", {{"code", "native_failure"}, {"message", error.what()}}}}
        .dump();
  }
}
} // namespace bay::importer
