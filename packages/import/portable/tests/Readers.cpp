#include "../ImportCore.h"
#include <fstream>
#include <iostream>
// The fixtures are written with the SQLite bay-import bundles (in
// bay_desktop), so a binary holds one copy: the system winsqlite3 would define
// the same symbols again.
#ifdef _WIN32
#define SQLITE_API
#include <winsqlite/winsqlite3.h>
#else
#include <sqlite3.h>
#endif
using namespace bay::importer;
void require(bool condition, const char *message) {
  if (!condition)
    throw std::runtime_error(message);
}
int main(int argc, char **argv) {
  try {
    require(argc == 3, "expected fixtures and temporary directory");
    Path fixtures(argv[1]), temporary(argv[2]);
    std::filesystem::create_directories(temporary);
    auto csv =
        parsePasswordsCSV(readText(fixtures / "csv/chrome-passwords.csv"));
    require(csv.size() >= 2, "Chrome CSV logins missing");
    auto quoted = parsePasswordsCSV(
        "url,username,password\r\nhttps://example.test,\"a,b\",\"line 1\nline "
        "2 \"\"quoted\"\"\"\r\n");
    require(quoted.size() == 1 && quoted[0]["username"] == "a,b" &&
                quoted[0]["password"] == "line 1\nline 2 \"quoted\"",
            "CSV quoted fields lost data");
    auto bitwarden =
        parsePasswordsCSV(readText(fixtures / "csv/bitwarden.csv"));
    require(!bitwarden.empty(), "Bitwarden CSV logins missing");
    bool refused = false;
    try {
      parsePasswordsCSV(readText(fixtures / "csv/not-passwords.csv"));
    } catch (const Failure &) {
      refused = true;
    }
    require(refused, "non-password CSV accepted");
    auto html = parseNetscapeBookmarks(
        readText(fixtures / "html/chrome-bookmarks.html"));
    require(html["children"][0]["role"] == "toolbar",
            "bookmark toolbar role missing");
    auto tool = html["children"][0]["children"][2]["children"][0];
    require(tool["title"] == "Tool <beta> ✓" &&
                tool["url"] == "https://tool.example/?q=\"x\"&y='1'",
            "bookmark entities lost data");
    auto profile =
        fixtures / "home/Library/Application Support/Google/Chrome/Default";
    require(!chromiumBookmarks(profile)["children"].empty(),
            "Chromium bookmark roots missing");
    std::atomic_bool cancelled{false};
    auto tabs = chromiumTabs(profile, cancelled);
    require(!tabs["tabs"].empty(), "Chromium session tabs missing");
    auto inlineTitle =
        parseNetscapeBookmarks("<DL><DT><A HREF='https://example.test'>one "
                               "<b>two</b> &amp; three</A></DL>");
    require(inlineTitle["children"][0]["title"] == "one two & three",
            "HTML inline markup truncated a bookmark title");
    auto firefoxSource =
        fixtures / "home/Library/Application "
                   "Support/Firefox/Profiles/abcd1234.default-release";
    auto firefox = temporary / "firefox-profile";
    std::filesystem::copy(firefoxSource, firefox,
                          std::filesystem::copy_options::recursive);
    std::error_code ignored;
    std::filesystem::remove(firefox / "places.sqlite-shm", ignored);
    auto originalPlaces = readBytes(firefox / "places.sqlite"),
         originalWAL = readBytes(firefox / "places.sqlite-wal");
    auto firefoxSession = firefoxTabs(firefox, cancelled);
    require(firefoxSession["tabs"].size() == 3,
            "Firefox LZ4 session tabs missing");
    require(firefoxBookmarks(firefox, cancelled)["children"].size() == 3,
            "Firefox bookmark roots missing");
    require(readBytes(firefox / "places.sqlite") == originalPlaces &&
                readBytes(firefox / "places.sqlite-wal") == originalWAL &&
                !std::filesystem::exists(firefox / "places.sqlite-shm"),
            "SQLite snapshot wrote into the source profile");
    auto cookies = firefoxCookies(firefox, cancelled);
    require(cookies.cookies.size() == 6,
            "Firefox cookie partition/expiry filtering differs from Swift");
    bool partitioned = false;
    for (auto &cookie : cookies.cookies)
      if (cookie.value("name", "") == "port")
        partitioned =
            cookie["partitionKey"]["topLevelSite"] == "https://ported.example";
    require(partitioned,
            "Firefox cookie partition site lost its normalization");
    auto arc = arcSidebar(
        fixtures / "home/Library/Application Support/Arc/StorableSidebar.json");
    require(arc["spaces"].size() == 3 &&
                arc["spaces"][0]["profileId"] == "Default",
            "Arc spaces or profile mapping missing");
    require(arc["spaces"][0]["pinned"].size() == 4 &&
                arc["spaces"][0]["tabs"].size() == 2,
            "Arc pinned tree or tabs missing");
    require(arc["spaces"][0]["color"] == "#3366CC" &&
                arc["spaces"][2]["emoji"] == "🚀",
            "Arc theme or numeric emoji missing");
    require(!arc["favorites"]["Default"].empty() &&
                !arc["favorites"]["Profile 1"].empty(),
            "Arc favorites missing");
    auto invalid = temporary / "bad-session";
    std::filesystem::create_directories(invalid);
    {
      std::ofstream file(invalid / "Current Session", std::ios::binary);
      const char data[] = {'S', 'N', 'S', 'S', 5, 0, 0, 0};
      file.write(data, sizeof(data));
    }
    refused = false;
    try {
      chromiumTabs(invalid, cancelled);
    } catch (const Failure &error) {
      refused = error.code == "unsupported";
    }
    require(refused,
            "Encrypted Chromium session did not request a supported export");
    {
      std::ofstream file(invalid / "sessionstore.jsonlz4", std::ios::binary);
      file << "mozLz40";
    }
    refused = false;
    try {
      firefoxTabs(invalid, cancelled);
    } catch (const Failure &error) {
      refused = error.code == "unreadable";
    }
    require(refused, "Truncated Firefox session was accepted");
    auto session = temporary / "firefox-session";
    std::filesystem::create_directories(session);
    {
      std::ofstream file(session / "sessionstore.js");
      file
          << R"({"windows":[{"selected":2,"tabs":[{"hidden":true,"entries":[{"url":"https://hidden.test"}]},{"groupId":"g1","entries":[{"url":"https://visible.test","title":"Visible"}]}],"groups":[{"id":"g1","name":"Work","color":"blue","collapsed":true}]}]})";
    }
    auto selected = firefoxTabs(session, cancelled);
    require(selected["tabs"].size() == 1 &&
                selected["tabs"][0]["active"] == true &&
                selected["tabs"][0]["groupId"] == "g1" &&
                selected["groups"][0]["collapsed"] == true,
            "Firefox hidden tabs changed selection or groups");
    sqlite3 *db = nullptr;
    auto path = temporary / "History";
    require(sqlite3_open(path.string().c_str(), &db) == SQLITE_OK,
            "test database unavailable");
    const char *sql =
        "PRAGMA journal_mode=WAL;CREATE TABLE urls(url TEXT,title "
        "TEXT,visit_count INT,last_visit_time INT,typed_count INT,hidden "
        "INT);INSERT INTO urls VALUES('https://example.test','WAL "
        "row',3,13344473600000000,1,0);INSERT INTO urls "
        "VALUES('https://hidden.test','Hidden',1,13344473600000000,0,1);";
    require(sqlite3_exec(db, sql, nullptr, nullptr, nullptr) == SQLITE_OK,
            "test database setup failed");
    Options options;
    int count = 0;
    auto rows = history(
        temporary, false, options, [](const Json &) {}, cancelled, count);
    require(count == 1 && rows[0]["title"] == "WAL row",
            "SQLite snapshot missed committed WAL data or hidden filtering");
    sqlite3_close(db);
    // Synthetic Windows-format logins verify v10 AES-GCM and app-bound refusal.
    auto loginDirectory = temporary / "windows-logins";
    std::filesystem::create_directories(loginDirectory);
    bay::sync::Bytes key(32, 7), nonce(12, 3), plain{'p', 'a', 's', 's'};
    auto encrypted = bay::sync::aesGcmSeal(key, nonce, plain, {});
    bay::sync::Bytes v10{'v', '1', '0'};
    v10.insert(v10.end(), nonce.begin(), nonce.end());
    v10.insert(v10.end(), encrypted.begin(), encrypted.end());
    auto writeLogin = [&](const Path &path, bool account) {
      sqlite3 *database = nullptr;
      require(sqlite3_open(path.string().c_str(), &database) == SQLITE_OK,
              "Login test database unavailable");
      require(sqlite3_exec(database,
                           "CREATE TABLE logins(origin_url TEXT,signon_realm "
                           "TEXT,username_value TEXT,password_value "
                           "BLOB,blacklisted_by_user INT)",
                           nullptr, nullptr, nullptr) == SQLITE_OK,
              "Login test setup failed");
      auto insert = [&](const char *user, const bay::sync::Bytes &password,
                        int blacklisted = 0) {
        sqlite3_stmt *statement = nullptr;
        require(sqlite3_prepare_v2(database,
                                   "INSERT INTO logins "
                                   "VALUES('https://example.test/"
                                   "login','https://example.test/',?,?,?)",
                                   -1, &statement, nullptr) == SQLITE_OK,
                "Login insert prepare failed");
        sqlite3_bind_text(statement, 1, user, -1, SQLITE_TRANSIENT);
        sqlite3_bind_blob(statement, 2, password.data(),
                          static_cast<int>(password.size()), SQLITE_TRANSIENT);
        sqlite3_bind_int(statement, 3, blacklisted);
        require(sqlite3_step(statement) == SQLITE_DONE, "Login insert failed");
        sqlite3_finalize(statement);
      };
      insert("user", v10);
      if (account)
        insert("account-only", v10);
      else {
        insert("protected", {'v', '2', '0', 1, 2, 3});
        insert("blocked", v10, 1);
      }
      sqlite3_close(database);
    };
    writeLogin(loginDirectory / "Login Data", false);
    writeLogin(loginDirectory / "Login Data For Account", true);
    int blocked = 0;
    auto credentials = chromiumLogins(loginDirectory, key, cancelled, blocked);
    require(credentials.size() == 2 && blocked == 1 &&
                credentials[0]["password"] == "pass",
            "Chromium v10 decrypt, account dedupe or app-bound refusal failed");
    auto wrong = chromiumLogins(loginDirectory, bay::sync::Bytes(32, 8),
                                cancelled, blocked);
    require(wrong.empty() && blocked == 4,
            "Wrong Chromium key returned plaintext");
    cancelled = true;
    refused = false;
    try {
      chromiumTabs(profile, cancelled);
    } catch (const Failure &error) {
      refused = error.code == "cancelled";
    }
    require(refused, "session import ignored cancellation");

    // Zen's spaces, in the shapes Zen 1.22 writes (here the session store's
    // window, which zen-sessions.jsonlz4 shares).
    auto zen = temporary / "zen-profile";
    std::filesystem::create_directories(zen);
    auto zenTab = [](const char *url, const char *space, bool pinned,
                     bool essential, const char *group, bool empty,
                     int context, bool loaded) {
      Json tab = {{"pinned", pinned},         {"zenEssential", essential},
                  {"zenIsEmpty", empty},      {"userContextId", context},
                  {"index", 1},               {"entries", Json::array()}};
      if (loaded)
        tab["entries"].push_back({{"url", url}, {"title", url}});
      else
        tab["userTypedValue"] = url;
      if (space)
        tab["zenWorkspace"] = space;
      if (group)
        tab["groupId"] = group;
      return tab;
    };
    Json zenWindow = {
        {"spaces",
         {{{"uuid", "{home}"}, {"name", "Home"}, {"icon", "\xF0\x9F\x8F\xA0"},
           {"containerTabId", 0},
           {"theme", {{"gradientColors", {{{"c", {58, 96, 115}}}}}}}},
          {{"uuid", "{dev}"}, {"name", "Dev"},
           {"icon", "chrome://browser/skin/zen-icons/selectable/code.svg"},
           {"containerTabId", 0}},
          {{"uuid", "{meet}"}, {"name", "Meetings"}, {"containerTabId", 2}}}},
        {"folders",
         {{{"id", "docs"}, {"name", "Docs"}, {"workspaceId", "{dev}"},
           {"parentId", nullptr}},
          {{"id", "react"}, {"name", "React"}, {"workspaceId", "{dev}"},
           {"parentId", "docs"}}}},
        {"tabs",
         {zenTab("https://github.com/", nullptr, true, true, nullptr, false, 0,
                 true),
          zenTab("https://app.slack.com/", nullptr, true, true, nullptr, false,
                 0, false),
          zenTab("https://work.example/", nullptr, true, true, nullptr, false,
                 2, true),
          zenTab("https://news.ycombinator.com/", "{home}", true, false,
                 nullptr, false, 0, true),
          zenTab("https://developer.mozilla.org/", "{dev}", true, false,
                 nullptr, false, 0, true),
          zenTab("about:blank", nullptr, true, false, "docs", true, 0, true),
          zenTab("https://nodejs.org/", "{dev}", true, false, "docs", false, 0,
                 true),
          zenTab("https://react.dev/", "{dev}", true, false, "react", false, 0,
                 true),
          zenTab("https://linear.app/", "{dev}", true, false, nullptr, false,
                 0, false),
          zenTab("https://example.com/", "{home}", false, false, nullptr,
                 false, 0, true),
          zenTab("about:blank", "{home}", false, false, nullptr, true, 0,
                 true),
          zenTab("https://meet.google.com/", "{meet}", true, false, nullptr,
                 false, 0, true)}}};
    std::ofstream(zen / "sessionstore.js")
        << Json{{"windows", Json::array({zenWindow})}}.dump();
    auto spaces = zenSpaces(zen, "Profiles/abc.Default");
    require(spaces.size() == 3 && spaces[0]["name"] == "Home" &&
                spaces[0]["profileId"] == "Profiles/abc.Default",
            "Zen spaces missing");
    require(spaces[0]["pinned"].size() == 1 &&
                spaces[0]["pinned"][0]["url"] == "https://news.ycombinator.com/" &&
                spaces[0]["tabs"].size() == 1 &&
                spaces[0]["tabs"][0]["url"] == "https://example.com/",
            "Zen space's pins or tabs wrong (or a placeholder kept)");
    auto &devPins = spaces[1]["pinned"];
    require(devPins.size() == 3 && devPins[1]["type"] == "folder" &&
                devPins[1]["title"] == "Docs" &&
                devPins[1]["children"].size() == 2 &&
                devPins[1]["children"][0]["url"] == "https://nodejs.org/" &&
                devPins[1]["children"][1]["title"] == "React" &&
                devPins[2]["url"] == "https://linear.app/",
            "Zen folders, their order or an unloaded pin lost");
    require(spaces[0]["favorites"].size() == 2 &&
                spaces[0]["favorites"][1]["url"] == "https://app.slack.com/" &&
                spaces[2]["favorites"].size() == 1 &&
                spaces[2]["favorites"][0]["url"] == "https://work.example/",
            "Zen essentials not by container");
    require(spaces[0]["emoji"] == "\xF0\x9F\x8F\xA0" &&
                spaces[0]["color"] == "#3A6073" && !spaces[1].contains("emoji"),
            "Zen space icon or colour wrong");
    auto zenOpen = firefoxTabs(zen, std::atomic_bool{false});
    for (auto &tab : zenOpen["tabs"])
      require(tab["url"] != "about:blank", "Zen placeholder imported as a tab");
    std::ofstream(zen / "sessionstore.js")
        << R"({"windows":[{"tabs":[{"entries":[{"url":"https://a.test/"}],"index":1}]}]})";
    require(zenSpaces(zen, "p").empty(), "a Firefox session has Zen spaces");

    std::cout << "CSV, HTML, Chromium/Firefox/Arc/Zen readers, encrypted "
                 "logins, WAL snapshots and "
                 "cancellation passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
