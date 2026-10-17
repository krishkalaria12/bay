#pragma once
#include "ImportCore.h"
#ifdef _WIN32
#include <winsqlite/winsqlite3.h>
#pragma comment(lib, "winsqlite3.lib")
#else
#include <sqlite3.h>
#endif
#include <chrono>
#include <thread>
namespace bay::importer {
// SQLite's backup API includes committed WAL data and leaves the source profile
// untouched.
class Snapshot {
  sqlite3 *db_ = nullptr;

public:
  explicit Snapshot(const Path &path) {
    sqlite3 *source = nullptr;
    auto text = path.u8string();
    if (sqlite3_open_v2(text.c_str(), &source,
                        SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX,
                        nullptr) != SQLITE_OK) {
      if (source)
        sqlite3_close(source);
      throw Failure("unreadable", "Close the source browser and try again");
    }
    if (sqlite3_open(":memory:", &db_) != SQLITE_OK) {
      sqlite3_close(source);
      if (db_)
        sqlite3_close(db_);
      db_ = nullptr;
      throw Failure("unreadable", "Could not create database snapshot");
    }
    sqlite3_backup *backup = sqlite3_backup_init(db_, "main", source, "main");
    int status = SQLITE_ERROR;
    if (backup) {
      for (int attempt = 0; attempt < 40; ++attempt) {
        status = sqlite3_backup_step(backup, -1);
        if (status != SQLITE_BUSY && status != SQLITE_LOCKED)
          break;
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
      }
      sqlite3_backup_finish(backup);
    }
    sqlite3_close(source);
    if (status != SQLITE_DONE) {
      sqlite3_close(db_);
      db_ = nullptr;
      throw Failure(
          "unreadable",
          "The source database is busy. Close the browser and try again");
    }
  }
  ~Snapshot() {
    if (db_)
      sqlite3_close(db_);
  }
  Snapshot(const Snapshot &) = delete;
  Snapshot &operator=(const Snapshot &) = delete;
  template <class F> void query(const std::string &sql, F callback) const {
    sqlite3_stmt *statement = nullptr;
    if (sqlite3_prepare_v2(db_, sql.c_str(), -1, &statement, nullptr) !=
        SQLITE_OK)
      throw Failure("unreadable", "Source database has an unsupported layout");
    struct Cleanup {
      sqlite3_stmt *s;
      ~Cleanup() { sqlite3_finalize(s); }
    } cleanup{statement};
    int status;
    while ((status = sqlite3_step(statement)) == SQLITE_ROW)
      if (!callback(statement))
        return;
    if (status != SQLITE_DONE)
      throw Failure("unreadable", "Could not read the source database");
  }
  bool table(const std::string &name) const {
    bool found = false;
    query("SELECT name FROM sqlite_master WHERE type='table'",
          [&](sqlite3_stmt *s) {
            auto text = sqlite3_column_text(s, 0);
            if (text && name == reinterpret_cast<const char *>(text))
              found = true;
            return !found;
          });
    return found;
  }
};
inline std::string text(sqlite3_stmt *s, int column) {
  const auto *value = sqlite3_column_text(s, column);
  int size = sqlite3_column_bytes(s, column);
  return value ? std::string(reinterpret_cast<const char *>(value), size) : "";
}
inline Bytes blob(sqlite3_stmt *s, int column) {
  const auto *value =
      static_cast<const std::uint8_t *>(sqlite3_column_blob(s, column));
  int n = sqlite3_column_bytes(s, column);
  return value ? Bytes(value, value + n) : Bytes{};
}
inline int column(sqlite3_stmt *s, const std::string &name) {
  for (int i = 0; i < sqlite3_column_count(s); ++i)
    if (name == sqlite3_column_name(s, i))
      return i;
  return -1;
}
inline std::string text(sqlite3_stmt *s, const std::string &name) {
  int i = column(s, name);
  return i < 0 ? "" : text(s, i);
}
inline std::int64_t integer(sqlite3_stmt *s, const std::string &name) {
  int i = column(s, name);
  return i < 0 ? 0 : sqlite3_column_int64(s, i);
}
inline double chromiumTime(std::int64_t micros) {
  return micros > 0 ? (micros - 11644473600000000LL) / 1000.0 : 0;
}
} // namespace bay::importer
