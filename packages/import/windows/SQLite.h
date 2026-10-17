#pragma once
#include "ImportCore.h"
#ifdef _WIN32
#include <winsqlite3.h>
#pragma comment(lib, "winsqlite3.lib")
#else
#include <sqlite3.h>
#endif
#include <chrono>
#include <map>
#include <thread>
namespace bay::importer {
// Copy the source database and WAL before SQLite opens either file. Even a
// read-only SQLite connection may create -shm in the original profile.
class Snapshot {
  sqlite3 *db_ = nullptr;

public:
  explicit Snapshot(const Path &path) {
    auto temporary =
        std::filesystem::temp_directory_path() /
        std::filesystem::u8path("bay-import-" +
                                bay::sync::base32(bay::sync::randomBytes(16)));
    bay::sync::createPrivateDirectory(temporary);
    struct RemoveCopy {
      Path path;
      ~RemoveCopy() {
        std::error_code ignored;
        std::filesystem::remove_all(path, ignored);
      }
    } remove{temporary};
    auto copy = temporary / "snapshot.sqlite";
    auto stamp = [](const Path &file) {
      std::error_code error;
      auto modified = std::filesystem::last_write_time(file, error);
      auto size = error ? 0 : std::filesystem::file_size(file, error);
      return std::pair{error ? std::filesystem::file_time_type::min()
                             : modified,
                       error ? std::uintmax_t(0) : size};
    };
    bool stable = false;
    for (unsigned attempt = 0; attempt < 3 && !stable; ++attempt) {
      try {
        auto before = stamp(path);
        if (before.first == std::filesystem::file_time_type::min())
          throw Failure("notFound", "Source database is unavailable");
        std::map<std::string, decltype(before)> sidecars;
        for (auto suffix : {"-wal", "-journal"})
          sidecars[suffix] = stamp(Path(path.u8string() + suffix));
        std::filesystem::copy_file(
            path, copy, std::filesystem::copy_options::overwrite_existing);
        std::filesystem::permissions(copy,
                                     std::filesystem::perms::owner_read |
                                         std::filesystem::perms::owner_write,
                                     std::filesystem::perm_options::replace);
        for (auto suffix : {"-wal", "-journal"}) {
          auto original = Path(path.u8string() + suffix),
               destination = Path(copy.u8string() + suffix);
          std::error_code ignored;
          std::filesystem::remove(destination, ignored);
          if (sidecars[suffix].first != std::filesystem::file_time_type::min())
            std::filesystem::copy_file(
                original, destination,
                std::filesystem::copy_options::overwrite_existing);
        }
        stable = before == stamp(path);
        for (auto &sidecar : sidecars)
          stable = stable && sidecar.second ==
                                 stamp(Path(path.u8string() + sidecar.first));
      } catch (const std::filesystem::filesystem_error &) {
        stable = false;
      }
    }
    if (!stable)
      throw Failure("unreadable", "The source database changed while copying. "
                                  "Close the browser and try again");
    sqlite3 *source = nullptr;
    auto text = copy.u8string();
    if (sqlite3_open_v2(text.c_str(), &source,
                        SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOMUTEX,
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
  void writeTo(const Path &path) const {
    sqlite3 *destination = nullptr;
    if (sqlite3_open_v2(path.u8string().c_str(), &destination,
                        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE,
                        nullptr) != SQLITE_OK) {
      if (destination)
        sqlite3_close(destination);
      throw Failure("unreadable", "Could not copy the Firefox key database");
    }
    auto backup = sqlite3_backup_init(destination, "main", db_, "main");
    int status = backup ? sqlite3_backup_step(backup, -1) : SQLITE_ERROR;
    if (backup)
      sqlite3_backup_finish(backup);
    sqlite3_close(destination);
    if (status != SQLITE_DONE)
      throw Failure("unreadable", "Could not copy the Firefox key database");
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
