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
    "deletedGroups", "downloads"};
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
bool IsRuntimeReply(const base::DictValue& reply,
                    const std::string& epoch,
                    double minimum_revision,
                    double accepted_revision,
                    bool creates_id) {
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
         (creates_id ? value->is_string() : value->is_none());
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
  const auto own_tab = [&](std::string_view field) -> const base::DictValue* {
    const auto* id = command.FindString(field);
    const auto* tab = id ? tabs->FindDict(*id) : nullptr;
    const auto* owner = tab ? tab->FindString("windowId") : nullptr;
    return owner && *owner == window_id && StoredTab(state, *tab) ? tab
                                                                  : nullptr;
  };
  const auto own_target = [&] {
    const auto* id = command.FindString("windowId");
    return id && *id == window_id;
  };
  const auto* kind = own_window->FindString("kind");
  const bool harbor = kind && *kind == "small";
  constexpr size_t kMaximumInput = 1024 * 1024;
  if (*method == "newTab" || *method == "closeWindow") {
    // Harbor tab creation can redirect to a new main window.
    if (*method == "newTab" && harbor)
      return false;
    if (!CommandFields(command, {"method", "windowId"},
                       *method == "newTab"
                           ? std::initializer_list<std::string_view>{"options"}
                           : std::initializer_list<std::string_view>{}) ||
        !own_target())
      return false;
    if (!command.contains("options"))
      return true;
    const auto* options = command.FindDict("options");
    return options && CommandFields(*options, {}, {"url", "background"}) &&
           (!options->contains("url") ||
            CommandText(*options, "url", kMaximumInput, true)) &&
           (!options->contains("background") ||
            options->FindBool("background").has_value());
  }
  if (*method == "activate" || *method == "closeTab" || *method == "navigate") {
    return CommandFields(
               command,
               *method == "navigate"
                   ? std::initializer_list<std::string_view>{"method", "tabId",
                                                             "url"}
                   : std::initializer_list<std::string_view>{"method",
                                                             "tabId"}) &&
           own_tab("tabId") &&
           (*method != "navigate" ||
            CommandText(command, "url", kMaximumInput));
  }
  if (*method == "openLocation") {
    if (!CommandFields(command,
                       {"method", "sourceTabId", "url", "disposition"}) ||
        !own_tab("sourceTabId") || !CommandText(command, "url", kMaximumInput))
      return false;
    const auto* disposition = command.FindString("disposition");
    // New native application windows remain gated during UI migration.
    return disposition && (*disposition == "current" ||
                           (!harbor && (*disposition == "newTab" ||
                                        *disposition == "backgroundTab")));
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
    // A Harbor request can create a main window. Enable that path only with
    // the rest of the native multiwindow acceptance gate.
    if (harbor)
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
  // Creating another native window is still gated until the complete command
  // migration and native two-window tests pass.
  return false;
}
}  // namespace bay
