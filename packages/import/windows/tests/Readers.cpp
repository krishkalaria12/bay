#include "../ImportCore.h"
#include <iostream>
#ifdef _WIN32
#include <winsqlite3.h>
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
    cancelled = true;
    refused = false;
    try {
      chromiumTabs(profile, cancelled);
    } catch (const Failure &error) {
      refused = error.code == "cancelled";
    }
    require(refused, "session import ignored cancellation");
    std::cout << "CSV, HTML, Chromium bookmarks/sessions, WAL snapshots and "
                 "cancellation passed\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
