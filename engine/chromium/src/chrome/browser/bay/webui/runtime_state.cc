// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/runtime_state.h"

#include <cmath>
#include <initializer_list>
#include <set>
#include <string_view>
#include <vector>
#include "base/strings/string_util.h"

namespace bay {
namespace {
constexpr const char* kRecords[] = {"spaces",
                                    "windows",
                                    "pinnedFolders",
                                    "tabLists",
                                    "peeks",
                                    "closedPeeks",
                                    "tabs",
                                    "live",
                                    "groups",
                                    "selection",
                                    "privateCleanedTabs",
                                    "privateSiteMutes",
                                    "splits",
                                    "history",
                                    "historyReady",
                                    "historyFloor",
                                    "bookmarks",
                                    "bookmarksReady",
                                    "settings",
                                    "ui",
                                    "windowUi",
                                    "find"};
constexpr const char* kLists[] = {
    "spaceOrder",    "folderMoveUndo", "orphanedProfileData", "windowOrder",
    "closedWindows", "closedTabs",     "cleanedTabs",         "closedGroups",
    "deletedGroups", "downloads",      "bookmarkUndo"};
bool PrivateSpace(std::string_view id) {
  return base::StartsWith(id, "incognito:");
}
const std::string* Text(const base::DictValue& value, const char* key) {
  return value.FindString(key);
}
bool HasPrivateData(const base::Value& value) {
  if (value.is_dict()) {
    if (value.GetDict().FindBool("incognito").value_or(false))
      return true;
    for (const auto [key, item] : value.GetDict()) {
      if ((key == "spaceId" || key == "profileId" || key == "profile") &&
          item.is_string() && PrivateSpace(item.GetString()))
        return true;
      if (HasPrivateData(item))
        return true;
    }
  } else if (value.is_list()) {
    for (const auto& item : value.GetList())
      if (HasPrivateData(item))
        return true;
  }
  return false;
}
void FilterRecord(base::DictValue& state,
                  const char* name,
                  const std::set<std::string>& ids) {
  auto* map = state.FindDict(name);
  std::vector<std::string> remove;
  for (const auto [id, value] : *map)
    if (!ids.contains(id))
      remove.emplace_back(id);
  for (const auto& id : remove)
    map->Remove(id);
}
void FilterList(base::ListValue& list, const std::set<std::string>& ids) {
  list.EraseIf([&](const base::Value& value) {
    return !value.is_string() || !ids.contains(value.GetString());
  });
}
bool ValidSpace(const base::DictValue& state, std::string_view space) {
  if (!PrivateSpace(space))
    return state.FindDict("spaces")->FindDict(space) != nullptr;
  const auto* window = state.FindDict("windows")->FindDict(space.substr(10));
  return window && window->FindBool("incognito").value_or(false) &&
         window->FindString("spaceId") &&
         *window->FindString("spaceId") == space;
}
std::string TabListKey(const base::DictValue& state,
                       const base::DictValue& tab) {
  const auto* owner = tab.FindString("windowId");
  const auto* window =
      owner ? state.FindDict("windows")->FindDict(*owner) : nullptr;
  const auto* kind = window ? window->FindString("kind") : nullptr;
  return kind && *kind == "small" ? *owner : *tab.FindString("spaceId");
}
bool StoredTab(const base::DictValue& state, const base::DictValue& tab) {
  const auto* id = tab.FindString("id");
  const auto* lists = state.FindDict("tabLists");
  if (!id || !tab.FindString("spaceId") || !lists)
    return false;
  const auto* list = lists->FindList(TabListKey(state, tab));
  return list && list->contains(*id);
}
bool CommandFields(const base::DictValue& command,
                   std::initializer_list<std::string_view> required,
                   std::initializer_list<std::string_view> optional = {}) {
  for (auto name : required)
    if (!command.contains(name))
      return false;
  for (const auto [name, value] : command) {
    bool allowed = false;
    for (auto field : required)
      allowed |= name == field;
    for (auto field : optional)
      allowed |= name == field;
    if (!allowed)
      return false;
  }
  return true;
}
bool CommandText(const base::DictValue& command,
                 std::string_view field,
                 size_t maximum,
                 bool allow_empty = false) {
  const auto* text = command.FindString(field);
  return text && text->size() <= maximum &&
         (allow_empty ||
          !base::TrimWhitespaceASCII(*text, base::TRIM_ALL).empty());
}
// A bookmark tree to add: pages and folders, bounded in depth and count.
bool BookmarkDrafts(const base::ListValue& drafts, int depth, size_t& count) {
  if (depth > 16)
    return false;
  for (const auto& draft : drafts) {
    if (!draft.is_dict() || ++count > 10000)
      return false;
    const auto& d = draft.GetDict();
    const auto* children = d.FindList("children");
    if (!CommandFields(d, {"title"}, {"url", "addedAt", "children"}) ||
        !CommandText(d, "title", 16 * 1024, true) ||
        (d.contains("url") && (d.contains("children") ||
                               !CommandText(d, "url", 1024 * 1024, true))) ||
        (d.contains("addedAt") && !d.FindDouble("addedAt")) ||
        (d.contains("children") &&
         (!children || !BookmarkDrafts(*children, depth + 1, count))))
      return false;
  }
  return true;
}
}  // namespace

std::optional<double> RuntimeInteger(const base::DictValue& value,
                                     const char* key) {
  const auto number = value.FindDouble(key);
  if (!number || !std::isfinite(*number) || *number < 0 ||
      *number > 9007199254740991.0 || std::floor(*number) != *number)
    return std::nullopt;
  return number;
}
RuntimeRequestStatus ValidateRuntimeRequest(const base::DictValue& request,
                                            const std::string& epoch,
                                            double last_request_id) {
  const auto id = RuntimeInteger(request, "requestId");
  const auto* incoming_epoch = request.FindString("epoch");
  if (request.size() != 4 || !id || *id < 1 || !request.FindDict("command") ||
      !request.FindString("clientId") || !incoming_epoch)
    return RuntimeRequestStatus::kInvalid;
  if (*incoming_epoch != epoch)
    return RuntimeRequestStatus::kStaleEpoch;
  return *id <= last_request_id ? RuntimeRequestStatus::kExpired
                                : RuntimeRequestStatus::kAccepted;
}
bool IsRuntimeCommit(const base::DictValue& commit,
                     const std::string& epoch,
                     double expected_revision) {
  const auto revision = RuntimeInteger(commit, "revision");
  const auto* incoming_epoch = commit.FindString("epoch");
  const auto* state = commit.FindDict("state");
  return commit.size() == 3 && incoming_epoch && *incoming_epoch == epoch &&
         revision && *revision == expected_revision && state &&
         IsRuntimeState(*state);
}
RuntimeResultKind RuntimeCommandResultKind(const base::DictValue& command) {
  const auto* method = command.FindString("method");
  if (!method)
    return RuntimeResultKind::kNone;
  // Keep in sync with browserCommandResultKind in runtime/userCommands.ts.
  for (const char* name :
       {"newTab", "createWindow", "addCustomEngine", "createGroup", "groupTabs",
        "duplicateGroup", "newTabInGroup", "newPinnedFolder", "createSplit",
        "createSpace", "addBookmark", "addBookmarkFolder"})
    if (*method == name)
      return RuntimeResultKind::kRequiredId;
  for (const char* name : {"duplicateTab", "moveTabsToWindow", "restoreCleaned",
                           "openSplitPane", "openPeek", "removeBookmarks"})
    if (*method == name)
      return RuntimeResultKind::kOptionalId;
  return RuntimeResultKind::kNone;
}
bool IsRuntimeReply(const base::DictValue& reply,
                    const std::string& epoch,
                    double minimum_revision,
                    double accepted_revision,
                    RuntimeResultKind result_kind) {
  const auto* incoming_epoch = reply.FindString("epoch");
  if (!incoming_epoch || *incoming_epoch != epoch)
    return false;
  if (const auto* error = reply.FindDict("error"))
    return reply.size() == 2 && error->size() == 2 &&
           error->FindString("code") && error->FindString("message");
  const auto revision = RuntimeInteger(reply, "revision");
  const auto* value = reply.Find("value");
  return reply.size() == 3 && revision && *revision >= minimum_revision &&
         *revision <= accepted_revision && value &&
         ((value->is_none() && result_kind != RuntimeResultKind::kRequiredId) ||
          (result_kind != RuntimeResultKind::kNone && value->is_string() &&
           value->GetString().size() <= 1024));
}

bool IsRuntimeState(const base::DictValue& state) {
  if (state.size() != std::size(kRecords) + std::size(kLists))
    return false;
  for (const auto* key : kRecords)
    if (!state.FindDict(key))
      return false;
  for (const auto* key : kLists)
    if (!state.FindList(key))
      return false;
  for (const auto [id, value] : *state.FindDict("spaces")) {
    if (!value.is_dict() || !Text(value.GetDict(), "id") ||
        *Text(value.GetDict(), "id") != id || PrivateSpace(id) ||
        HasPrivateData(value))
      return false;
  }
  for (const auto [id, value] : *state.FindDict("windows")) {
    if (!value.is_dict())
      return false;
    const auto& window = value.GetDict();
    const auto* name = Text(window, "id");
    const auto* space = Text(window, "spaceId");
    const auto incognito = window.FindBool("incognito");
    if (!name || *name != id || !space || !incognito.has_value() ||
        !window.FindDict("activeTabIds") ||
        *incognito != PrivateSpace(*space) ||
        (*incognito ? *space != "incognito:" + std::string(id)
                    : !ValidSpace(state, *space)))
      return false;
  }
  for (const auto [id, value] : *state.FindDict("tabs")) {
    if (!value.is_dict())
      return false;
    const auto& tab = value.GetDict();
    const auto* name = Text(tab, "id");
    const auto* owner = Text(tab, "windowId");
    const auto* space = Text(tab, "spaceId");
    const auto* window =
        owner ? state.FindDict("windows")->FindDict(*owner) : nullptr;
    if (!name || *name != id || !owner || !space ||
        (!owner->empty() && !window) || !ValidSpace(state, *space))
      return false;
    if (PrivateSpace(*space)) {
      if (!window || !window->FindBool("incognito").value_or(false) ||
          *space != *window->FindString("spaceId"))
        return false;
    } else if (window && window->FindBool("incognito").value_or(false)) {
      return false;
    }
  }
  for (const auto [key, value] : *state.FindDict("tabLists")) {
    if (!value.is_list())
      return false;
    for (const auto& id : value.GetList()) {
      const auto* tab = id.is_string()
                            ? state.FindDict("tabs")->FindDict(id.GetString())
                            : nullptr;
      if (!tab || TabListKey(state, *tab) != key)
        return false;
    }
  }
  for (const auto* key : {"groups", "pinnedFolders"}) {
    for (const auto [id, value] : *state.FindDict(key)) {
      if (!value.is_dict())
        return false;
      const auto& item = value.GetDict();
      const auto* space = item.FindString("spaceId");
      if (!space || !ValidSpace(state, *space))
        return false;
      if (std::string_view(key) == "groups") {
        const auto* members = item.FindList("tabIds");
        if (!members)
          return false;
        for (const auto& member : *members) {
          const auto* tab =
              member.is_string()
                  ? state.FindDict("tabs")->FindDict(member.GetString())
                  : nullptr;
          if (!tab || *tab->FindString("spaceId") != *space)
            return false;
        }
      }
    }
  }
  for (const auto [id, value] : *state.FindDict("splits")) {
    const auto* members =
        value.is_dict() ? value.GetDict().FindList("tabIds") : nullptr;
    if (!members || members->empty())
      return false;
    const std::string* space = nullptr;
    for (const auto& member : *members) {
      const auto* tab =
          member.is_string()
              ? state.FindDict("tabs")->FindDict(member.GetString())
              : nullptr;
      if (!tab || (space && *tab->FindString("spaceId") != *space))
        return false;
      space = tab->FindString("spaceId");
    }
  }
  const auto* ui = state.FindDict("ui");
  const auto* focused = ui->Find("focusedWindowId");
  return (ui->size() == 3 ||
          (ui->size() == 4 && ui->FindDict("previewLooks"))) &&
         ui->FindBool("appDark").has_value() && focused &&
         (focused->is_none() || focused->is_string()) &&
         ui->FindList("focusOrder") &&
         state.FindDict("bookmarks")->FindDict("nodes") &&
         state.FindDict("bookmarks")->FindDict("roots");
}

std::optional<base::DictValue> ProjectRuntimeState(
    const base::DictValue& state,
    const std::string& window_id) {
  if (!IsRuntimeState(state))
    return std::nullopt;
  const auto* own = state.FindDict("windows")->FindDict(window_id);
  if (!own)
    return std::nullopt;
  const bool is_private = own->FindBool("incognito").value();
  const std::string own_space = *own->FindString("spaceId");
  std::set<std::string> windows, tabs, private_windows;
  for (const auto [id, value] : *state.FindDict("windows")) {
    if (!value.GetDict().FindBool("incognito").value() || id == window_id)
      windows.emplace(id);
    if (is_private && id == window_id)
      private_windows.emplace(id);
  }
  for (const auto [id, value] : *state.FindDict("tabs")) {
    const auto& tab = value.GetDict();
    const auto& space = *tab.FindString("spaceId");
    if (!PrivateSpace(space) || (is_private && space == own_space))
      tabs.emplace(id);
  }
  auto result = state.Clone();
  for (const auto* key : {"windows", "windowUi", "peeks", "closedPeeks"})
    FilterRecord(result, key, windows);
  for (const auto* key : {"tabs", "live", "find"})
    FilterRecord(result, key, tabs);
  for (const auto* key : {"privateCleanedTabs", "privateSiteMutes"})
    FilterRecord(result, key, private_windows);
  const auto visible_space = [&](std::string_view space) {
    return !PrivateSpace(space) || (is_private && space == own_space);
  };
  for (const auto* key : {"groups", "pinnedFolders"}) {
    std::set<std::string> allowed;
    for (const auto [id, value] : *result.FindDict(key))
      if (visible_space(*value.GetDict().FindString("spaceId")))
        allowed.emplace(id);
    FilterRecord(result, key, allowed);
  }
  std::set<std::string> splits;
  for (const auto [id, value] : *result.FindDict("splits")) {
    bool visible = true;
    for (const auto& member : *value.GetDict().FindList("tabIds"))
      visible &= tabs.contains(member.GetString());
    if (visible)
      splits.emplace(id);
  }
  FilterRecord(result, "splits", splits);
  std::set<std::string> list_keys;
  for (const auto [id, value] : *result.FindDict("spaces"))
    list_keys.emplace(id);
  for (const auto& id : windows) {
    const auto* window = result.FindDict("windows")->FindDict(id);
    const auto* kind = window->FindString("kind");
    if (kind && *kind == "small")
      list_keys.emplace(id);
  }
  if (is_private)
    list_keys.emplace(own_space);
  FilterRecord(result, "tabLists", list_keys);
  for (const auto [id, value] : *result.FindDict("tabLists"))
    FilterList(*result.FindDict("tabLists")->FindList(id), tabs);
  FilterRecord(result, "selection", windows);
  for (const auto [id, value] : *result.FindDict("selection"))
    if (auto* list = result.FindDict("selection")->FindList(id))
      FilterList(*list, tabs);
  for (const auto [id, value] : *result.FindDict("windows")) {
    auto* window = result.FindDict("windows")->FindDict(id);
    auto* active = window->FindDict("activeTabIds");
    std::vector<std::string> remove;
    for (const auto [profile, tab] : *active)
      if (!visible_space(profile) || !tab.is_string() ||
          !tabs.contains(tab.GetString()))
        remove.emplace_back(profile);
    for (const auto& profile : remove)
      active->Remove(profile);
  }
  FilterList(*result.FindList("windowOrder"), windows);
  auto* ui = result.FindDict("ui");
  if (ui->FindDict("previewLooks"))
    FilterRecord(*ui, "previewLooks", windows);
  FilterList(*ui->FindList("focusOrder"), windows);
  if (const auto* focus = ui->FindString("focusedWindowId");
      !focus || !windows.contains(*focus))
    ui->Set("focusedWindowId", base::Value());
  // Closed/private data must not reach another window through ancillary slices.
  // Private records have no persistent history/bookmark/profile namespace.
  for (const auto* key : {"spaces", "history", "historyReady", "historyFloor",
                          "bookmarksReady"}) {
    std::vector<std::string> remove;
    for (const auto [id, value] : *result.FindDict(key))
      if (PrivateSpace(id) || HasPrivateData(value))
        remove.emplace_back(id);
    for (const auto& id : remove)
      result.FindDict(key)->Remove(id);
  }
  for (const auto* key : {"spaceOrder", "orphanedProfileData"})
    result.FindList(key)->EraseIf([](const base::Value& value) {
      return !value.is_string() || PrivateSpace(value.GetString());
    });
  // Undo keeps page URLs and group snapshots as well as globally collected
  // folder IDs. Scope every reference, even in a regular space's move.
  std::set<std::string> folders;
  for (const auto [id, value] : *result.FindDict("pinnedFolders"))
    folders.emplace(id);
  result.FindList("folderMoveUndo")->EraseIf([&](const base::Value& value) {
    const auto* space =
        value.is_dict() ? value.GetDict().FindString("spaceId") : nullptr;
    return !space || !visible_space(*space);
  });
  for (auto& value : *result.FindList("folderMoveUndo")) {
    auto& move = value.GetDict();
    for (const auto* key : {"id", "parentId", "beforeId"}) {
      if (const auto* id = move.FindString(key);
          id && !folders.contains(*id) && !tabs.contains(*id))
        move.Remove(key);
    }
    if (auto* ids = move.FindList("tabIds"))
      FilterList(*ids, tabs);
    if (auto* ids = move.FindList("folderIds"))
      FilterList(*ids, folders);
    if (auto* snapshots = move.FindDict("tabs")) {
      std::vector<std::string> remove;
      for (const auto [id, snapshot] : *snapshots)
        if (!tabs.contains(id))
          remove.emplace_back(id);
      for (const auto& id : remove)
        snapshots->Remove(id);
      for (const auto [id, snapshot] : *snapshots) {
        auto* tab = snapshots->FindDict(id);
        if (const auto* folder = tab ? tab->FindString("folderId") : nullptr;
            folder && !folders.contains(*folder))
          tab->Remove("folderId");
      }
    }
    if (auto* groups = move.FindList("groups")) {
      groups->EraseIf([&](const base::Value& snapshot) {
        const auto* before = snapshot.is_dict()
                                 ? snapshot.GetDict().FindDict("before")
                                 : nullptr;
        const auto* space = before ? before->FindString("spaceId") : nullptr;
        return !space || !visible_space(*space);
      });
      for (auto& snapshot : *groups) {
        auto& group = snapshot.GetDict();
        if (auto* ids = group.FindDict("before")->FindList("tabIds"))
          FilterList(*ids, tabs);
        if (auto* ids = group.FindList("removed"))
          FilterList(*ids, tabs);
      }
    }
  }
  // A private bookmark root must not leave its detached nodes behind. Walk
  // regular roots plus this window's own private roots, preserving shared
  // nodes.
  auto* bookmarks = result.FindDict("bookmarks");
  auto* roots = bookmarks->FindDict("roots");
  auto* nodes = bookmarks->FindDict("nodes");
  std::vector<std::string> private_roots;
  std::vector<std::string> visit;
  for (const auto [profile, root] : *roots) {
    if ((PrivateSpace(profile) && (!is_private || profile != own_space)) ||
        !root.is_dict()) {
      private_roots.emplace_back(profile);
      continue;
    }
    for (const auto [kind, id] : root.GetDict())
      if (id.is_string())
        visit.push_back(id.GetString());
  }
  for (const auto& id : private_roots)
    roots->Remove(id);
  std::set<std::string> reachable;
  while (!visit.empty()) {
    std::string id = std::move(visit.back());
    visit.pop_back();
    if (!reachable.insert(id).second)
      continue;
    const auto* node = nodes->FindDict(id);
    if (const auto* children = node ? node->FindList("children") : nullptr)
      for (const auto& child : *children)
        if (child.is_string())
          visit.push_back(child.GetString());
  }
  std::vector<std::string> orphaned_nodes;
  for (const auto [id, node] : *nodes)
    if (!reachable.contains(id))
      orphaned_nodes.emplace_back(id);
  for (const auto& id : orphaned_nodes)
    nodes->Remove(id);
  for (const auto* key : {"closedWindows", "closedTabs", "cleanedTabs",
                          "closedGroups", "deletedGroups"})
    result.FindList(key)->EraseIf(
        [](const base::Value& value) { return HasPrivateData(value); });
  // Undo entries hold removed pages: only regular spaces ever have one.
  result.FindList("bookmarkUndo")->EraseIf([](const base::Value& value) {
    const auto* space =
        value.is_dict() ? value.GetDict().FindString("spaceId") : nullptr;
    return !space || PrivateSpace(*space) || HasPrivateData(value);
  });
  result.FindList("downloads")->EraseIf([&](const base::Value& value) {
    if (!value.is_dict())
      return true;
    const auto* profile = value.GetDict().FindString("profile");
    if ((value.GetDict().contains("profile") && !profile) ||
        value.GetDict().FindBool("incognito").value_or(false))
      return true;
    if (is_private)
      return !profile || *profile != own_space;
    return profile && PrivateSpace(*profile);
  });
  return result;
}

bool CanDispatchRuntimeCommand(const base::DictValue& state,
                               const std::string& window_id,
                               const base::DictValue& command) {
  const auto* windows = state.FindDict("windows");
  const auto* own_window = windows ? windows->FindDict(window_id) : nullptr;
  const auto* tabs = state.FindDict("tabs");
  if (!own_window || !tabs)
    return false;
  const auto* method = command.FindString("method");
  if (!method)
    return false;
  const bool is_private = own_window->FindBool("incognito").value_or(false);
  const auto tab_owned = [&](const std::string& id) -> const base::DictValue* {
    const auto* tab = tabs->FindDict(id);
    const auto* owner = tab ? tab->FindString("windowId") : nullptr;
    return owner && *owner == window_id && StoredTab(state, *tab) ? tab
                                                                  : nullptr;
  };
  const auto own_tab = [&](std::string_view field) -> const base::DictValue* {
    const auto* id = command.FindString(field);
    return id ? tab_owned(*id) : nullptr;
  };
  const auto own_target = [&] {
    const auto* id = command.FindString("windowId");
    return id && *id == window_id;
  };
  const auto visible_window = [&](const std::string& id) {
    const auto* window = windows->FindDict(id);
    return window &&
           (is_private ? id == window_id
                       : !window->FindBool("incognito").value_or(false));
  };
  const auto public_space = [&](const base::DictValue& input,
                                std::string_view field) {
    const auto* id = input.FindString(field);
    return id && !PrivateSpace(*id) && state.FindDict("spaces")->FindDict(*id);
  };
  const auto owned_tabs = [&](const base::DictValue& input) {
    const auto* ids = input.FindList("tabIds");
    if (!ids || ids->size() > 10000)
      return false;
    std::set<std::string> seen;
    for (const auto& id : *ids)
      if (!id.is_string() || !seen.insert(id.GetString()).second ||
          !tab_owned(id.GetString()))
        return false;
    return true;
  };
  const auto index = [&](const char* field, double minimum = 0) {
    const auto value = command.FindDouble(field);
    return value && std::isfinite(*value) && std::floor(*value) == *value &&
           *value >= minimum && *value <= 1000000;
  };
  const auto* kind = own_window->FindString("kind");
  const bool harbor = kind && *kind == "small";
  constexpr size_t kMaximumInput = 1024 * 1024;
  // Organize commands act on a space's shared list. A public main window may
  // name public tabs that another main window shows; a private window or a
  // Little Bay only names its own.
  const auto visible_tab = [&](const std::string& id) {
    const auto* tab = tabs->FindDict(id);
    if (!tab || !StoredTab(state, *tab))
      return false;
    const auto* owner = tab->FindString("windowId");
    if (is_private || harbor)
      return owner && *owner == window_id;
    if (!owner || PrivateSpace(*tab->FindString("spaceId")))
      return false;
    if (owner->empty())
      return true;
    const auto* window = windows->FindDict(*owner);
    const auto* owner_kind = window ? window->FindString("kind") : nullptr;
    return window && !window->FindBool("incognito").value_or(false) &&
           !(owner_kind && *owner_kind == "small");
  };
  const auto visible_field = [&](const base::DictValue& input,
                                 std::string_view field) {
    const auto* id = input.FindString(field);
    return id && visible_tab(*id);
  };
  const auto visible_tabs = [&](const base::DictValue& input,
                                size_t minimum = 0, size_t maximum = 10000) {
    const auto* ids = input.FindList("tabIds");
    if (!ids || ids->size() < minimum || ids->size() > maximum)
      return false;
    std::set<std::string> seen;
    for (const auto& id : *ids)
      if (!id.is_string() || !seen.insert(id.GetString()).second ||
          !visible_tab(id.GetString()))
        return false;
    return true;
  };
  const auto visible_group = [&](const base::DictValue& input,
                                 std::string_view field) {
    const auto* id = input.FindString(field);
    const auto* group = id ? state.FindDict("groups")->FindDict(*id) : nullptr;
    const auto* space = group ? group->FindString("spaceId") : nullptr;
    if (!space || harbor)
      return false;
    return is_private ? *space == *own_window->FindString("spaceId")
                      : public_space(*group, "spaceId");
  };
  const auto visible_folder = [&](const base::DictValue& input,
                                  std::string_view field) {
    const auto* id = input.FindString(field);
    const auto* folder =
        id ? state.FindDict("pinnedFolders")->FindDict(*id) : nullptr;
    return folder && !is_private && !harbor && public_space(*folder, "spaceId");
  };
  const auto visible_split = [&] {
    const auto* id = command.FindString("splitId");
    const auto* split = id ? state.FindDict("splits")->FindDict(*id) : nullptr;
    const auto* members = split ? split->FindList("tabIds") : nullptr;
    if (!members || members->empty())
      return false;
    for (const auto& member : *members)
      if (!member.is_string() || !visible_tab(member.GetString()))
        return false;
    return true;
  };
  const auto optional_bool = [](const base::DictValue& input,
                                std::string_view field) {
    return !input.contains(field) || input.FindBool(field).has_value();
  };
  const auto optional_text = [](const base::DictValue& input,
                                std::string_view field,
                                size_t maximum = 1024) {
    return !input.contains(field) ||
           CommandText(input, field, maximum, /*allow_empty=*/true);
  };
  // An absent or null reference, or one the check accepts.
  const auto nullable = [](const base::DictValue& input, std::string_view field,
                           const auto& check) {
    const auto* value = input.Find(field);
    return !value || value->is_none() || check(input, field);
  };
  const auto group_style = [&](const base::DictValue& input) {
    const auto* color = input.Find("color");
    if (color && !color->is_none()) {
      if (!color->is_string())
        return false;
      bool known = false;
      for (const char* name : {"grey", "blue", "red", "yellow", "green", "pink",
                               "purple", "cyan", "orange"})
        known |= color->GetString() == name;
      if (!known)
        return false;
    }
    const auto* icon = input.Find("icon");
    return optional_text(input, "name") &&
           (!icon || icon->is_none() || CommandText(input, "icon", 1024, true));
  };
  const auto unit_delta = [&] {
    const auto value = command.FindDouble("delta");
    return value && (*value == -1 || *value == 1);
  };
  if (*method == "newTab") {
    if (!CommandFields(command, {"method", "windowId"}, {"options"}) ||
        !own_target())
      return false;
    if (!command.contains("options"))
      return true;
    const auto* options = command.FindDict("options");
    if (!options || !CommandFields(*options, {},
                                   {"url", "background", "openerId", "spaceId",
                                    "pinned", "index"}))
      return false;
    if (options->contains("url") &&
        !CommandText(*options, "url", kMaximumInput, true))
      return false;
    for (const char* field : {"background", "pinned"})
      if (options->contains(field) && !options->FindBool(field).has_value())
        return false;
    const auto* space = options->FindString("spaceId");
    if (options->contains("spaceId") &&
        (!space || (is_private ? *space != *own_window->FindString("spaceId")
                               : !public_space(*options, "spaceId"))))
      return false;
    if (options->contains("openerId")) {
      const auto* id = options->FindString("openerId");
      const auto* opener = id ? tab_owned(*id) : nullptr;
      if (!opener || *opener->FindString("spaceId") !=
                         (space ? *space : *own_window->FindString("spaceId")))
        return false;
    }
    const auto position = RuntimeInteger(*options, "index");
    return !options->contains("index") || (position && *position <= 1000000);
  }
  if (*method == "activate" || *method == "showTab" || *method == "closeTab" ||
      *method == "removeTab" || *method == "duplicateTab" ||
      *method == "togglePin" || *method == "navigate" || *method == "moveTab") {
    if (*method == "showTab") {
      const auto* id = command.FindString("tabId");
      const auto* tab = id ? tabs->FindDict(*id) : nullptr;
      const auto* space = tab ? tab->FindString("spaceId") : nullptr;
      if (!tab || !StoredTab(state, *tab) || !space ||
          (is_private ? !own_tab("tabId") : PrivateSpace(*space)))
        return false;
    } else if (!own_tab("tabId")) {
      return false;
    }
    if (*method == "activate" || *method == "showTab") {
      if (!CommandFields(command, {"method", "tabId"}, {"windowId"}))
        return false;
      const auto* target = command.Find("windowId");
      return !target || target->is_none() ||
             (target->is_string() && visible_window(target->GetString()));
    }
    if (*method == "navigate") {
      if (!CommandFields(command, {"method", "tabId", "url"}, {"options"}) ||
          !CommandText(command, "url", kMaximumInput, true))
        return false;
      const auto* options = command.FindDict("options");
      return !command.contains("options") ||
             (options && CommandFields(*options, {}, {"userInitiated"}) &&
              (!options->contains("userInitiated") ||
               options->FindBool("userInitiated").has_value()));
    }
    if (*method == "moveTab")
      return CommandFields(command, {"method", "tabId", "toIndex"}) &&
             index("toIndex");
    return CommandFields(command, {"method", "tabId"});
  }
  if (*method == "closeTabs")
    return CommandFields(command, {"method", "tabIds"}) && owned_tabs(command);
  if (*method == "activateIndex" || *method == "cycle") {
    if (!CommandFields(command, {"method", "windowId",
                                 *method == "cycle" ? "delta" : "index"}) ||
        !own_target())
      return false;
    const auto delta = command.FindDouble("delta");
    return *method == "cycle" ? delta && (*delta == -1 || *delta == 1)
                              : index("index", -1);
  }
  if (*method == "openInMainWindow")
    return CommandFields(command, {"method", "windowId"}) && own_target() &&
           harbor && !is_private;
  if (*method == "focusWindow") {
    const auto* target = command.FindString("windowId");
    return CommandFields(command, {"method", "windowId"}) && target &&
           visible_window(*target);
  }
  if (*method == "closeWindow" || *method == "toggleSidebar" ||
      *method == "mergeAllWindows")
    return CommandFields(command, {"method", "windowId"}) && own_target() &&
           (*method != "mergeAllWindows" || (!is_private && !harbor));
  if (*method == "switchSpace")
    return CommandFields(command, {"method", "windowId", "spaceId"}) &&
           own_target() && !is_private && !harbor &&
           public_space(command, "spaceId");
  if (*method == "moveTabToSpace")
    return CommandFields(command, {"method", "tabId", "spaceId"}) &&
           own_tab("tabId") && !is_private && public_space(command, "spaceId");
  if (*method == "moveTabsToWindow") {
    if (!CommandFields(command, {"method", "tabIds", "windowId"}) ||
        !owned_tabs(command))
      return false;
    const auto* target = command.Find("windowId");
    if (target->is_none())
      return !is_private;
    if (!target->is_string() || !visible_window(target->GetString()))
      return false;
    const auto* target_kind =
        windows->FindDict(target->GetString())->FindString("kind");
    return !target_kind || *target_kind != "small";
  }
  if (*method == "createWindow") {
    if (!CommandFields(command, {"method"}, {"options", "openPanel"}) ||
        (command.contains("openPanel") &&
         !command.FindBool("openPanel").has_value()))
      return false;
    if (!command.contains("options"))
      return !is_private;
    const auto* options = command.FindDict("options");
    if (!options || !CommandFields(*options, {},
                                   {"spaceId", "incognito", "url", "tabIds",
                                    "frame", "small", "background"}))
      return false;
    for (const char* field : {"incognito", "small", "background"})
      if (options->contains(field) && !options->FindBool(field).has_value())
        return false;
    const bool private_target = options->FindBool("incognito").value_or(false);
    const bool small_target = options->FindBool("small").value_or(false);
    if ((is_private && !private_target) ||
        (options->contains("spaceId") && !public_space(*options, "spaceId")) ||
        (options->contains("url") &&
         !CommandText(*options, "url", kMaximumInput, true)) ||
        (options->contains("tabIds") && !owned_tabs(*options)))
      return false;
    const auto* ids = options->FindList("tabIds");
    if ((private_target && (options->contains("spaceId") || small_target ||
                            (ids && !ids->empty()))) ||
        (small_target && ids && !ids->empty()))
      return false;
    const auto* frame = options->Find("frame");
    if (frame && !frame->is_none()) {
      if (!frame->is_list() || frame->GetList().size() != 4)
        return false;
      size_t i = 0;
      for (const auto& component : frame->GetList()) {
        if (!component.is_double() && !component.is_int())
          return false;
        const double number = component.GetDouble();
        if (!std::isfinite(number) || std::abs(number) > 1000000 ||
            (i >= 2 && number <= 0))
          return false;
        ++i;
      }
    }
    return true;
  }
  if (*method == "reopenClosed" || *method == "reopenClosedTab" ||
      *method == "reopenClosedWindow" || *method == "restoreClosed" ||
      *method == "reopenPeekOrClosed") {
    if (!CommandFields(
            command,
            *method == "restoreClosed"
                ? std::initializer_list<std::string_view>{"method", "entryId",
                                                          "windowId"}
            : *method == "reopenClosedWindow"
                ? std::initializer_list<std::string_view>{"method"}
                : std::initializer_list<std::string_view>{"method",
                                                          "windowId"}))
      return false;
    // A reducer's default window comes from global focus, which can name a
    // different private window. Remote restores always name their own target.
    if (*method != "reopenClosedWindow" && !own_target())
      return false;
    const auto allowed_tab_entry = [&](const base::Value& entry) {
      const auto* closed = entry.is_dict() ? &entry.GetDict() : nullptr;
      const auto* snapshot = closed ? closed->FindDict("tab") : nullptr;
      const auto* owner = closed ? closed->FindString("windowId") : nullptr;
      const auto* space = snapshot ? snapshot->FindString("spaceId") : nullptr;
      return snapshot && space &&
             (is_private ? owner && *owner == window_id &&
                               *space == *own_window->FindString("spaceId")
                         : !HasPrivateData(entry));
    };
    if (*method == "restoreClosed") {
      if (!CommandText(command, "entryId", 1024))
        return false;
      const auto& entry_id = *command.FindString("entryId");
      for (const char* key :
           {"closedTabs", "closedWindows", "closedGroups", "deletedGroups"}) {
        for (const auto& entry : *state.FindList(key)) {
          const auto* id =
              entry.is_dict() ? entry.GetDict().FindString("id") : nullptr;
          if (id && *id == entry_id)
            return std::string_view(key) == "closedTabs"
                       ? allowed_tab_entry(entry)
                       : !is_private && !HasPrivateData(entry);
        }
      }
      return false;
    }
    if (*method == "reopenClosedWindow") {
      const auto* entries = state.FindList("closedWindows");
      return !is_private &&
             (entries->empty() || !HasPrivateData(entries->back()));
    }
    // Private targets only restore their own closed tabs. Public targets skip
    // private closed tabs in the reducer, so unrelated private history must not
    // disable reopening a public tab.
    if (is_private || *method == "reopenClosedTab")
      return true;
    for (const char* key : {"closedWindows", "closedGroups"}) {
      const auto* entries = state.FindList(key);
      if (!entries->empty() && HasPrivateData(entries->back()))
        return false;
    }
    return true;
  }
  if (*method == "updateSettings") {
    const auto* patch = command.FindDict("patch");
    return !is_private && CommandFields(command, {"method", "patch"}) &&
           patch &&
           CommandFields(*patch, {},
                         {"warnBeforeQuitting",
                          "warnBeforeClosingWindow",
                          "restoreSession",
                          "launchTab",
                          "searchEngine",
                          "customSearchUrl",
                          "searchSuggestions",
                          "calculatorEnabled",
                          "commandBarPreference",
                          "tabLayout",
                          "hideToolbarWhileScrolling",
                          "newTabPosition",
                          "warnBeforeClosingLastTab",
                          "warnBeforeMovingTabsToSpace",
                          "tabReorderHaptics",
                          "extendWebsiteColor",
                          "cmdClickCreatesTabGroup",
                          "optShiftClickOpensInGroup",
                          "autoGroupMeetingTabs",
                          "cleanUpInactiveTabsAfterHours",
                          "awakeSites",
                          "mutedSites",
                          "neverTranslateSites",
                          "developerSites",
                          "autoPictureInPicture",
                          "noAutoPictureInPictureSites",
                          "previewFolders",
                          "previewGmail",
                          "previewGithub",
                          "sidebarWidth",
                          "sidebarPosition",
                          "batterySaver",
                          "extensionSidePanelWidth",
                          "showFullUrl",
                          "bookmarksBar",
                          "hideBookmarksBarImport",
                          "appearance",
                          "density",
                          "windowMaterial",
                          "addressBar",
                          "defaultSpaceId",
                          "shortcuts",
                          "openLinksInLittleBay",
                          "externalLinkRules",
                          "peekLinksFromPinnedTabs",
                          "littleBaySize"});
  }
  if (*method == "setTabLayout") {
    const auto* layout = command.FindString("layout");
    return !is_private && CommandFields(command, {"method", "layout"}) &&
           layout && (*layout == "sidebar" || *layout == "top");
  }
  if (*method == "setSearchEngine" || *method == "removeCustomEngine")
    return !is_private && CommandFields(command, {"method", "id"}) &&
           CommandText(command, "id", 1024);
  if (*method == "addCustomEngine" || *method == "updateCustomEngine") {
    const auto* input = command.FindDict("input");
    return !is_private &&
           CommandFields(
               command,
               *method == "addCustomEngine"
                   ? std::initializer_list<std::string_view>{"method", "input"}
                   : std::initializer_list<std::string_view>{"method", "id",
                                                             "input"}) &&
           (*method == "addCustomEngine" || CommandText(command, "id", 1024)) &&
           input && CommandFields(*input, {"name", "url"}, {"keyword"}) &&
           CommandText(*input, "name", 1024) &&
           CommandText(*input, "url", kMaximumInput) &&
           (!input->contains("keyword") ||
            CommandText(*input, "keyword", 1024, true));
  }
  if (*method == "openLocation") {
    if (!CommandFields(command,
                       {"method", "sourceTabId", "url", "disposition"}) ||
        !own_tab("sourceTabId") || !CommandText(command, "url", kMaximumInput))
      return false;
    const auto* disposition = command.FindString("disposition");
    return disposition &&
           (*disposition == "current" || *disposition == "newTab" ||
            *disposition == "backgroundTab" || *disposition == "newWindow");
  }
  if (*method == "switchToExistingTab") {
    if (!CommandFields(command, {"method", "sourceTabId", "targetTabId"}) ||
        !own_tab("sourceTabId"))
      return false;
    const auto* target_id = command.FindString("targetTabId");
    const auto* target = target_id ? tabs->FindDict(*target_id) : nullptr;
    const auto* target_owner =
        target ? target->FindString("windowId") : nullptr;
    const auto* target_window =
        target_owner ? windows->FindDict(*target_owner) : nullptr;
    if (!target || !StoredTab(state, *target))
      return false;
    const auto* space = target->FindString("spaceId");
    if (own_window->FindBool("incognito").value_or(false))
      return *target_owner == window_id;
    return space && !PrivateSpace(*space) &&
           (!target_window ||
            !target_window->FindBool("incognito").value_or(false));
  }
  if (*method == "requestNewTab") {
    if (!CommandFields(command, {"method", "windowId"}, {"groupId"}) ||
        !own_target())
      return false;
    if (!command.contains("groupId"))
      return true;
    if (!CommandText(command, "groupId", 1024))
      return false;
    const auto* groups = state.FindDict("groups");
    const auto* group =
        groups ? groups->FindDict(*command.FindString("groupId")) : nullptr;
    const auto* space = group ? group->FindString("spaceId") : nullptr;
    return space && own_window->FindString("spaceId") &&
           *space == *own_window->FindString("spaceId");
  }
  if (*method == "submitNewTab") {
    return CommandFields(command, {"method", "windowId", "url"}) &&
           own_target() && CommandText(command, "url", kMaximumInput);
  }
  if (*method == "openCommandPanel") {
    return CommandFields(command, {"method", "windowId"},
                         {"initialText", "sourceTabId"}) &&
           own_target() &&
           (!command.contains("sourceTabId") || own_tab("sourceTabId")) &&
           (!command.contains("initialText") ||
            CommandText(command, "initialText", kMaximumInput, true));
  }
  if (*method == "dismissCommandPanel") {
    return CommandFields(command, {"method", "windowId"}) && own_target();
  }
  if (*method == "createGroup" || *method == "groupTabs") {
    if (!CommandFields(command, {"method", "tabIds"}, {"options"}) ||
        !visible_tabs(command, 1))
      return false;
    if (!command.contains("options"))
      return true;
    const auto* options = command.FindDict("options");
    if (*method == "groupTabs")
      return options && CommandFields(*options, {}, {"pinned", "name"}) &&
             optional_bool(*options, "pinned") &&
             optional_text(*options, "name");
    return options && CommandFields(*options, {}, {"name", "icon", "color"}) &&
           group_style(*options);
  }
  if (*method == "updateGroup") {
    const auto* patch = command.FindDict("patch");
    return CommandFields(command, {"method", "groupId", "patch"}) &&
           visible_group(command, "groupId") && patch &&
           CommandFields(*patch, {},
                         {"name", "icon", "color", "collapsed", "pinned"}) &&
           group_style(*patch) && optional_bool(*patch, "collapsed") &&
           optional_bool(*patch, "pinned");
  }
  if (*method == "addTabsToGroup")
    return CommandFields(command, {"method", "groupId", "tabIds"}) &&
           visible_group(command, "groupId") && visible_tabs(command, 1);
  if (*method == "removeTabsFromGroup")
    return CommandFields(command, {"method", "tabIds"}) &&
           visible_tabs(command, 1);
  if (*method == "ungroup" || *method == "closeGroup" ||
      *method == "deleteGroup" || *method == "duplicateGroup" ||
      *method == "moveGroupToBookmarksBar")
    return CommandFields(command, {"method", "groupId"}) &&
           visible_group(command, "groupId");
  if (*method == "moveGroup") {
    const auto* placement = command.FindDict("placement");
    return CommandFields(command, {"method", "groupId", "placement"}) &&
           visible_group(command, "groupId") && placement &&
           CommandFields(*placement, {"pinned"}, {"beforeId"}) &&
           placement->FindBool("pinned").has_value() &&
           nullable(*placement, "beforeId", visible_field);
  }
  if (*method == "newTabInGroup")
    return CommandFields(command, {"method", "groupId"}, {"url"}) &&
           visible_group(command, "groupId") &&
           optional_text(command, "url", kMaximumInput);
  const auto folder_anchor = [&](const base::DictValue& input,
                                 std::string_view field) {
    return visible_folder(input, field) || visible_field(input, field);
  };
  if (*method == "newPinnedFolder") {
    if (!CommandFields(command, {"method", "windowId"}, {"options"}) ||
        !own_target() || is_private || harbor)
      return false;
    if (!command.contains("options"))
      return true;
    const auto* options = command.FindDict("options");
    return options &&
           CommandFields(*options, {},
                         {"tabIds", "name", "parentId", "spaceId",
                          "beforeId"}) &&
           (!options->contains("tabIds") || visible_tabs(*options)) &&
           optional_text(*options, "name") &&
           (!options->contains("parentId") ||
            visible_folder(*options, "parentId")) &&
           (!options->contains("spaceId") ||
            public_space(*options, "spaceId")) &&
           (!options->contains("beforeId") ||
            folder_anchor(*options, "beforeId"));
  }
  if (*method == "updatePinnedFolder") {
    const auto* patch = command.FindDict("patch");
    const auto* icon = patch ? patch->Find("icon") : nullptr;
    return CommandFields(command, {"method", "folderId", "patch"}) &&
           visible_folder(command, "folderId") && patch &&
           CommandFields(*patch, {}, {"name", "icon", "collapsed"}) &&
           optional_text(*patch, "name") &&
           (!icon || icon->is_none() ||
            CommandText(*patch, "icon", 1024, true)) &&
           optional_bool(*patch, "collapsed");
  }
  if (*method == "movePinnedFolder") {
    return CommandFields(command, {"method", "folderId", "beforeId"},
                         {"parentId"}) &&
           visible_folder(command, "folderId") &&
           nullable(command, "beforeId", folder_anchor) &&
           nullable(command, "parentId", visible_folder);
  }
  if (*method == "deletePinnedFolder")
    return CommandFields(command, {"method", "folderId"}) &&
           visible_folder(command, "folderId");
  if (*method == "undoPinnedFolderMove")
    return CommandFields(command, {"method"}) && !is_private && !harbor;
  if (*method == "setSelection")
    return CommandFields(command, {"method", "windowId", "tabIds"}) &&
           own_target() && visible_tabs(command);
  if (*method == "placeTabs") {
    const auto* placement = command.FindDict("placement");
    return CommandFields(command, {"method", "tabIds", "placement"}) &&
           visible_tabs(command, 1) && placement &&
           CommandFields(*placement, {"pinned"},
                         {"row", "folderId", "beforeId", "groupId"}) &&
           placement->FindBool("pinned").has_value() &&
           optional_bool(*placement, "row") &&
           nullable(*placement, "folderId", visible_folder) &&
           nullable(*placement, "groupId", visible_group) &&
           nullable(*placement, "beforeId", visible_field);
  }
  if (*method == "pinTabs" || *method == "pinRows" || *method == "setMuted") {
    const char* flag = *method == "setMuted" ? "muted" : "pinned";
    return CommandFields(command, {"method", "tabIds", flag}) &&
           visible_tabs(command, 1) && command.FindBool(flag).has_value();
  }
  if (*method == "setSiteMuted")
    return CommandFields(command, {"method", "tabId", "muted"}) &&
           visible_field(command, "tabId") &&
           command.FindBool("muted").has_value();
  if (*method == "returnToPinnedUrl")
    return CommandFields(command, {"method", "tabId"}) &&
           visible_field(command, "tabId");
  if (*method == "setPinnedUrl")
    return CommandFields(command, {"method", "tabId"}, {"url"}) &&
           visible_field(command, "tabId") &&
           optional_text(command, "url", kMaximumInput);
  if (*method == "cleanUpTabs") {
    if (!CommandFields(command, {"method", "windowId"}, {"options"}) ||
        !own_target())
      return false;
    if (!command.contains("options"))
      return true;
    const auto* options = command.FindDict("options");
    const auto* space = options ? options->FindString("spaceId") : nullptr;
    return options &&
           CommandFields(*options, {}, {"inactiveForMs", "spaceId"}) &&
           (!options->contains("inactiveForMs") ||
            RuntimeInteger(*options, "inactiveForMs")) &&
           (!options->contains("spaceId") ||
            (space && (is_private ? *space == *own_window->FindString("spaceId")
                                  : public_space(*options, "spaceId"))));
  }
  if (*method == "restoreCleaned") {
    if (!CommandFields(command, {"method", "windowId"}, {"entryId"}) ||
        !own_target())
      return false;
    if (!command.contains("entryId"))
      return true;
    if (!CommandText(command, "entryId", 1024))
      return false;
    // Public windows restore public entries; a private window only its own.
    const auto* entries =
        is_private ? state.FindDict("privateCleanedTabs")->FindList(window_id)
                   : state.FindList("cleanedTabs");
    if (!entries)
      return false;
    for (const auto& entry : *entries) {
      const auto* id =
          entry.is_dict() ? entry.GetDict().FindString("id") : nullptr;
      if (id && *id == *command.FindString("entryId"))
        return is_private || !HasPrivateData(entry);
    }
    return false;
  }
  if (*method == "createSplit") {
    const auto* orientation = command.FindString("orientation");
    return CommandFields(command, {"method", "tabIds"}, {"orientation"}) &&
           visible_tabs(command, 2, 3) &&
           (!command.contains("orientation") ||
            (orientation &&
             (*orientation == "horizontal" || *orientation == "vertical")));
  }
  if (*method == "openSplitPane") {
    if (!CommandFields(command, {"method", "windowId"}, {"options"}) ||
        !own_target())
      return false;
    if (!command.contains("options"))
      return true;
    const auto* options = command.FindDict("options");
    const auto* side = options ? options->FindString("side") : nullptr;
    return options &&
           CommandFields(*options, {},
                         {"tabId", "url", "anchorTabId", "side",
                          "background"}) &&
           (!options->contains("tabId") || visible_field(*options, "tabId")) &&
           (!options->contains("anchorTabId") ||
            visible_field(*options, "anchorTabId")) &&
           optional_text(*options, "url", kMaximumInput) &&
           optional_bool(*options, "background") &&
           (!options->contains("side") ||
            (side && (*side == "left" || *side == "right" || *side == "top" ||
                      *side == "bottom")));
  }
  if (*method == "replaceSplitPane")
    return CommandFields(command, {"method", "paneTabId", "tabId"}) &&
           visible_field(command, "paneTabId") &&
           visible_field(command, "tabId");
  if (*method == "removeTabFromSplit")
    return CommandFields(command, {"method", "tabId"}) &&
           visible_field(command, "tabId");
  if (*method == "movePane")
    return CommandFields(command, {"method", "tabId", "delta"}) &&
           visible_field(command, "tabId") && unit_delta();
  if (*method == "separateSplit" || *method == "flipSplit" ||
      *method == "toggleSplitOrientation")
    return CommandFields(command, {"method", "splitId"}) && visible_split();
  if (*method == "updateSplit") {
    const auto* patch = command.FindDict("patch");
    if (!CommandFields(command, {"method", "splitId", "patch"}) ||
        !visible_split() || !patch ||
        !CommandFields(*patch, {}, {"sizes", "stackSizes"}))
      return false;
    for (const char* field : {"sizes", "stackSizes"}) {
      if (!patch->contains(field))
        continue;
      const auto* sizes = patch->FindList(field);
      const size_t maximum = std::string_view(field) == "sizes" ? 3 : 2;
      if (!sizes || sizes->size() < 2 || sizes->size() > maximum)
        return false;
      for (const auto& size : *sizes)
        if ((!size.is_double() && !size.is_int()) ||
            !std::isfinite(size.GetDouble()) || size.GetDouble() <= 0 ||
            size.GetDouble() > 1)
          return false;
    }
    return true;
  }
  if (*method == "focusPane")
    return CommandFields(command, {"method", "windowId", "delta"}) &&
           own_target() && unit_delta();
  if (*method == "toggleTabLayout")
    return CommandFields(command, {"method", "windowId"}) && own_target() &&
           !is_private;
  if (*method == "closePeek" || *method == "keepPeek" ||
      *method == "splitPeek")
    return CommandFields(command, {"method", "windowId"}) && own_target();
  if (*method == "openPeek")
    return CommandFields(command, {"method", "fromTabId", "url"}) &&
           own_tab("fromTabId") && CommandText(command, "url", kMaximumInput);
  // Spaces are app-wide preferences, as settings are: never from a private
  // window, and only public spaces are named.
  if (*method == "createSpace") {
    const auto* options = command.FindDict("options");
    return !is_private && CommandFields(command, {"method", "options"}) &&
           options &&
           CommandFields(*options, {"name"},
                         {"color", "theme", "icon", "shareWith"}) &&
           CommandText(*options, "name", 1024, true) &&
           nullable(*options, "shareWith", public_space);
  }
  if (*method == "updateSpace") {
    const auto* patch = command.FindDict("patch");
    return !is_private &&
           CommandFields(command, {"method", "spaceId", "patch"}) &&
           public_space(command, "spaceId") && patch &&
           CommandFields(*patch, {},
                         {"name", "color", "icon", "theme", "followSite",
                          "folded", "cleanUpAfterHours"});
  }
  if (*method == "deleteSpace" || *method == "setDefaultSpace")
    return !is_private && CommandFields(command, {"method", "spaceId"}) &&
           public_space(command, "spaceId");
  if (*method == "reorderSpaces") {
    const auto* ids = command.FindList("spaceIds");
    if (is_private || !CommandFields(command, {"method", "spaceIds"}) || !ids ||
        ids->size() > 10000)
      return false;
    std::set<std::string> seen;
    for (const auto& id : *ids)
      if (!id.is_string() || !seen.insert(id.GetString()).second ||
          PrivateSpace(id.GetString()) ||
          !state.FindDict("spaces")->FindDict(id.GetString()))
        return false;
    return true;
  }
  // Bookmarks are regular spaces' trees, which every window may edit (a
  // private window bookmarks into the default space). A move stays in one
  // profile's tree; Chrome's top folders are never edited themselves.
  const auto* bookmarks = state.FindDict("bookmarks");
  const auto* bookmark_nodes = bookmarks->FindDict("nodes");
  const auto* bookmark_roots = bookmarks->FindDict("roots");
  const auto space_bar = [&](std::string_view space) -> const std::string* {
    const auto* roots = !PrivateSpace(space) &&
                                state.FindDict("spaces")->FindDict(space)
                            ? bookmark_roots->FindDict(space)
                            : nullptr;
    return roots ? roots->FindString("bar") : nullptr;
  };
  // The bar folder of the regular tree holding `id`, or null.
  const auto tree_of = [&](const std::string& id,
                           bool top = false) -> const std::string* {
    const auto* node = bookmark_nodes->FindDict(id);
    if (!node || (!top && !node->FindString("parentId")))
      return nullptr;
    std::string current = id;
    for (int depth = 0; depth < 64; ++depth) {
      const auto* parent = node->FindString("parentId");
      if (!parent)
        break;
      current = *parent;
      node = bookmark_nodes->FindDict(current);
      if (!node)
        return nullptr;
    }
    if (node->FindString("parentId"))
      return nullptr;
    for (const auto [space, roots] : *bookmark_roots) {
      const auto* bar = space_bar(space);
      const auto* other =
          roots.is_dict() ? roots.GetDict().FindString("other") : nullptr;
      if (bar && (*bar == current || (other && *other == current)))
        return bar;
    }
    return nullptr;
  };
  const auto folder_in = [&](const base::DictValue& input,
                             std::string_view field, const std::string* bar) {
    const auto* id = input.FindString(field);
    const auto* node = id ? bookmark_nodes->FindDict(*id) : nullptr;
    const auto* tree = node && node->FindList("children") ? tree_of(*id, true)
                                                          : nullptr;
    return bar && tree && *tree == *bar;
  };
  const auto bookmark_place = [&](const base::DictValue& input,
                                  const std::string* bar) {
    const auto position = input.FindDouble("index");
    return (!input.contains("parentId") || folder_in(input, "parentId", bar)) &&
           (!input.contains("index") ||
            (position && std::isfinite(*position) &&
             std::floor(*position) == *position && *position >= 0 &&
             *position <= 1000000));
  };
  const auto bookmark_space = [&](const base::DictValue& input) {
    const auto* space = input.FindString("spaceId");
    return space ? space_bar(*space) : nullptr;
  };
  if (*method == "addBookmark" || *method == "addBookmarkFolder") {
    const auto* options = command.FindDict("options");
    if (!CommandFields(command, {"method", "options"}) || !options ||
        !public_space(*options, "spaceId"))
      return false;
    const bool page = *method == "addBookmark";
    return (page ? CommandFields(*options, {"spaceId", "url", "title"},
                                 {"favicon", "parentId", "index"})
                 : CommandFields(*options, {"spaceId", "title"},
                                 {"parentId", "index"})) &&
           bookmark_place(*options, bookmark_space(*options));
  }
  if (*method == "addBookmarkTree") {
    const auto* drafts = command.FindList("drafts");
    size_t count = 0;
    return CommandFields(command, {"method", "spaceId", "drafts"},
                         {"parentId", "index"}) &&
           public_space(command, "spaceId") && drafts &&
           BookmarkDrafts(*drafts, 1, count) &&
           bookmark_place(command, bookmark_space(command));
  }
  if (*method == "updateBookmark") {
    const auto* id = command.FindString("bookmarkId");
    const auto* patch = command.FindDict("patch");
    return CommandFields(command, {"method", "bookmarkId", "patch"}) && id &&
           tree_of(*id) && patch &&
           CommandFields(*patch, {}, {"title", "url", "favicon"});
  }
  if (*method == "moveBookmark") {
    const auto* id = command.FindString("bookmarkId");
    const auto* tree = id ? tree_of(*id) : nullptr;
    return CommandFields(command, {"method", "bookmarkId", "parentId"},
                         {"index"}) &&
           tree && bookmark_place(command, tree);
  }
  if (*method == "removeBookmark") {
    const auto* id = command.FindString("bookmarkId");
    return CommandFields(command, {"method", "bookmarkId"}) && id &&
           tree_of(*id);
  }
  if (*method == "toggleBookmark") {
    const auto* page = command.FindDict("page");
    return CommandFields(command, {"method", "spaceId", "page"}) &&
           public_space(command, "spaceId") && page &&
           CommandFields(*page, {"url", "title"}, {"favicon"});
  }
  if (*method == "removeBookmarks") {
    const auto* bar = bookmark_space(command);
    const auto* ids = command.FindList("bookmarkIds");
    if (!CommandFields(command, {"method", "spaceId", "bookmarkIds"}) ||
        !public_space(command, "spaceId") || !bar || !ids ||
        ids->size() > 10000)
      return false;
    std::set<std::string> seen;
    for (const auto& id : *ids) {
      const auto* tree =
          id.is_string() ? tree_of(id.GetString()) : nullptr;
      if (!tree || *tree != *bar || !seen.insert(id.GetString()).second)
        return false;
    }
    return true;
  }
  if (*method == "restoreBookmarks") {
    const auto* id = command.FindString("undoId");
    if (!CommandFields(command, {"method", "undoId"}) || !id)
      return false;
    for (const auto& entry : *state.FindList("bookmarkUndo")) {
      const auto* entry_id =
          entry.is_dict() ? entry.GetDict().FindString("id") : nullptr;
      const auto* space =
          entry.is_dict() ? entry.GetDict().FindString("spaceId") : nullptr;
      if (entry_id && *entry_id == *id)
        return space && !PrivateSpace(*space);
    }
    return false;
  }
  // History is a regular space's, cleared like a setting is changed.
  if (*method == "removeHistory") {
    const auto* urls = command.FindList("urls");
    if (is_private || !CommandFields(command, {"method", "spaceId", "urls"}) ||
        !public_space(command, "spaceId") || !urls || urls->empty() ||
        urls->size() > 10000)
      return false;
    for (const auto& url : *urls)
      if (!url.is_string() || url.GetString().size() > kMaximumInput)
        return false;
    return true;
  }
  if (*method == "clearHistory")
    return !is_private &&
           CommandFields(command, {"method", "spaceId"}, {"since"}) &&
           public_space(command, "spaceId") &&
           (!command.contains("since") || command.FindDouble("since"));
  return false;
}
}  // namespace bay
