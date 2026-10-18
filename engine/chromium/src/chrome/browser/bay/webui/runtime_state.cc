// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/runtime_state.h"

#include <cmath>
#include <set>
#include <string_view>
#include <vector>
#include "base/strings/string_util.h"

namespace bay {
namespace {
constexpr const char* kRecords[] = {"profiles",
                                    "windows",
                                    "parkedPins",
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
    "profileOrder",  "orphanedProfileData", "windowOrder",
    "closedWindows", "closedTabs",          "cleanedTabs",
    "closedGroups",  "deletedGroups",       "downloads"};
bool PrivateProfile(std::string_view id) {
  return base::StartsWith(id, "incognito:");
}
const std::string* Text(const base::DictValue& value, const char* key) {
  return value.FindString(key);
}
bool HasPrivateProfile(const base::Value& value) {
  if (value.is_dict()) {
    if (value.GetDict().FindBool("incognito").value_or(false))
      return true;
    for (const auto [key, item] : value.GetDict()) {
      if ((key == "profileId" || key == "profile") && item.is_string() &&
          PrivateProfile(item.GetString()))
        return true;
      if (HasPrivateProfile(item))
        return true;
    }
  } else if (value.is_list()) {
    for (const auto& item : value.GetList())
      if (HasPrivateProfile(item))
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
bool ValidOwnedRecord(const base::DictValue& records,
                      const std::string& id,
                      const std::set<std::string>& windows) {
  const auto* record = records.FindDict(id);
  const auto* owner = record ? record->FindString("windowId") : nullptr;
  return owner && windows.contains(*owner);
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
  for (const auto [id, value] : *state.FindDict("windows")) {
    if (!value.is_dict())
      return false;
    const auto& window = value.GetDict();
    const auto* name = Text(window, "id");
    if (!name || *name != id || !Text(window, "profileId") ||
        !window.FindBool("incognito").has_value() ||
        !window.FindList("tabIds") || !window.FindDict("activeTabIds"))
      return false;
    // Private engine identifiers are browser-window scoped. A contradictory
    // flag must never turn a private record into a public one.
    if (window.FindBool("incognito").value() !=
        PrivateProfile(*Text(window, "profileId")))
      return false;
    if (window.FindBool("incognito").value() &&
        *Text(window, "profileId") != "incognito:" + std::string(id))
      return false;
  }
  for (const auto [id, value] : *state.FindDict("tabs")) {
    if (!value.is_dict())
      return false;
    const auto& tab = value.GetDict();
    const auto* name = Text(tab, "id");
    const auto* owner = Text(tab, "windowId");
    const auto* profile = Text(tab, "profileId");
    const auto* window =
        owner ? state.FindDict("windows")->FindDict(*owner) : nullptr;
    if (!name || *name != id || !window || !profile)
      return false;
    if (PrivateProfile(*profile) &&
        (!window->FindBool("incognito").value_or(false) ||
         *profile != *window->FindString("profileId")))
      return false;
    if (window->FindBool("incognito").value_or(false) &&
        *profile != *window->FindString("profileId"))
      return false;
  }
  for (const auto* key : {"groups", "splits"}) {
    for (const auto [id, value] : *state.FindDict(key)) {
      if (!value.is_dict())
        return false;
      const auto& group = value.GetDict();
      const auto* owner = group.FindString("windowId");
      const auto* window =
          owner ? state.FindDict("windows")->FindDict(*owner) : nullptr;
      if (!window || !group.FindList("tabIds"))
        return false;
      // Splits have no profileId. Groups follow the same private namespace
      // as their window; a private label cannot hide in a regular group.
      const auto* profile = group.FindString("profileId");
      if (std::string_view(key) == "groups" && !profile)
        return false;
      if (profile &&
          (PrivateProfile(*profile) ||
           window->FindBool("incognito").value_or(false)) &&
          *profile != *window->FindString("profileId"))
        return false;
    }
  }
  const auto* ui = state.FindDict("ui");
  const auto* focused = ui->Find("focusedWindowId");
  return ui->size() == 3 && ui->FindBool("appDark").has_value() && focused &&
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
  const std::string own_profile = *own->FindString("profileId");
  std::set<std::string> windows, tabs, private_windows;
  for (const auto [id, value] : *state.FindDict("windows")) {
    if (!value.GetDict().FindBool("incognito").value() || id == window_id)
      windows.emplace(id);
    if (is_private && id == window_id)
      private_windows.emplace(id);
  }
  for (const auto [id, value] : *state.FindDict("tabs"))
    if (windows.contains(*value.GetDict().FindString("windowId")))
      tabs.emplace(id);
  auto result = state.Clone();
  for (const auto* key : {"windows", "windowUi"})
    FilterRecord(result, key, windows);
  for (const auto* key : {"tabs", "live", "find"})
    FilterRecord(result, key, tabs);
  for (const auto* key : {"privateCleanedTabs", "privateSiteMutes"})
    FilterRecord(result, key, private_windows);
  for (const auto* key : {"groups", "splits"}) {
    std::set<std::string> allowed;
    for (const auto [id, value] : *result.FindDict(key))
      if (ValidOwnedRecord(*result.FindDict(key), std::string(id), windows))
        allowed.emplace(id);
    FilterRecord(result, key, allowed);
    for (const auto [id, value] : *result.FindDict(key)) {
      auto* item = result.FindDict(key)->FindDict(id);
      if (auto* members = item->FindList("tabIds"))
        FilterList(*members, tabs);
    }
  }
  FilterRecord(result, "selection", windows);
  for (const auto [id, value] : *result.FindDict("selection"))
    if (auto* list = result.FindDict("selection")->FindList(id))
      FilterList(*list, tabs);
  for (const auto [id, value] : *result.FindDict("windows")) {
    auto* window = result.FindDict("windows")->FindDict(id);
    FilterList(*window->FindList("tabIds"), tabs);
    auto* active = window->FindDict("activeTabIds");
    std::vector<std::string> remove;
    for (const auto [profile, tab] : *active)
      if (!tab.is_string() || !tabs.contains(tab.GetString()))
        remove.emplace_back(profile);
    for (const auto& profile : remove)
      active->Remove(profile);
  }
  FilterList(*result.FindList("windowOrder"), windows);
  auto* ui = result.FindDict("ui");
  FilterList(*ui->FindList("focusOrder"), windows);
  if (const auto* focus = ui->FindString("focusedWindowId");
      !focus || !windows.contains(*focus))
    ui->Set("focusedWindowId", base::Value());
  // Closed/private data must not reach another window through ancillary slices.
  // Private records have no persistent history/bookmark/profile namespace.
  for (const auto* key : {"profiles", "parkedPins", "history", "historyReady",
                          "historyFloor", "bookmarksReady"}) {
    std::vector<std::string> remove;
    for (const auto [id, value] : *result.FindDict(key))
      if (PrivateProfile(id) || HasPrivateProfile(value))
        remove.emplace_back(id);
    for (const auto& id : remove)
      result.FindDict(key)->Remove(id);
  }
  for (const auto* key : {"profileOrder", "orphanedProfileData"})
    result.FindList(key)->EraseIf([](const base::Value& value) {
      return !value.is_string() || PrivateProfile(value.GetString());
    });
  // A private bookmark root must not leave its detached nodes behind. Walk
  // regular roots plus this window's own private roots, preserving shared
  // nodes.
  auto* bookmarks = result.FindDict("bookmarks");
  auto* roots = bookmarks->FindDict("roots");
  auto* nodes = bookmarks->FindDict("nodes");
  std::vector<std::string> private_roots;
  std::vector<std::string> visit;
  for (const auto [profile, root] : *roots) {
    if ((PrivateProfile(profile) && (!is_private || profile != own_profile)) ||
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
        [](const base::Value& value) { return HasPrivateProfile(value); });
  result.FindList("downloads")->EraseIf([&](const base::Value& value) {
    if (!value.is_dict())
      return true;
    const auto* profile = value.GetDict().FindString("profile");
    if ((value.GetDict().contains("profile") && !profile) ||
        value.GetDict().FindBool("incognito").value_or(false))
      return true;
    if (is_private)
      return !profile || *profile != own_profile;
    return profile && PrivateProfile(*profile);
  });
  return result;
}

bool CanDispatchRuntimeCommand(const base::DictValue& state,
                               const std::string& window_id,
                               const base::DictValue& command) {
  const auto* window = state.FindDict("windows");
  if (!window || !window->FindDict(window_id))
    return false;
  const auto* method = command.FindString("method");
  if (!method)
    return false;
  if (*method == "newTab" || *method == "closeWindow") {
    const auto* target = command.FindString("windowId");
    return target && *target == window_id;
  }
  if (*method == "activate" || *method == "closeTab" || *method == "navigate") {
    const auto* id = command.FindString("tabId");
    const auto* tab = id ? state.FindDict("tabs")->FindDict(*id) : nullptr;
    const auto* owner = tab ? tab->FindString("windowId") : nullptr;
    return owner && *owner == window_id;
  }
  // Creating another native window is still gated until the complete command
  // migration and native two-window tests pass.
  return false;
}
}  // namespace bay
