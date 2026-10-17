#include "SyncVault.h"
#include <algorithm>
#include <chrono>
#include <fstream>
#include <iterator>
#ifdef _WIN32
#include <windows.h>
#endif
namespace bay::sync {
namespace fs = std::filesystem;
namespace {
bool directory(const fs::path &path) {
  std::error_code error;
  auto status = fs::symlink_status(path, error);
  return !error && fs::is_directory(status) && !fs::is_symlink(status);
}
void safeDirectory(const fs::path &path) {
  if (!directory(path))
    throw Failure("folder", "Sync folder is missing or is a symbolic link");
#ifdef _WIN32
  auto attr = GetFileAttributesW(path.c_str());
  // Cloud placeholder directories are reparse points too. Reject name-surrogate
  // points only.
  auto file = CreateFileW(
      path.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file != INVALID_HANDLE_VALUE) {
    FILE_ATTRIBUTE_TAG_INFO info{};
    auto ok = GetFileInformationByHandleEx(file, FileAttributeTagInfo, &info,
                                           sizeof(info));
    CloseHandle(file);
    if (ok && (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
        (info.ReparseTag & 0x20000000))
      throw Failure("folder",
                    "Sync folders cannot redirect to another location");
  } else if (attr == INVALID_FILE_ATTRIBUTES)
    throw Failure("folder", "Sync folder is unavailable");
#endif
}
bool pendingFile(const fs::path &path) {
#ifdef _WIN32
  auto attrs = GetFileAttributesW(path.c_str());
  return attrs != INVALID_FILE_ATTRIBUTES &&
         (attrs & (FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN |
                   FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS));
#else
  (void)path;
  return false;
#endif
}
Bytes readFile(const fs::path &path) {
#ifdef _WIN32
  HANDLE handle =
      CreateFileW(path.c_str(), GENERIC_READ,
                  FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                  nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (handle == INVALID_HANDLE_VALUE)
    throw Failure("pending", "Sync file is locked or unavailable");
  struct Close {
    HANDLE h;
    ~Close() { CloseHandle(h); }
  } close{handle};
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(handle, &size) || size.QuadPart < 0 ||
      size.QuadPart > 128 * 1024 * 1024)
    throw Failure("format", "Sync file is too large");
  Bytes result(static_cast<std::size_t>(size.QuadPart));
  std::size_t offset = 0;
  while (offset < result.size()) {
    DWORD read = 0;
    if (!ReadFile(handle, result.data() + offset,
                  static_cast<DWORD>(result.size() - offset), &read, nullptr) ||
        !read)
      throw Failure("pending", "Sync file is being downloaded or changed");
    offset += read;
  }
  return result;
#else
  std::ifstream stream(path, std::ios::binary);
  if (!stream)
    throw Failure("pending", "Sync file is unavailable");
  stream.seekg(0, std::ios::end);
  auto count = stream.tellg();
  if (count < 0 || count > 128 * 1024 * 1024)
    throw Failure("format", "Sync file is too large");
  stream.seekg(0);
  Bytes out(static_cast<std::size_t>(count));
  if (!stream.read(reinterpret_cast<char *>(out.data()), count))
    throw Failure("pending", "Sync file changed during reading");
  return out;
#endif
}
} // namespace
fs::path Vault::chainPath() const { return folder_ / keys_.chainTag(); }
fs::path Vault::scopePath(const std::string &scope) const {
  return chainPath() / keys_.scopeTag(scope);
}
bool Vault::chainExists() const { return directory(chainPath()); }
void Vault::createChain() const {
  safeDirectory(folder_);
  fs::create_directories(chainPath());
  safeDirectory(chainPath());
}
std::string Vault::write(const std::string &scope, const Bytes &payload) const {
  createChain();
  auto path = scopePath(scope);
  fs::create_directories(path);
  safeDirectory(path);
  auto id = base32(randomBytes(16));
  auto sealed = keys_.seal(payload, keys_.scopeTag(scope), id);
  auto temporary = path / ("." + id + ".tmp");
  auto destination = path / (id + ".nns");
  try {
#ifdef _WIN32
    HANDLE file = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr,
                              CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE)
      throw Failure("write", "Could not stage sync data");
    DWORD written = 0;
    bool ok = WriteFile(file, sealed.data(), static_cast<DWORD>(sealed.size()),
                        &written, nullptr) &&
              written == sealed.size() && FlushFileBuffers(file);
    CloseHandle(file);
    if (!ok || !MoveFileExW(temporary.c_str(), destination.c_str(),
                            MOVEFILE_WRITE_THROUGH))
      throw Failure("write", "Could not commit sync data");
#else
    {
      std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
      stream.write(reinterpret_cast<const char *>(sealed.data()),
                   sealed.size());
      if (!stream)
        throw Failure("write", "Could not write sync data");
    }
    fs::rename(temporary, destination);
#endif
  } catch (...) {
    std::error_code ignored;
    fs::remove(temporary, ignored);
    throw;
  }
  return id;
}
Listing Vault::read(const std::string &scope,
                    const std::set<std::string> &known) const {
  Listing listing;
  auto path = scopePath(scope);
  if (!chainExists() || !directory(path))
    return listing;
  safeDirectory(folder_);
  safeDirectory(chainPath());
  safeDirectory(path);
  std::error_code error;
  std::vector<fs::path> files;
  for (fs::directory_iterator it(path, error), end; !error && it != end;
       it.increment(error))
    files.push_back(it->path());
  if (error)
    throw Failure("folder", "Could not enumerate sync folder");
  std::sort(files.begin(), files.end());
  for (const auto &file : files) {
    if (file.extension() != ".nns" || !isTag(file.stem().u8string()))
      continue;
    auto id = file.stem().u8string();
    auto status = fs::symlink_status(file, error);
    if (error || !fs::is_regular_file(status) || fs::is_symlink(status))
      continue;
    listing.present.push_back(id);
    if (known.count(id))
      continue;
    if (pendingFile(file)) {
      listing.pending.push_back(id);
      continue;
    }
    try {
      listing.files.push_back(
          {id, keys_.open(readFile(file), keys_.scopeTag(scope), id)});
    } catch (const Failure &failure) {
      if (failure.code == "pending") {
        listing.pending.push_back(id);
        continue;
      }
      auto modified = fs::last_write_time(file, error);
      double age =
          error ? 0
                : std::max(0.0, std::chrono::duration<double>(
                                    fs::file_time_type::clock::now() - modified)
                                    .count());
      listing.damaged.push_back({id, age});
    }
  }
  return listing;
}
void Vault::remove(const std::string &scope,
                   const std::vector<std::string> &ids) const {
  auto path = scopePath(scope);
  if (!directory(path))
    return;
  safeDirectory(chainPath());
  safeDirectory(path);
  for (const auto &id : ids) {
    if (!isTag(id))
      throw Failure("format", "Invalid sync file id");
    std::error_code ignored;
    fs::remove(path / (id + ".nns"), ignored);
  }
}
void Vault::deleteChain() const {
  if (chainExists()) {
    safeDirectory(folder_);
    safeDirectory(chainPath());
    fs::remove_all(chainPath());
  }
}
} // namespace bay::sync
