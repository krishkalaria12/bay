#include "ImportCore.h"
#include <algorithm>
#include <cstdio>
#include <map>
#include <set>
namespace bay::importer {
namespace {
std::string string(const Json &value, const char *key,
                   const std::string &fallback = "") {
  return value.is_object() && value.contains(key) && value[key].is_string()
             ? value[key].get<std::string>()
             : fallback;
}
std::string profileId(const Json &value) {
  if (!value.is_object())
    return "";
  if (value.contains("default"))
    return "Default";
  if (!value.contains("custom") || !value["custom"].is_object())
    return "";
  auto custom = value["custom"].value("_0", Json::object());
  return string(custom, "directoryBasename");
}
std::vector<std::pair<Json, Json>> pairs(const Json &value) {
  std::vector<std::pair<Json, Json>> out;
  if (value.is_array())
    for (std::size_t i = 0; i + 1 < value.size(); i += 2)
      out.emplace_back(value[i], value[i + 1]);
  return out;
}
Json tab(const Json &item, bool pinned) {
  auto data = item.value("data", Json::object());
  if (!data.contains("tab") || !data["tab"].is_object())
    return nullptr;
  auto &value = data["tab"];
  auto url = string(value, "savedURL");
  if (url.empty())
    return nullptr;
  Json result = {{"url", url},
                 {"title", string(value, "savedTitle")},
                 {"pinned", pinned},
                 {"active", false},
                 {"windowIndex", 0}};
  auto title = string(item, "title");
  if (!title.empty())
    result["customTitle"] = title;
  if (value.contains("timeLastActiveAt") &&
      value["timeLastActiveAt"].is_number())
    result["lastActive"] =
        (value["timeLastActiveAt"].get<double>() + 978307200) * 1000;
  return result;
}
std::vector<std::string> children(const Json &item) {
  return item.value("childrenIds", std::vector<std::string>{});
}
std::string color(const Json &value) {
  if (!value.is_object() || !value.contains("red") ||
      !value.contains("green") || !value.contains("blue"))
    return "";
  if (!value["red"].is_number() || !value["green"].is_number() ||
      !value["blue"].is_number())
    return "";
  auto channel = [&](const char *key) {
    return static_cast<unsigned>(
        std::clamp(value[key].get<double>(), 0.0, 1.0) * 255 + 0.5);
  };
  char hex[8];
  std::snprintf(hex, sizeof(hex), "#%02X%02X%02X", channel("red"),
                channel("green"), channel("blue"));
  return hex;
}
std::string firstColor(const Json &theme, unsigned depth = 0) {
  if (depth >= 12)
    return "";
  auto direct = color(theme);
  if (!direct.empty())
    return direct;
  if (theme.is_array() || theme.is_object())
    for (auto &value : theme) {
      auto found = firstColor(value, depth + 1);
      if (!found.empty())
        return found;
    }
  return "";
}
std::string midColor(const Json &theme) {
  if (theme.is_object()) {
    auto palette = theme.value("primaryColorPalette", Json::object());
    if (palette.is_object()) {
      auto mid = color(palette.value("midTone", Json{}));
      if (!mid.empty())
        return mid;
    }
  }
  return firstColor(theme);
}
Json gradient(const Json &theme, unsigned depth = 0) {
  if (depth >= 12)
    return Json::array();
  if (theme.is_object() && theme.contains("baseColors") &&
      theme["baseColors"].is_array()) {
    Json out = Json::array();
    for (auto &value : theme["baseColors"]) {
      auto found = firstColor(value);
      if (!found.empty())
        out.push_back(found);
    }
    return out;
  }
  if (theme.is_object() || theme.is_array())
    for (auto &value : theme) {
      auto out = gradient(value, depth + 1);
      if (!out.empty())
        return out;
    }
  return Json::array();
}
} // namespace
Json arcSidebar(const Path &file) {
  auto document = Json::parse(readText(file));
  auto containers = document.value("sidebar", Json::object())
                        .value("containers", Json::array());
  Json result = {{"spaces", Json::array()}, {"favorites", Json::object()}};
  Json box;
  for (auto &candidate : containers)
    if (candidate.is_object() &&
        (candidate.contains("spaces") || candidate.contains("items"))) {
      box = candidate;
      break;
    }
  if (box.is_null())
    return result;
  std::map<std::string, Json> items;
  for (auto &item : box.value("items", Json::array()))
    if (item.is_object() && item.contains("id"))
      items[item["id"].get<std::string>()] = item;
  std::function<Json(const std::string &, std::set<std::string> &, bool, bool,
                     unsigned)>
      walk;
  walk = [&](const std::string &id, std::set<std::string> &seen, bool tree,
             bool pinned, unsigned depth) {
    Json output = Json::array();
    if (depth >= 64 || !items.count(id) || !seen.insert(id).second)
      return output;
    for (auto &child : children(items[id])) {
      if (!items.count(child))
        continue;
      auto &item = items[child];
      auto link = tab(item, pinned);
      if (!link.is_null()) {
        if (!seen.insert(child).second)
          continue;
        if (tree) {
          Json bookmark = {
              {"type", "url"},
              {"title", link.value("customTitle", link.value("title", ""))},
              {"url", link["url"]}};
          if (link.contains("customTitle"))
            bookmark["pageTitle"] = link["title"];
          output.push_back(bookmark);
        } else
          output.push_back(link);
      } else {
        auto nested = walk(child, seen, tree, pinned, depth + 1);
        auto data = item.value("data", Json::object());
        if (tree && data.contains("list")) {
          auto title = string(item, "title", "Folder");
          output.push_back({{"type", "folder"},
                            {"title", title.empty() ? "Folder" : title},
                            {"children", nested}});
        } else
          for (auto &entry : nested)
            output.push_back(entry);
      }
    }
    return output;
  };
  unsigned untitled = 0;
  for (auto &space : box.value("spaces", Json::array())) {
    if (!space.is_object() || !space.contains("id"))
      continue;
    std::map<std::string, std::string> roots;
    for (auto &pair : pairs(space.value("newContainerIDs", Json::array())))
      if (pair.first.is_object() && !pair.first.empty() &&
          pair.second.is_string())
        roots.emplace(pair.first.begin().key(), pair.second.get<std::string>());
    for (auto &pair : pairs(space.value("containerIDs", Json::array())))
      if (pair.first.is_string() && pair.second.is_string())
        roots.emplace(pair.first.get<std::string>(),
                      pair.second.get<std::string>());
    std::set<std::string> seen;
    auto profile = profileId(space.value("profile", Json::object()));
    if (profile.empty())
      profile = "Default";
    auto title = string(space, "title");
    if (title.empty())
      title = "Space " + std::to_string(++untitled);
    Json out = {{"id", space["id"]},
                {"name", title},
                {"profileId", profile},
                {"pinned", roots.count("pinned")
                               ? walk(roots["pinned"], seen, true, true, 0)
                               : Json::array()},
                {"tabs", roots.count("unpinned")
                             ? walk(roots["unpinned"], seen, false, false, 0)
                             : Json::array()}};
    auto info = space.value("customInfo", Json::object()),
         icon = info.value("iconType", Json::object());
    if (icon.contains("emoji_v2") && icon["emoji_v2"].is_string())
      out["emoji"] = icon["emoji_v2"];
    else if (icon.contains("emoji")) {
      if (icon["emoji"].is_string())
        out["emoji"] = icon["emoji"];
      else if (icon["emoji"].is_number_unsigned()) {
        auto cp = icon["emoji"].get<std::uint32_t>();
        if (cp <= 0x10ffff)
          out["emoji"] = utf8(cp);
      }
    }
    if (icon.contains("icon") && icon["icon"].is_string())
      out["icon"] = icon["icon"];
    auto color = midColor(info.value("windowTheme", Json{}));
    if (!color.empty())
      out["color"] = color;
    auto colors = gradient(info.value("windowTheme", Json{}));
    if (!colors.empty())
      out["colors"] = colors;
    result["spaces"].push_back(out);
  }
  for (auto &pair : pairs(box.value("topAppsContainerIDs", Json::array()))) {
    auto profile = profileId(pair.first);
    if (profile.empty() || !pair.second.is_string())
      continue;
    std::set<std::string> seen;
    auto tabs = walk(pair.second.get<std::string>(), seen, false, true, 0);
    if (!tabs.empty())
      result["favorites"][profile] = tabs;
  }
  return result;
}
} // namespace bay::importer
