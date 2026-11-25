#include "ImportCore.h"
#include "bay_import.h"
#include <fstream>
// The readers are bay-import's (packages/rust/bay-import), which macOS shares: each call below hands it a JSON request
// and takes its answer. What stays here is reading files for the callers that need the bytes themselves.
namespace bay::importer {
void checkCancelled(const std::atomic_bool &flag) {
  if (flag.load())
    throw Failure("cancelled", "Import cancelled");
}
Bytes readBytes(const Path &path) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream)
    throw Failure("notFound", "Source file is unavailable");
  stream.seekg(0, std::ios::end);
  auto size = stream.tellg();
  if (size < 0 || size > 256 * 1024 * 1024)
    throw Failure("unreadable", "Source file is too large");
  Bytes out(static_cast<std::size_t>(size));
  stream.seekg(0);
  if (!stream.read(reinterpret_cast<char *>(out.data()), size))
    throw Failure("unreadable", "Could not read source file");
  return out;
}
std::string readText(const Path &path) {
  auto bytes = readBytes(path);
  return std::string(bytes.begin(), bytes.end());
}
namespace {
// What bay_import_read's context carries back to its callbacks.
struct Hooks {
  const Observer *observer;
  const SecretOpener *opener;
};
void hear(void *context, const char *event) {
  // An exception mustn't cross back into Rust; the observer only reports.
  try {
    (*static_cast<const Hooks *>(context)->observer)(Json::parse(event));
  } catch (...) {
  }
}
bool open(void *context, const std::uint8_t *sealed, std::size_t length,
          void *sink, BayImportPut put) {
  std::optional<Bytes> plain;
  struct Wipe {
    std::optional<Bytes> &bytes;
    ~Wipe() {
      if (bytes)
        bay::sync::erase(*bytes);
    }
  } wipe{plain};
  try {
    plain = (*static_cast<const Hooks *>(context)->opener)(
        Bytes(sealed, sealed + length));
  } catch (...) {
    return false;
  }
  if (!plain)
    return false;
  put(sink, plain->data(), plain->size());
  return true;
}
Json read(const Json &request, const std::atomic_bool *cancelled = nullptr,
          const Observer *observer = nullptr,
          const SecretOpener *opener = nullptr) {
  Hooks hooks{observer, opener};
  auto text = request.dump();
  char *answer = bay_import_read(
      text.c_str(), reinterpret_cast<const bool *>(cancelled),
      observer ? hear : nullptr, opener ? open : nullptr, &hooks);
  // A request can hold a primary password: wiped, as the answer is when freed.
  volatile char *bytes = text.data();
  for (std::size_t i = 0; i < text.size(); ++i)
    bytes[i] = 0;
  auto parsed = Json::parse(answer ? answer : "null", nullptr, false);
  bay_import_string_free(answer);
  if (!parsed.is_object())
    throw Failure("unreadable", "The import reader gave no answer");
  if (parsed.contains("error"))
    throw Failure(parsed["error"].value("code", "unreadable"),
                  parsed["error"].value("message", ""));
  return std::move(parsed["value"]);
}
std::string pathText(const Path &path) { return path.u8string(); }
} // namespace
Json parsePasswordsCSV(const std::string &text) {
  return read({{"reader", "passwordsCsv"}, {"text", text}});
}
Json parseNetscapeBookmarks(const std::string &html) {
  return read({{"reader", "netscapeBookmarks"}, {"text", html}});
}
Json chromiumBookmarks(const Path &profile) {
  return read({{"reader", "chromiumBookmarks"}, {"profile", pathText(profile)}});
}
Json firefoxBookmarks(const Path &profile, const std::atomic_bool &cancelled) {
  return read({{"reader", "firefoxBookmarks"}, {"profile", pathText(profile)}},
              &cancelled);
}
Json history(const Path &profile, bool firefox, const Options &options,
             const Observer &observer, const std::atomic_bool &cancelled,
             int &count) {
  count = 0;
  auto answer = read({{"reader", "history"},
                      {"profile", pathText(profile)},
                      {"firefox", firefox},
                      {"limit", options.historyLimit},
                      {"since", options.historySince},
                      {"chunkSize", options.chunkSize},
                      {"stream", options.streamHistory}},
                     &cancelled, &observer);
  count = answer.value("count", 0);
  return answer["entries"];
}
Json chromiumTabs(const Path &profile, const std::atomic_bool &cancelled) {
  return read({{"reader", "chromiumTabs"}, {"profile", pathText(profile)}},
              &cancelled);
}
Json firefoxTabs(const Path &profile, const std::atomic_bool &cancelled) {
  return read({{"reader", "firefoxTabs"}, {"profile", pathText(profile)}},
              &cancelled);
}
Json zenSpaces(const Path &profile, const std::string &profileId) {
  return read({{"reader", "zenSpaces"},
               {"profile", pathText(profile)},
               {"profileId", profileId}});
}
Json arcSidebar(const Path &file) {
  return read({{"reader", "arcSidebar"}, {"file", pathText(file)}});
}
Json firefoxLogins(const Path &profile, const std::string &password,
                   const std::atomic_bool &cancelled) {
  return read({{"reader", "firefoxLogins"},
               {"profile", pathText(profile)},
               {"primaryPassword", password}},
              &cancelled);
}
SensitiveImport firefoxCookies(const Path &profile,
                               const std::atomic_bool &cancelled) {
  auto answer = read(
      {{"reader", "firefoxCookies"}, {"profile", pathText(profile)}},
      &cancelled);
  SensitiveImport out;
  out.cookies = std::move(answer["cookies"]);
  return out;
}
Json readSealed(const std::string &reader, const Path &profile,
                const std::atomic_bool &cancelled, const SecretOpener &open) {
  return read({{"reader", reader}, {"profile", pathText(profile)}},
              &cancelled, nullptr, &open);
}
Json extensions(const Path &profile) {
  return read({{"reader", "extensions"}, {"profile", pathText(profile)}});
}
} // namespace bay::importer
