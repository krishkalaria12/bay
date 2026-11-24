#include "ImportCore.h"
#include "SQLite.h"
#include <algorithm>
#include <cctype>
#include <fstream>
#include <iterator>
#include <map>
#include <regex>
#include <set>
#include <sstream>
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
std::string trim(std::string text) {
  auto a = text.find_first_not_of(" \r\n\t");
  if (a == std::string::npos)
    return "";
  return text.substr(a, text.find_last_not_of(" \r\n\t") - a + 1);
}
std::string lower(std::string text) {
  for (auto &c : text)
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return text;
}
Json folder(const std::string &title) {
  return {{"type", "folder"}, {"title", title}, {"children", Json::array()}};
}
Json bookmark(const Json &node, int depth = 0) {
  if (depth > 64 || !node.is_object())
    return nullptr;
  std::string type = node.value("type", "");
  Json out;
  if (type == "url") {
    if (node.value("url", "").empty())
      return nullptr;
    out = {{"type", "url"},
           {"title", node.value("name", "")},
           {"url", node["url"]}};
  } else if (type == "folder") {
    out = folder(node.value("name", ""));
    for (const auto &child : node.value("children", Json::array())) {
      auto result = bookmark(child, depth + 1);
      if (!result.is_null())
        out["children"].push_back(result);
    }
  } else
    return nullptr;
  try {
    auto time = chromiumTime(std::stoll(node.value("date_added", "0")));
    if (time)
      out["dateAdded"] = time;
  } catch (const std::exception &) {
  }
  return out;
}
std::string entities(const std::string &text) {
  std::string out;
  for (std::size_t i = 0; i < text.size(); ++i) {
    if (text[i] != '&') {
      out += text[i];
      continue;
    }
    auto semi = text.find(';', i + 1);
    if (semi == std::string::npos || semi - i > 12) {
      out += '&';
      continue;
    }
    auto name = text.substr(i + 1, semi - i - 1);
    std::string value;
    if (name == "amp")
      value = "&";
    else if (name == "lt")
      value = "<";
    else if (name == "gt")
      value = ">";
    else if (name == "quot")
      value = "\"";
    else if (name == "apos")
      value = "'";
    else if (name == "nbsp")
      value = "\xc2\xa0";
    else if (!name.empty() && name.front() == '#') {
      try {
        auto cp = static_cast<std::uint32_t>(std::stoul(
            name.substr(
                name.size() > 1 && (name[1] == 'x' || name[1] == 'X') ? 2 : 1),
            nullptr,
            name.size() > 1 && (name[1] == 'x' || name[1] == 'X') ? 16 : 10));
        if (cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
          value = utf8(cp);
        }
      } catch (...) {
      }
    }
    if (value.empty())
      out += '&';
    else {
      out += value;
      i = semi;
    }
  }
  return out;
}
} // namespace
Json parsePasswordsCSV(const std::string &input) {
  std::vector<std::vector<std::string>> rows;
  std::vector<std::string> row;
  std::string field;
  bool quoted = false;
  auto endRow = [&] {
    row.push_back(field);
    field.clear();
    if (!(row.size() == 1 && row[0].empty()))
      rows.push_back(row);
    row.clear();
  };
  std::size_t start = input.compare(0, 3, "\xef\xbb\xbf") == 0 ? 3 : 0;
  for (std::size_t i = start; i < input.size(); ++i) {
    char c = input[i];
    if (quoted) {
      if (c == '"') {
        if (i + 1 < input.size() && input[i + 1] == '"') {
          field += '"';
          ++i;
        } else
          quoted = false;
      } else
        field += c;
    } else if (c == '"' && field.empty())
      quoted = true;
    else if (c == ',') {
      row.push_back(field);
      field.clear();
    } else if (c == '\r' || c == '\n') {
      if (c == '\r' && i + 1 < input.size() && input[i + 1] == '\n')
        ++i;
      endRow();
    } else
      field += c;
  }
  if (!field.empty() || !row.empty())
    endRow();
  if (rows.empty())
    throw Failure("unreadable", "The file is empty");
  for (auto &h : rows.front())
    h = lower(trim(h));
  auto find = [&](std::initializer_list<const char *> names) {
    for (auto name : names) {
      auto it = std::find(rows.front().begin(), rows.front().end(), name);
      if (it != rows.front().end())
        return static_cast<int>(it - rows.front().begin());
    }
    return -1;
  };
  int url = find({"url", "login_uri", "website", "web site", "origin",
                  "hostname", "login url"}),
      pass = find({"password", "login_password", "pass"}),
      user = find({"username", "login_username", "login", "user", "email",
                   "user name"});
  if (url < 0 || pass < 0)
    throw Failure("unsupported",
                  "This CSV does not have URL and password columns");
  Json result = Json::array();
  for (std::size_t i = 1; i < rows.size(); ++i) {
    auto get = [&](int n) {
      return n >= 0 && static_cast<std::size_t>(n) < rows[i].size() ? rows[i][n]
                                                                    : "";
    };
    if (get(url).empty() || get(pass).empty())
      continue;
    Json credential = {
        {"url", get(url)}, {"username", get(user)}, {"password", get(pass)}};
    for (auto pair : {std::pair{"title", find({"name", "title"})},
                      {"note", find({"note", "notes", "extra"})},
                      {"realm", find({"httprealm"})},
                      {"otpAuth", find({"otpauth"})}})
      if (!get(pair.second).empty())
        credential[pair.first] = get(pair.second);
    for (auto pair : {std::pair{"created", find({"timecreated"})},
                      {"lastUsed", find({"timelastused"})}})
      if (!get(pair.second).empty())
        try {
          credential[pair.first] = std::stod(get(pair.second));
        } catch (...) {
        }
    result.push_back(credential);
  }
  return result;
}
Json parseNetscapeBookmarks(const std::string &html) {
  std::vector<Json> stack{folder("Bookmarks")};
  Json pending;
  bool sawRoot = false;
  // Tags are scanned separately so quoted > characters do not terminate
  // attributes.
  std::regex tag(R"(<\s*(/?)\s*([a-zA-Z0-9]+)((?:[^>"']|"[^"]*"|'[^']*')*)>)");
  std::regex attr(
      R"ATTR(([a-zA-Z_][a-zA-Z_0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))ATTR");
  auto flush = [&] {
    if (!pending.is_null()) {
      stack.back()["children"].push_back(pending);
      pending = nullptr;
    }
  };
  std::string clean =
      std::regex_replace(html, std::regex(R"(<!--[\s\S]*?-->)"), "");
  auto end = std::sregex_iterator();
  for (auto it = std::sregex_iterator(clean.begin(), clean.end(), tag);
       it != end; ++it) {
    auto match = *it;
    auto name = lower(match[2]);
    bool close = !match[1].str().empty();
    if (name == "dl") {
      if (close) {
        flush();
        if (stack.size() > 1) {
          auto child = stack.back();
          stack.pop_back();
          stack.back()["children"].push_back(child);
        }
      } else if (!pending.is_null()) {
        stack.push_back(pending);
        pending = nullptr;
      } else if (!sawRoot)
        sawRoot = true;
      else
        stack.push_back(folder(""));
    }
    if (close || (name != "a" && name != "h3"))
      continue;
    std::map<std::string, std::string> attrs;
    auto attributes = match[3].str();
    for (auto a =
             std::sregex_iterator(attributes.begin(), attributes.end(), attr);
         a != end; ++a)
      attrs[lower((*a)[1])] = entities((*a)[2].matched   ? (*a)[2].str()
                                       : (*a)[3].matched ? (*a)[3].str()
                                                         : (*a)[4].str());
    auto pos = static_cast<std::size_t>(match.position() + match.length());
    auto tail = clean.substr(pos);
    std::string titleText;
    std::size_t consumed = 0;
    for (auto next = std::sregex_iterator(tail.begin(), tail.end(), tag);
         next != end; ++next) {
      auto token = *next;
      auto tokenStart = static_cast<std::size_t>(token.position());
      titleText += tail.substr(consumed, tokenStart - consumed);
      consumed = tokenStart + static_cast<std::size_t>(token.length());
      auto tagName = lower(token[2]);
      bool closing = !token[1].str().empty();
      if ((closing && tagName == name) ||
          (!closing && (tagName == "a" || tagName == "h3" || tagName == "dl" ||
                        tagName == "dt")))
        break;
      if (std::next(next) == end)
        titleText += tail.substr(consumed);
    }
    if (consumed == 0)
      titleText = tail;
    auto title = trim(entities(titleText));
    Json node;
    if (name == "h3") {
      flush();
      node = folder(title);
      if (lower(attrs["personal_toolbar_folder"]) == "true" ||
          attrs["id"] == "com.apple.FavoritesBar")
        node["role"] = "toolbar";
      else if (lower(attrs["unfiled_bookmarks_folder"]) == "true")
        node["role"] = "other";
      else if (attrs["id"] == "com.apple.ReadingList")
        node["role"] = "readingList";
    } else {
      if (attrs["href"].empty())
        continue;
      flush();
      node = {{"type", "url"},
              {"title", title.empty() ? attrs["href"] : title},
              {"url", attrs["href"]}};
    }
    try {
      auto date = std::stod(attrs["add_date"]);
      if (date > 0)
        node["dateAdded"] = date * 1000;
    } catch (...) {
    }
    if (name == "h3")
      pending = node;
    else
      stack.back()["children"].push_back(node);
  }
  flush();
  while (stack.size() > 1) {
    auto child = stack.back();
    stack.pop_back();
    stack.back()["children"].push_back(child);
  }
  return stack.front();
}
Json chromiumBookmarks(const Path &profile) {
  Json out = folder("Bookmarks");
  bool found = false;
  for (auto file : {"Bookmarks", "AccountBookmarks"}) {
    if (!std::filesystem::exists(profile / file))
      continue;
    found = true;
    auto data = Json::parse(readText(profile / file));
    if (!data.contains("roots"))
      throw Failure("unreadable", "Invalid Chromium bookmarks");
    for (auto pair : {std::pair{"bookmark_bar", "toolbar"},
                      {"other", "other"},
                      {"synced", "mobile"}}) {
      if (!data["roots"].contains(pair.first))
        continue;
      auto node = bookmark(data["roots"][pair.first]);
      if (node.is_null() || node["children"].empty())
        continue;
      node["role"] = pair.second;
      bool merged = false;
      for (auto &existing : out["children"])
        if (existing.value("role", "") == pair.second) {
          for (auto &child : node["children"])
            existing["children"].push_back(child);
          merged = true;
          break;
        }
      if (!merged)
        out["children"].push_back(node);
    }
  }
  if (!found)
    throw Failure("notFound", "No bookmarks in this profile");
  return out;
}
Json firefoxBookmarks(const Path &profile, const std::atomic_bool &cancelled) {
  Snapshot db(profile / "places.sqlite");
  std::map<std::int64_t, std::vector<Json>> children;
  std::int64_t root = 0;
  db.query("SELECT b.id,b.type,b.parent,b.title,p.url,b.dateAdded,b.guid FROM "
           "moz_bookmarks b LEFT JOIN moz_places p ON b.fk=p.id ORDER BY "
           "b.parent,b.position",
           [&](sqlite3_stmt *s) {
             checkCancelled(cancelled);
             Json row = {{"id", sqlite3_column_int64(s, 0)},
                         {"type", sqlite3_column_int(s, 1)},
                         {"title", text(s, 3)},
                         {"url", text(s, 4)},
                         {"dateAdded", sqlite3_column_int64(s, 5) / 1000.0},
                         {"guid", text(s, 6)}};
             if (text(s, 6) == "root________")
               root = sqlite3_column_int64(s, 0);
             else
               children[sqlite3_column_int64(s, 2)].push_back(row);
             return true;
           });
  if (!root)
    throw Failure("unreadable", "Firefox bookmark root is missing");
  std::function<Json(std::int64_t, int)> build = [&](std::int64_t id,
                                                     int depth) {
    Json out = Json::array();
    if (depth >= 64)
      return out;
    for (auto &r : children[id]) {
      checkCancelled(cancelled);
      Json node;
      if (r["type"] == 1) {
        auto url = r["url"].get<std::string>();
        if (url.empty() || url.rfind("place:", 0) == 0)
          continue;
        node = {{"type", "url"}, {"title", r["title"]}, {"url", url}};
      } else if (r["type"] == 2) {
        node = folder(r["title"]);
        node["children"] = build(r["id"], depth + 1);
      } else
        continue;
      node["dateAdded"] = r["dateAdded"];
      out.push_back(node);
    }
    return out;
  };
  Json out = folder("Bookmarks");
  for (auto pair : {std::pair{"toolbar_____", "toolbar"},
                    {"menu________", "menu"},
                    {"unfiled_____", "other"},
                    {"mobile______", "mobile"}})
    for (auto &r : children[root])
      if (r["guid"] == pair.first) {
        auto node =
            folder(pair.second == std::string("toolbar") ? "Bookmarks Toolbar"
                   : pair.second == std::string("menu")  ? "Bookmarks Menu"
                   : pair.second == std::string("other") ? "Other Bookmarks"
                                                         : "Mobile Bookmarks");
        node["children"] = build(r["id"], 0);
        if (!node["children"].empty()) {
          node["role"] = pair.second;
          node["dateAdded"] = r["dateAdded"];
          out["children"].push_back(node);
        }
      }
  return out;
}
Json history(const Path &profile, bool firefox, const Options &options,
             const Observer &observer, const std::atomic_bool &cancelled,
             int &count) {
  Snapshot db(profile / (firefox ? "places.sqlite" : "History"));
  Json all = Json::array(), chunk = Json::array();
  count = 0;
  if (options.historyLimit == 0)
    return all;
  observer({{"type", "progress"},
            {"kind", "history"},
            {"phase", "start"},
            {"processed", 0}});
  db.query(
      firefox
          ? "SELECT url,title,visit_count,last_visit_date,typed FROM "
            "moz_places WHERE hidden=0 AND visit_count>0 AND last_visit_date "
            "IS NOT NULL AND (url LIKE 'http://%' OR url LIKE 'https://%') "
            "ORDER BY last_visit_date DESC"
          : "SELECT url,title,visit_count,last_visit_time,typed_count FROM "
            "urls WHERE hidden=0 AND last_visit_time>0 AND (url LIKE "
            "'http://%' OR url LIKE 'https://%') ORDER BY last_visit_time DESC",
      [&](sqlite3_stmt *s) {
        checkCancelled(cancelled);
        double time = firefox ? sqlite3_column_int64(s, 3) / 1000.0
                              : chromiumTime(sqlite3_column_int64(s, 3));
        if (time < options.historySince)
          return true;
        Json entry = {{"url", text(s, 0)},
                      {"title", text(s, 1)},
                      {"visits", std::max(1, sqlite3_column_int(s, 2))},
                      {"lastVisit", time}};
        if (sqlite3_column_type(s, 4) != SQLITE_NULL)
          entry["typedCount"] = sqlite3_column_int(s, 4);
        ++count;
        if (options.streamHistory)
          chunk.push_back(entry);
        else
          all.push_back(entry);
        if (count % std::max(1, options.chunkSize) == 0) {
          if (options.streamHistory) {
            observer({{"type", "history"}, {"entries", chunk.dump()}});
            chunk = Json::array();
          }
          observer({{"type", "progress"},
                    {"kind", "history"},
                    {"phase", "progress"},
                    {"processed", count}});
        }
        return options.historyLimit < 0 || count < options.historyLimit;
      });
  if (!chunk.empty())
    observer({{"type", "history"}, {"entries", chunk.dump()}});
  observer({{"type", "progress"},
            {"kind", "history"},
            {"phase", "end"},
            {"processed", count},
            {"total", count}});
  return all;
}
Json extensions(const Path &profile) {
  Json output = Json::array();
  std::set<std::string> seen;
  for (auto name : {"Preferences", "Secure Preferences"}) {
    if (!std::filesystem::exists(profile / name))
      continue;
    auto data = Json::parse(readText(profile / name));
    auto settings = data.value("extensions", Json::object())
                        .value("settings", Json::object());
    for (auto it = settings.begin(); it != settings.end(); ++it) {
      auto id = it.key();
      if (id.size() != 32 ||
          id.find_first_not_of("abcdefghijklmnop") != std::string::npos ||
          seen.count(id))
        continue;
      auto entry = it.value();
      auto manifest = entry.value("manifest", Json::object());
      if (entry.value("state", 0) != 1 ||
          !entry.value("from_webstore", false) ||
          manifest.value("name", "").empty())
        continue;
      seen.insert(id);
      output.push_back(
          {{"id", id},
           {"name", manifest["name"]},
           {"webStoreUrl", "https://chromewebstore.google.com/detail/" + id}});
    }
  }
  return output;
}
} // namespace bay::importer
