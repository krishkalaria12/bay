#include "ImportCore.h"
#include "SQLite.h"
#include <algorithm>
#include <iomanip>
#include <map>
#include <set>
#include <sstream>
namespace bay::importer {
namespace {
struct Reader {
  const Bytes &bytes;
  std::size_t offset = 0;
  std::uint64_t integer(unsigned size) {
    if (size > 8 || offset > bytes.size() || size > bytes.size() - offset)
      throw Failure("unreadable", "Truncated session record");
    std::uint64_t out = 0;
    for (unsigned i = 0; i < size; ++i)
      out |= std::uint64_t(bytes[offset++]) << (i * 8);
    return out;
  }
  void skip(std::size_t size) {
    if (offset > bytes.size() || size > bytes.size() - offset)
      throw Failure("unreadable", "Truncated session record");
    offset += size;
  }
  std::int32_t i32() { return static_cast<std::int32_t>(integer(4)); }
  void align() {
    auto pad = (4 - offset % 4) % 4;
    skip(std::min(pad, bytes.size() - offset));
  }
  std::string string(bool wide = false) {
    auto count = i32();
    if (count < 0)
      throw Failure("unreadable", "Invalid session string");
    auto size = static_cast<std::size_t>(count) * (wide ? 2 : 1);
    if (size > bytes.size() - offset)
      throw Failure("unreadable", "Truncated session string");
    std::string out;
    if (!wide) {
      out.assign(bytes.begin() + offset, bytes.begin() + offset + size);
      offset += size;
    } else {
      for (int i = 0; i < count; ++i) {
        auto cp = integer(2);
        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < count) {
          auto low = integer(2);
          ++i;
          cp = low >= 0xdc00 && low <= 0xdfff
                   ? 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00)
                   : 0xfffd;
        } else if (cp >= 0xd800 && cp <= 0xdfff)
          cp = 0xfffd;
        out += utf8(static_cast<std::uint32_t>(cp));
      }
    }
    align();
    return out;
  }
};
std::string groupId(std::uint64_t high, std::uint64_t low) {
  std::ostringstream stream;
  stream << std::uppercase << std::hex << std::setfill('0') << std::setw(16)
         << high << std::setw(16) << low;
  return stream.str();
}
Bytes decompressLz4(const Bytes &input) {
  if (input.size() < 12 ||
      !std::equal(input.begin(), input.begin() + 8, "mozLz40\0"))
    throw Failure("unreadable", "Not a Firefox session");
  Reader r{input, 8};
  auto size = r.integer(4);
  if (size > 64 * 1024 * 1024)
    throw Failure("unreadable", "Firefox session is too large");
  Bytes out;
  out.reserve(static_cast<std::size_t>(size));
  auto extended = [&](std::size_t length) {
    if (length == 15) {
      unsigned next;
      do {
        next = static_cast<unsigned>(r.integer(1));
        length += next;
        if (length > size)
          throw Failure("unreadable", "Invalid LZ4 block");
      } while (next == 255);
    }
    return length;
  };
  while (r.offset < input.size()) {
    auto token = r.integer(1);
    auto literals = extended(static_cast<std::size_t>(token >> 4));
    if (literals > input.size() - r.offset || literals > size - out.size())
      throw Failure("unreadable", "Invalid LZ4 literals");
    out.insert(out.end(), input.begin() + r.offset,
               input.begin() + r.offset + literals);
    r.offset += literals;
    if (r.offset == input.size())
      break;
    auto distance = r.integer(2);
    if (!distance || distance > out.size())
      throw Failure("unreadable", "Invalid LZ4 offset");
    auto count = extended(static_cast<std::size_t>(token & 15)) + 4;
    if (count > size - out.size())
      throw Failure("unreadable", "Invalid LZ4 match");
    for (std::size_t i = 0; i < count; ++i)
      out.push_back(out[out.size() - distance]);
  }
  if (out.size() != size)
    throw Failure("unreadable", "Firefox session size mismatch");
  return out;
}
} // namespace
Json chromiumTabs(const Path &profile, const std::atomic_bool &cancelled) {
  Path latest;
  std::int64_t stamp = -1;
  for (auto dir : {"Sessions", "Sessions_Encrypted"}) {
    std::error_code error;
    for (std::filesystem::directory_iterator it(profile / dir, error), end;
         !error && it != end; it.increment(error)) {
      auto name = it->path().filename().u8string();
      if (name.rfind("Session_", 0) != 0)
        continue;
      try {
        auto time = std::stoll(name.substr(8));
        if (time > stamp) {
          stamp = time;
          latest = it->path();
        }
      } catch (...) {
      }
    }
  }
  if (latest.empty())
    for (auto name : {"Current Session", "Last Session"})
      if (std::filesystem::exists(profile / name)) {
        latest = profile / name;
        break;
      }
  if (latest.empty())
    throw Failure("notFound", "No saved tabs in this profile");
  auto bytes = readBytes(latest);
  Reader reader{bytes};
  if (reader.integer(4) != 0x53534e53)
    throw Failure("unreadable", "Not a Chromium session");
  auto version = reader.integer(4);
  if (version != 1 && version != 3)
    throw Failure("unsupported",
                  "The saved session is encrypted or uses a newer format. "
                  "Export bookmarks for these tabs");
  struct Tab {
    int window = 0, index = 0, current = 0;
    bool pinned = false;
    std::map<int, Json> navigations;
    std::string group;
    double lastActive = 0;
  };
  struct Window {
    int type = -1, selected = 0;
  };
  std::map<int, Tab> tabs;
  std::map<int, Window> windows;
  std::map<std::string, Json> groups;
  while (reader.offset + 2 <= bytes.size()) {
    checkCancelled(cancelled);
    auto size = reader.integer(2);
    if (size < 1 || size > bytes.size() - reader.offset)
      break;
    auto command = reader.integer(1);
    Bytes payload(bytes.begin() + reader.offset,
                  bytes.begin() + reader.offset + size - 1);
    reader.skip(size - 1);
    Reader r{payload};
    try {
      if (command == 0) {
        int window = r.i32(), tab = r.i32();
        tabs[tab].window = window;
      } else if (command == 2) {
        int tab = r.i32();
        tabs[tab].index = r.i32();
      } else if (command == 6) {
        r.skip(4);
        int tab = r.i32(), index = r.i32();
        auto url = r.string(), title = r.string(true);
        tabs[tab].navigations[index] = {{"url", url}, {"title", title}};
      } else if (command == 7) {
        int tab = r.i32();
        tabs[tab].current = r.i32();
      } else if (command == 8) {
        int window = r.i32();
        windows[window].selected = r.i32();
      } else if (command == 9) {
        int window = r.i32();
        windows[window].type = r.i32();
      } else if (command == 12) {
        int tab = r.i32();
        tabs[tab].pinned = r.integer(1) != 0;
      } else if (command == 16)
        tabs.erase(r.i32());
      else if (command == 17)
        windows.erase(r.i32());
      else if (command == 21) {
        int tab = r.i32();
        r.skip(4);
        tabs[tab].lastActive =
            chromiumTime(static_cast<std::int64_t>(r.integer(8)));
      } else if (command == 25) {
        int tab = r.i32();
        r.skip(4);
        auto high = r.integer(8), low = r.integer(8);
        tabs[tab].group = r.integer(1) ? groupId(high, low) : "";
      } else if (command == 27) {
        r.skip(4);
        auto high = r.integer(8), low = r.integer(8);
        auto id = groupId(high, low);
        auto title = r.string(true);
        auto color = r.integer(4);
        static const char *colors[] = {"grey",   "blue",  "red",
                                       "yellow", "green", "pink",
                                       "purple", "cyan",  "orange"};
        bool collapsed = r.offset + 4 <= payload.size() && r.i32() != 0;
        groups[id] = {{"id", id},
                      {"title", title},
                      {"color", colors[color < 9 ? color : 0]},
                      {"collapsed", collapsed}};
      } else if (command == 5) {
        int tab = r.i32(), index = r.i32();
        auto &t = tabs[tab];
        t.navigations.erase(t.navigations.lower_bound(index),
                            t.navigations.end());
      } else if (command == 11 || command == 24) {
        int tab = r.i32(), index = command == 24 ? r.i32() : 0, count = r.i32();
        if (index < 0 || count <= 0)
          continue;
        auto &t = tabs[tab];
        std::map<int, Json> remaining;
        for (auto &nav : t.navigations)
          if (nav.first < index)
            remaining[nav.first] = nav.second;
          else if (static_cast<std::int64_t>(nav.first) >=
                   static_cast<std::int64_t>(index) + count)
            remaining[nav.first - count] = nav.second;
        t.navigations = std::move(remaining);
        if (t.current >= index && static_cast<std::int64_t>(t.current) <
                                      static_cast<std::int64_t>(index) + count)
          t.current = index - 1;
        else if (static_cast<std::int64_t>(t.current) >=
                 static_cast<std::int64_t>(index) + count)
          t.current -= count;
      }
    } catch (const Failure &) { /* A truncated last command is common while the
                                   source browser is running. */
    }
  }
  Json out = {{"tabs", Json::array()}, {"groups", Json::array()}};
  std::set<std::string> used;
  int windowIndex = 0;
  for (auto &window : windows) {
    if (window.second.type != 0)
      continue;
    std::vector<std::pair<int, Tab *>> ordered;
    for (auto &tab : tabs)
      if (tab.second.window == window.first && !tab.second.navigations.empty())
        ordered.push_back({tab.first, &tab.second});
    std::sort(ordered.begin(), ordered.end(), [](const auto &a, const auto &b) {
      return std::pair{a.second->index, a.first} <
             std::pair{b.second->index, b.first};
    });
    int position = 0;
    for (auto &entry : ordered) {
      auto &t = *entry.second;
      auto nav = t.navigations.lower_bound(t.current);
      if (nav == t.navigations.end())
        nav = std::prev(t.navigations.end());
      auto item = nav->second;
      if (item.value("url", "").empty())
        continue;
      item["pinned"] = t.pinned;
      item["windowIndex"] = windowIndex;
      item["active"] = position++ == window.second.selected;
      if (!t.group.empty()) {
        item["groupId"] = t.group;
        used.insert(t.group);
      }
      if (t.lastActive)
        item["lastActive"] = t.lastActive;
      out["tabs"].push_back(item);
    }
    ++windowIndex;
  }
  for (auto &id : used)
    out["groups"].push_back(groups.count(id) ? groups[id]
                                             : Json{{"id", id},
                                                    {"title", ""},
                                                    {"color", "grey"},
                                                    {"collapsed", false}});
  return out;
}
Json firefoxTabs(const Path &profile, const std::atomic_bool &cancelled) {
  Path file;
  std::filesystem::file_time_type newest =
      std::filesystem::file_time_type::min();
  for (auto name :
       {"sessionstore-backups/recovery.jsonlz4", "sessionstore.jsonlz4",
        "sessionstore-backups/previous.jsonlz4", "sessionstore.js"}) {
    auto candidate = profile / name;
    std::error_code error;
    auto modified = std::filesystem::last_write_time(candidate, error);
    if (!error && (file.empty() || modified > newest)) {
      file = candidate;
      newest = modified;
    }
  }
  if (file.empty())
    throw Failure("notFound", "No Firefox session in this profile");
  auto bytes = readBytes(file);
  if (file.extension() == ".jsonlz4")
    bytes = decompressLz4(bytes);
  auto data = Json::parse(bytes);
  Json out = {{"tabs", Json::array()}, {"groups", Json::array()}};
  int windowIndex = 0;
  for (auto &window : data.value("windows", Json::array())) {
    int position = 0;
    for (auto &tab : window.value("tabs", Json::array())) {
      checkCancelled(cancelled);
      if (tab.value("hidden", false)) {
        ++position;
        continue;
      }
      auto entries = tab.value("entries", Json::array());
      if (entries.empty()) {
        ++position;
        continue;
      }
      int index =
          std::clamp(tab.value("index", static_cast<int>(entries.size())) - 1,
                     0, static_cast<int>(entries.size()) - 1);
      auto nav = entries[index];
      auto url = nav.value("url", "");
      if (url.empty()) {
        ++position;
        continue;
      }
      Json item = {{"url", url},
                   {"title", nav.value("title", "")},
                   {"pinned", tab.value("pinned", false)},
                   {"active", position++ == window.value("selected", 1) - 1},
                   {"windowIndex", windowIndex}};
      if (tab.contains("groupId") && tab["groupId"].is_string())
        item["groupId"] = tab["groupId"];
      if (tab.contains("lastAccessed"))
        item["lastActive"] = tab["lastAccessed"];
      out["tabs"].push_back(item);
    }
    for (auto &group : window.value("groups", Json::array())) {
      if (!group.contains("id") || !group["id"].is_string())
        continue;
      out["groups"].push_back({{"id", group["id"]},
                               {"title", group.value("name", "")},
                               {"color", group.value("color", "grey")},
                               {"collapsed", group.value("collapsed", false)}});
    }
    ++windowIndex;
  }
  return out;
}
} // namespace bay::importer
