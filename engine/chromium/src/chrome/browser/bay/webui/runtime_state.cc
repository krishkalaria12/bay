// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/runtime_state.h"

#include <algorithm>
#include <cmath>
#include <initializer_list>
#include <set>
#include <string_view>
#include <vector>
#include "base/json/json_writer.h"
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
                                    "find",
                                    "services"};
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
// Service snapshots contain UI data only. Every record shape is allowlisted so
// adding a credential or recovery field cannot silently publish it to windows.
bool ServiceFields(const base::DictValue& value,
                   std::initializer_list<std::string_view> fields) {
  return CommandFields(value, {}, fields);
}
bool SafeServiceRecord(const base::Value& value, const char* shape);
bool ServiceChildren(const base::DictValue& value, const char* key,
                     const char* shape, bool map = false) {
  const auto* child = value.Find(key);
  if (!child || child->is_none())
    return true;
  if (map) {
    if (!child->is_dict())
      return false;
    for (const auto [id, item] : child->GetDict())
      if (!SafeServiceRecord(item, shape))
        return false;
  } else {
    if (!child->is_list())
      return false;
    for (const auto& item : child->GetList())
      if (!SafeServiceRecord(item, shape))
        return false;
  }
  return true;
}
bool SafeServiceRecord(const base::Value& value, const char* shape) {
  if (!value.is_dict())
    return false;
  const auto& d = value.GetDict();
  const std::string_view kind(shape);
  if (kind == "folder") {
    const auto* filters = d.FindDict("filters");
    return ServiceFields(d, {"id", "spaceId", "kind", "name", "icon",
                             "collapsed", "sources", "filters", "createdAt"}) &&
           (!d.contains("filters") ||
            (filters && ServiceFields(*filters, {"authored", "reviewRequests"})));
  }
  if (kind == "item")
    return ServiceFields(d, {"id", "source", "url", "title", "subtitle", "icon",
                             "updatedAt", "section", "pr", "doc"}) &&
           (!d.contains("pr") || SafeServiceRecord(*d.Find("pr"), "pr")) &&
           (!d.contains("doc") || SafeServiceRecord(*d.Find("doc"), "doc"));
  if (kind == "pr")
    return ServiceFields(d, {"number", "repo", "author", "authorAvatar", "draft",
                             "headRef", "baseRef", "review", "mergeable", "checks",
                             "comments", "unresolvedThreads", "additions",
                             "deletions", "changedFiles", "stack"}) &&
           ServiceChildren(d, "checks", "check") &&
           (!d.contains("stack") || SafeServiceRecord(*d.Find("stack"), "stack"));
  if (kind == "check") return ServiceFields(d, {"name", "state", "url"});
  if (kind == "stack") return ServiceFields(d, {"id", "position", "size"});
  if (kind == "doc") return ServiceFields(d, {"kind", "editedBy", "place"});
  if (kind == "completed")
    return ServiceFields(d, {"item", "state", "at"}) && d.Find("item") &&
           SafeServiceRecord(*d.Find("item"), "item");
  if (kind == "status")
    return ServiceFields(d, {"state", "lastFetch", "error"}) &&
           (!d.Find("error") || d.Find("error")->is_none() ||
            SafeServiceRecord(*d.Find("error"), "error"));
  if (kind == "error") return ServiceFields(d, {"kind", "message", "source"});
  if (kind == "account") return ServiceFields(d, {"login", "name", "avatar", "connectedAt"});
  if (kind == "meeting")
    return ServiceFields(d, {"groupId", "callTabId", "occurrence", "title",
                             "start", "end", "endedAt"});
  if (kind == "calendar")
    return ServiceFields(d, {"id", "title", "color", "account", "accountType", "owned"});
  if (kind == "participant") return ServiceFields(d, {"name", "email", "status", "me"});
  if (kind == "event")
    return ServiceFields(d, {"id", "occurrence", "calendarId", "color", "title",
                             "start", "end", "allDay", "location", "notes", "url",
                             "cancelled", "declined", "organizer", "attendees"}) &&
           ServiceChildren(d, "attendees", "participant") &&
           (!d.Find("organizer") || d.Find("organizer")->is_none() ||
            SafeServiceRecord(*d.Find("organizer"), "participant"));
  if (kind == "profile") return ServiceFields(d, {"syncId", "enabled", "retire"});
  if (kind == "device") return ServiceFields(d, {"id", "name", "lastSeen", "current"});
  if (kind == "remoteProfile") return ServiceFields(d, {"syncId", "name", "color", "icon"});
  if (kind == "remoteTabs")
    return ServiceFields(d, {"deviceId", "name", "tabs"}) && ServiceChildren(d, "tabs", "tab");
  if (kind == "tab") return ServiceFields(d, {"url", "title"});
  return false;
}
bool SafeServices(const base::DictValue& services) {
  if (!ServiceFields(services, {"live", "calendar", "alerts", "sync", "telemetry"}))
    return false;
  for (const auto [name, value] : services) {
    if (!value.is_dict())
      return false;
    const auto& d = value.GetDict();
    if (name == "telemetry") {
      if (!ServiceFields(d, {"sharing", "decided", "askDone"})) return false;
      for (const auto [key, value] : d) if (!value.is_bool()) return false;
    } else if (name == "live") {
      if (!ServiceFields(d, {"folders", "folderOrder", "items", "known", "unread",
                              "completed", "completing", "status", "expandedStacks",
                              "showAll", "accounts", "config", "calendar",
                              "meetingGroups", "dismissedAlerts"}) ||
          !ServiceChildren(d, "folders", "folder", true) ||
          !ServiceChildren(d, "accounts", "account", true) ||
          !ServiceChildren(d, "status", "status", true) ||
          !ServiceChildren(d, "meetingGroups", "meeting", true))
        return false;
      for (const auto* key : {"items", "completed"}) {
        const auto* records = d.FindDict(key);
        if (d.contains(key) && !records) return false;
        if (records)
          for (const auto [id, list] : *records) {
            if (!list.is_list()) return false;
            for (const auto& item : list.GetList())
              if (!SafeServiceRecord(item, std::string_view(key) == "items" ? "item" : "completed"))
                return false;
          }
      }
      const auto* config = d.FindDict("config");
      if (d.contains("config") && (!config || !ServiceFields(*config, {"githubClientId", "bitbucketUser", "confluenceSite", "confluenceEmail", "googleClientId"})))
        return false;
      const auto* calendar = d.FindDict("calendar");
      if (d.contains("calendar") && (!calendar || !ServiceFields(*calendar, {"alertLead", "alertCondition", "showPreview", "showTimeToNext", "hiddenCalendarIds", "prompted"})))
        return false;
    } else if (name == "calendar") {
      if (!ServiceFields(d, {"access", "calendars", "events", "loading", "error", "lastFetch"}) ||
          !ServiceChildren(d, "calendars", "calendar") || !ServiceChildren(d, "events", "event"))
        return false;
    } else if (name == "alerts") {
      if (!ServiceFields(d, {"event"}) ||
          (d.Find("event") && !d.Find("event")->is_none() && !SafeServiceRecord(*d.Find("event"), "event")))
        return false;
    } else if (name == "sync") {
      if (!ServiceFields(d, {"status", "enabled", "folder", "types", "profiles", "lastSyncedAt",
                              "error", "pending", "devices", "remoteTabs", "remoteProfiles"}) ||
          !ServiceChildren(d, "profiles", "profile", true) ||
          !ServiceChildren(d, "devices", "device") ||
          !ServiceChildren(d, "remoteProfiles", "remoteProfile"))
        return false;
      const auto* types = d.FindDict("types");
      if (d.contains("types") && (!types || !ServiceFields(*types, {"bookmarks", "history", "tabs", "pinned", "passwords", "settings"})))
        return false;
      const auto* remote = d.FindDict("remoteTabs");
      if (d.contains("remoteTabs") && !remote) return false;
      if (remote)
        for (const auto [id, list] : *remote) {
          if (!list.is_list()) return false;
          for (const auto& item : list.GetList())
            if (!SafeServiceRecord(item, "remoteTabs")) return false;
        }
    }
  }
  return true;
}
bool BoundedJson(const base::Value& value, int depth = 0) {
  if (depth > 128) return false;
  if (value.is_double() && !std::isfinite(value.GetDouble())) return false;
  if (value.is_dict())
    for (const auto [key, child] : value.GetDict())
      if (!BoundedJson(child, depth + 1)) return false;
  if (value.is_list())
    for (const auto& child : value.GetList())
      if (!BoundedJson(child, depth + 1)) return false;
  return true;
}
bool Choice(const base::Value& value, std::initializer_list<std::string_view> choices) {
  if (!value.is_string()) return false;
  for (auto choice : choices) if (value.GetString() == choice) return true;
  return false;
}
bool ImportTabs(const base::Value* value) {
  if (!value || !value->is_list() || value->GetList().size() > 10000) return false;
  for (const auto& tab : value->GetList()) {
    if (!tab.is_dict()) return false;
    const auto& d = tab.GetDict();
    if (!CommandFields(d, {"url", "title", "pinned"}, {"customTitle"}) ||
        !CommandText(d, "url", 1024 * 1024, true) ||
        !CommandText(d, "title", 16384, true) || !d.FindBool("pinned").has_value() ||
        (d.contains("customTitle") && !CommandText(d, "customTitle", 16384, true))) return false;
  }
  return true;
}
bool ImportTree(const base::Value& value, int depth, size_t& count) {
  if (depth > 256 || ++count > 10000 || !value.is_dict()) return false;
  const auto& d = value.GetDict();
  const auto* type = d.Find("type");
  if (!CommandFields(d, {"type", "title"}, {"url", "dateAdded", "children", "role", "pageTitle"}) ||
      !type || !Choice(*type, {"url", "folder"}) || !CommandText(d, "title", 16384, true) ||
      (d.contains("url") && !CommandText(d, "url", 1024 * 1024, true)) ||
      (d.contains("pageTitle") && !CommandText(d, "pageTitle", 16384, true)) ||
      (d.contains("dateAdded") && !RuntimeInteger(d, "dateAdded")) ||
      (d.contains("role") && !Choice(*d.Find("role"), {"toolbar", "other", "mobile", "menu", "readingList"}))) return false;
  if (type->GetString() == "url" && (!d.contains("url") || d.contains("children"))) return false;
  if (const auto* children = d.Find("children")) {
    if (!children->is_list()) return false;
    for (const auto& child : children->GetList())
      if (!ImportTree(child, depth + 1, count)) return false;
  }
  return true;
}
bool ImportCommand(const base::DictValue& c) {
  const auto& method = *c.FindString("method");
  const auto encoded = base::WriteJson(c);
  if (!encoded || encoded->size() > 960000) return false;
  size_t count = 0;
  if (method == "importBookmarks")
    return CommandFields(c, {"method", "spaceId", "root", "browserName"}, {"parentId"}) &&
           CommandText(c, "browserName", 16384, true) && ImportTree(*c.Find("root"), 1, count);
  if (method == "importTabs")
    return CommandFields(c, {"method", "spaceId", "tabs", "group"}, {"afterId"}) && ImportTabs(c.Find("tabs")) &&
           (c.Find("group")->is_none() || CommandText(c, "group", 16384, true));
  if (method == "importHistory") {
    if (!CommandFields(c, {"method", "spaceId", "entries"}) || !c.FindList("entries") || c.FindList("entries")->size() > 10000) return false;
    for (const auto& entry : *c.FindList("entries")) {
      if (!entry.is_dict()) return false;
      const auto& e = entry.GetDict();
      if (!CommandFields(e, {"url", "title", "visits", "lastVisit"}) || !CommandText(e, "url", 1024 * 1024, true) ||
          !CommandText(e, "title", 16384, true) || !RuntimeInteger(e, "visits") || !RuntimeInteger(e, "lastVisit")) return false;
    }
    return true;
  }
  if (method == "importArcSpace") {
    const auto* space = c.FindDict("space");
    if (!CommandFields(c, {"method", "spaceId", "space"}) || !space ||
        !CommandFields(*space, {"pinned", "tabs"}) || !ImportTabs(space->Find("tabs")) || !space->FindList("pinned")) return false;
    for (const auto& node : *space->FindList("pinned")) if (!ImportTree(node, 1, count)) return false;
    return true;
  }
  if (method == "importDiaProfile") {
    const auto* profile = c.FindDict("profile");
    const auto* what = c.FindDict("what");
    return CommandFields(c, {"method", "spaceId", "profile", "what"}) && profile && what &&
           CommandFields(*profile, {"pinned", "tabs"}) && ImportTabs(profile->Find("pinned")) && ImportTabs(profile->Find("tabs")) &&
           CommandFields(*what, {"pinned", "open"}) && what->FindBool("pinned").has_value() && what->FindBool("open").has_value();
  }
  return false;
}
bool ServiceCommand(const base::DictValue& state, const std::string& window_id, const base::DictValue& c) {
  const auto* a = c.FindString("action");
  const auto* args = c.FindList("args");
  if (!CommandFields(c, {"method", "action", "args"}) || !a || !args || args->size() > 4) return false;
  const auto& action = *a;
  const auto& v = *args;
  const auto text = [&](size_t i, size_t max = 4096, bool nullable = false) {
    return i < v.size() && ((nullable && v[i].is_none()) || (v[i].is_string() && !v[i].GetString().empty() && v[i].GetString().size() <= max));
  };
  const auto boolean = [&](size_t i) { return i < v.size() && v[i].is_bool(); };
  const auto source = [&](size_t i) { return i < v.size() && Choice(v[i], {"github", "bitbucket", "notion", "confluence", "gdrive"}); };
  const auto own_window = [&](size_t i) { return text(i) && v[i].GetString() == window_id; };
  const auto public_space = [&](const std::string& id) { return !PrivateSpace(id) && state.FindDict("spaces")->contains(id); };
  const auto* services = state.FindDict("services");
  const auto* live = services ? services->FindDict("live") : nullptr;
  const auto* folders = live ? live->FindDict("folders") : nullptr;
  const auto folder = [&](size_t i) {
    const auto* d = text(i) && folders ? folders->FindDict(v[i].GetString()) : nullptr;
    const auto* space = d ? d->FindString("spaceId") : nullptr;
    return space && public_space(*space);
  };
  const auto strings = [&](const base::Value& value, size_t max = 4096) {
    if (!value.is_list() || value.GetList().size() > 10000) return false;
    for (const auto& item : value.GetList()) if (!item.is_string() || item.GetString().empty() || item.GetString().size() > max) return false;
    return true;
  };
  const auto patch = [&](size_t i, std::initializer_list<std::string_view> fields) {
    return i < v.size() && v[i].is_dict() && ServiceFields(v[i].GetDict(), fields);
  };
  if (action == "liveCreate") return v.size() == 2 && own_window(0) && Choice(v[1], {"pullRequests", "documents"});
  if (action == "liveRemove" || action == "liveRefresh") return v.size() == 1 && folder(0);
  if (action == "liveUpdate") {
    if (v.size() != 2 || !folder(0) || !patch(1, {"name", "icon", "collapsed", "sources", "filters"})) return false;
    const auto& p = v[1].GetDict();
    if ((p.contains("name") && !CommandText(p, "name", 1024, true)) ||
        (p.contains("icon") && !p.Find("icon")->is_none() && !CommandText(p, "icon", 1024, true)) ||
        (p.contains("collapsed") && !p.FindBool("collapsed").has_value())) return false;
    if (const auto* sources = p.Find("sources")) {
      if (!strings(*sources)) return false;
      for (const auto& s : sources->GetList()) if (!Choice(s, {"github", "bitbucket", "notion", "confluence", "gdrive"})) return false;
    }
    if (const auto* filters = p.Find("filters"))
      return filters->is_dict() && CommandFields(filters->GetDict(), {"authored", "reviewRequests"}) &&
             filters->GetDict().FindBool("authored").has_value() && filters->GetDict().FindBool("reviewRequests").has_value();
    return true;
  }
  if (action == "liveMove") return v.size() == 2 && folder(0) && v[1].is_int() && (v[1].GetInt() == -1 || v[1].GetInt() == 1);
  if (action == "liveRead") return v.size() == 2 && folder(0) && (v[1].is_none() || strings(v[1]));
  if (action == "liveUnread") return v.size() == 2 && folder(0) && text(1);
  if (action == "liveOpen") return v.size() == 4 && own_window(0) && folder(1) && text(2) && boolean(3);
  if (action == "liveView") return v.size() == 3 && Choice(v[0], {"expandedStacks", "showAll"}) && text(1) && boolean(2);
  if (action == "liveConfig") {
    if (v.size() != 1 || !patch(0, {"githubClientId", "bitbucketUser", "confluenceSite", "confluenceEmail", "googleClientId"})) return false;
    for (const auto [key, value] : v[0].GetDict()) if (!value.is_string() || value.GetString().size() > 4096) return false;
    return true;
  }
  if (action == "liveConnect") {
    if (v.size() != 2 || !source(0) || !strings(v[1], 65536)) return false;
    const auto& id = v[0].GetString();
    return v[1].GetList().size() == (id == "github" || id == "notion" ? 1u : id == "bitbucket" ? 2u : id == "confluence" ? 3u : 99u);
  }
  if (action == "liveDisconnect") return v.size() == 1 && source(0);
  if (action == "githubStart" || action == "githubWait" || action == "githubCancel" || action == "alertDismiss" ||
      action == "setSyncFolder" || action == "turnOnSync" || action == "addRemoteProfile") return v.size() == 1 && text(0);
  if (action == "folderInfo") return v.size() == 1 && text(0, 4096, true);
  if (action == "googleConnect") return v.size() == 3 && own_window(0) && text(1) && text(2, 65536);
  if (action == "calendarSettings") {
    if (v.size() != 1 || !patch(0, {"alertLead", "alertCondition", "showPreview", "showTimeToNext", "hiddenCalendarIds", "prompted"})) return false;
    for (const auto [key, value] : v[0].GetDict()) {
      if (key == "alertLead") { if (!Choice(value, {"never", "start", "1", "2", "3", "5", "10"})) return false; }
      else if (key == "alertCondition") { if (!Choice(value, {"always", "activeOnly"})) return false; }
      else if (key == "hiddenCalendarIds") { if (!strings(value)) return false; }
      else if (!value.is_bool()) return false;
    }
    return true;
  }
  if (action == "telemetrySetSharing") return v.size() == 2 && boolean(0) && Choice(v[1], {"settings", "onboarding", "ask"});
  if (action == "telemetryDismissAsk") return v.empty();
  if (action == "calendarRefresh" || action == "calendarConnect" || action == "syncNow") return v.empty();
  if (action == "calendarHidden") return v.size() == 2 && text(0) && boolean(1);
  if (action == "alertJoin") return v.size() == 3 && own_window(0) && text(1) && boolean(2);
  if (action == "meetingGroup") {
    const auto* tab = text(0) ? state.FindDict("tabs")->FindDict(v[0].GetString()) : nullptr;
    return v.size() == 2 && tab && tab->FindString("windowId") && *tab->FindString("windowId") == window_id &&
           public_space(*tab->FindString("spaceId")) && text(1, 4096, true);
  }
  if (action == "enterRecoveryPhrase") return v.size() == 2 && text(0) && text(1);
  if (action == "stopSync") return v.size() == 1 && patch(0, {"deleteData"}) &&
      (!v[0].GetDict().contains("deleteData") || v[0].GetDict().FindBool("deleteData").has_value());
  if (action == "setTypeSynced") return v.size() == 2 && Choice(v[0], {"bookmarks", "history", "tabs", "pinned", "passwords", "settings"}) && boolean(1);
  if (action == "setProfileSynced") return v.size() == 2 && text(0) && public_space(v[0].GetString()) && boolean(1);
  return false;
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
  if (base::StartsWith(*method, "import"))
    return RuntimeResultKind::kImport;
  if (*method == "serviceAction") {
    const auto* action = command.FindString("action");
    if (!action) return RuntimeResultKind::kNone;
    if (*action == "liveCreate" || *action == "liveOpen" || *action == "meetingGroup" || *action == "addRemoteProfile") return RuntimeResultKind::kOptionalId;
    if (*action == "calendarConnect") return RuntimeResultKind::kBoolean;
    if (*action == "githubStart") return RuntimeResultKind::kGithub;
    if (*action == "turnOnSync" || *action == "enterRecoveryPhrase") return RuntimeResultKind::kSync;
    if (*action == "folderInfo") return RuntimeResultKind::kFolder;
  }
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
  if (result_kind == RuntimeResultKind::kImport && value) {
    const auto* result = value->is_dict() ? &value->GetDict() : nullptr;
    const auto count = result ? RuntimeInteger(*result, "count") : std::nullopt;
    if (!result || !CommandFields(*result, {"count"}, {"tabIds", "bookmarkIds"}) || !count)
      return false;
    for (const char* key : {"tabIds", "bookmarkIds"}) {
      const auto* ids = result->Find(key);
      if (!ids) continue;
      if (!ids->is_list() || ids->GetList().size() > 10000) return false;
      for (const auto& id : ids->GetList())
        if (!id.is_string() || id.GetString().empty() || id.GetString().size() > 1024) return false;
    }
  }
  bool service_result = false;
  const auto* object = value && value->is_dict() ? &value->GetDict() : nullptr;
  if (result_kind == RuntimeResultKind::kBoolean)
    service_result = value && value->is_bool();
  if (result_kind == RuntimeResultKind::kGithub)
    service_result = object && CommandFields(*object, {"id", "userCode", "verificationUri", "expiresAt"}) &&
                     CommandText(*object, "id", 4096) && CommandText(*object, "userCode", 4096) &&
                     CommandText(*object, "verificationUri", 4096) && object->FindDouble("expiresAt").has_value();
  if (result_kind == RuntimeResultKind::kSync && object) {
    service_result = CommandFields(*object, {"ok"}) && object->FindBool("ok").value_or(false);
    if (CommandFields(*object, {"error"}, {"count", "word"}) && CommandText(*object, "error", 4096))
      service_result = (!object->contains("count") || (RuntimeInteger(*object, "count") && *RuntimeInteger(*object, "count") <= 10000)) &&
                       (!object->contains("word") || CommandText(*object, "word", 4096));
  }
  if (result_kind == RuntimeResultKind::kFolder)
    service_result = value && value->is_none();
  if (result_kind == RuntimeResultKind::kFolder && object) {
    service_result = CommandFields(*object, {"path", "defaultPath", "iCloudAvailable", "inICloud", "exists", "writable", "hasSyncData"}) &&
                     CommandText(*object, "path", 4096) && CommandText(*object, "defaultPath", 4096);
    for (const auto* key : {"iCloudAvailable", "inICloud", "exists", "writable", "hasSyncData"})
      service_result &= object->FindBool(key).has_value();
  }
  const auto encoded = value ? base::WriteJson(*value) : std::nullopt;
  const bool json_result = (service_result || result_kind == RuntimeResultKind::kImport) && value &&
      BoundedJson(*value) && encoded && encoded->size() <= 1024 * 1024;
  return reply.size() == 3 && revision && *revision >= minimum_revision &&
         *revision <= accepted_revision && value &&
         (json_result || (value->is_none() && (result_kind == RuntimeResultKind::kNone || result_kind == RuntimeResultKind::kOptionalId)) ||
          ((result_kind == RuntimeResultKind::kRequiredId || result_kind == RuntimeResultKind::kOptionalId) && value->is_string() &&
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
  if (!SafeServices(*state.FindDict("services")))
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
  // Service records share the same visibility rules as browser records.
  auto* services = result.FindDict("services");
  if (auto* live = services->FindDict("live")) {
    std::set<std::string> live_folders;
    if (auto* records = live->FindDict("folders")) {
      for (const auto [id, value] : *records) {
        const auto* space = value.GetDict().FindString("spaceId");
        if (space && !PrivateSpace(*space) && result.FindDict("spaces")->contains(*space))
          live_folders.emplace(id);
      }
      FilterRecord(*live, "folders", live_folders);
    }
    for (const auto* key : {"items", "known", "unread", "completed", "completing",
                             "status"})
      if (live->FindDict(key)) FilterRecord(*live, key, live_folders);
    if (auto* order = live->FindList("folderOrder")) FilterList(*order, live_folders);
    if (auto* shown = live->FindDict("showAll")) {
      std::set<std::string> allowed;
      for (const auto [key, value] : *shown)
        for (const auto& id : live_folders)
          if (key == id || base::StartsWith(key, id + ":")) allowed.emplace(key);
      FilterRecord(*live, "showAll", allowed);
    }
    if (auto* groups = live->FindDict("meetingGroups")) {
      std::set<std::string> allowed;
      for (const auto [id, value] : *groups) {
        const auto* group = value.GetDict().FindString("groupId");
        const auto* call = value.GetDict().FindString("callTabId");
        if (group && call && result.FindDict("groups")->contains(*group) && tabs.contains(*call))
          allowed.emplace(id);
      }
      FilterRecord(*live, "meetingGroups", allowed);
    }
  }
  if (auto* sync = services->FindDict("sync")) {
    std::set<std::string> spaces;
    for (const auto [id, value] : *result.FindDict("spaces")) spaces.emplace(id);
    for (const auto* key : {"profiles", "remoteTabs"})
      if (sync->FindDict(key)) FilterRecord(*sync, key, spaces);
  }
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
  const auto index = [&](const char* field, double minimum = 0) {
    const auto value = command.FindDouble(field);
    return value && std::isfinite(*value) && std::floor(*value) == *value &&
           *value >= minimum && *value <= 1000000;
  };
  const auto* kind = own_window->FindString("kind");
  const bool harbor = kind && *kind == "small";
  constexpr size_t kMaximumInput = 1024 * 1024;
  // The read-only access check: what the window's projection lists. Tab and
  // organize commands act on a space's shared list, so a public main window
  // may name public tabs another main window shows or none has loaded yet; a
  // private window or a Little Bay only names its own. Commands about the page
  // a window shows (find, page history, source tabs) still use own_tab.
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
  if (*method == "serviceAction")
    return !is_private && ServiceCommand(state, window_id, command);
  if (base::StartsWith(*method, "import")) {
    if (is_private || harbor || !public_space(command, "spaceId") || !ImportCommand(command)) return false;
    if (const auto* id = command.Find("afterId")) {
      const auto* tab = id->is_string() ? tabs->FindDict(id->GetString()) : nullptr;
      if (!tab || !visible_tab(id->GetString()) || *tab->FindString("spaceId") != *command.FindString("spaceId")) return false;
    }
    if (const auto* id = command.Find("parentId")) {
      const auto* nodes = state.FindDict("bookmarks")->FindDict("nodes");
      const auto* node = id->is_string() ? nodes->FindDict(id->GetString()) : nullptr;
      const auto* kind = node ? node->FindString("kind") : nullptr;
      if (!kind || *kind != "folder") return false;
      const auto* roots = state.FindDict("bookmarks")->FindDict("roots")->FindDict(*command.FindString("spaceId"));
      if (!roots) return false;
      std::set<std::string> seen;
      std::string current = id->GetString();
      bool found = false;
      while (seen.insert(current).second) {
        for (const auto [key, root] : *roots)
          if (root.is_string() && root.GetString() == current) found = true;
        if (found) break;
        const auto* item = nodes->FindDict(current);
        const auto* parent = item ? item->FindString("parentId") : nullptr;
        if (!parent) break;
        current = *parent;
      }
      if (!found) return false;
    }
    return true;
  }
  // Waking warms any tab the window can list; the others act on the page this
  // window shows, which it owns.
  if (*method == "wakeTab")
    return CommandFields(command, {"method", "tabId"}) &&
           visible_field(command, "tabId");
  if (*method == "syncInternalPage" || *method == "hideNewTab" ||
      *method == "showNewTab") {
    if (!own_tab("tabId") ||
        !CommandFields(command, {"method", "tabId"},
                       *method == "showNewTab"
                           ? std::initializer_list<std::string_view>{"first"}
                           : std::initializer_list<std::string_view>{}))
      return false;
    const auto* first = command.FindDict("first");
    return !command.contains("first") ||
           (first && CommandFields(*first, {"url", "title"}) &&
            CommandText(*first, "url", kMaximumInput, true) &&
            CommandText(*first, "title", 4096, true));
  }
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
    } else if (!visible_field(command, "tabId")) {
      // A space's list is shared by its public windows, so a sidebar may act
      // on a tab another one last showed, or none has loaded yet.
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
    return CommandFields(command, {"method", "tabIds"}) && visible_tabs(command);
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
           visible_field(command, "tabId") && !is_private &&
           public_space(command, "spaceId");
  if (*method == "moveTabsToWindow") {
    if (!CommandFields(command, {"method", "tabIds", "windowId"}) ||
        !visible_tabs(command))
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
        (options->contains("tabIds") && !visible_tabs(*options)))
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
  // A window's own panels and find bar, and the downloads its list shows.
  if (*method == "setDownloadsOpen")
    return CommandFields(command, {"method", "windowId", "open"}) &&
           own_target() && command.FindBool("open");
  if (*method == "clearDownloads")
    return CommandFields(command, {"method", "windowId"}) && own_target();
  if (*method == "removeDownload") {
    const auto* id = command.FindString("downloadId");
    if (!CommandFields(command, {"method", "windowId", "downloadId"}) ||
        !own_target() || !id)
      return false;
    const std::string& own_space = *own_window->FindString("spaceId");
    for (const auto& value : *state.FindList("downloads")) {
      const auto* download = value.is_dict() ? &value.GetDict() : nullptr;
      const auto* download_id = download ? download->FindString("id") : nullptr;
      if (!download_id || *download_id != *id)
        continue;
      const auto* profile = download->FindString("profile");
      return is_private ? profile && *profile == own_space
                        : !(profile && PrivateSpace(*profile));
    }
    return false;
  }
  if (*method == "setFind") {
    const auto* patch = command.FindDict("patch");
    return CommandFields(command, {"method", "tabId", "patch"}) &&
           own_tab("tabId") && patch &&
           CommandFields(*patch, {},
                         {"open", "query", "count", "active", "focusRequest",
                          "replace"});
  }
  if (*method == "updateTabDetails") {
    const auto* patch = command.FindDict("patch");
    return CommandFields(command, {"method", "tabId", "patch"}) &&
           visible_field(command, "tabId") && patch &&
           CommandFields(*patch, {}, {"customTitle", "customIcon", "kept"});
  }
  return false;
}

bool CanAcceptRuntimePageEvent(const base::DictValue& state,
                               const std::string& tab_id,
                               const std::string& profile) {
  const auto* tabs = state.FindDict("tabs");
  const auto* tab = tabs && !tab_id.empty() ? tabs->FindDict(tab_id) : nullptr;
  const auto* space_id = tab ? tab->FindString("spaceId") : nullptr;
  if (!space_id)
    return false;
  if (PrivateSpace(*space_id)) {
    const auto* windows = state.FindDict("windows");
    const auto* owner = tab->FindString("windowId");
    const auto* window = windows && owner ? windows->FindDict(*owner) : nullptr;
    return profile == *space_id && owner && profile == "incognito:" + *owner &&
           window && window->FindBool("incognito").value_or(false) &&
           window->FindString("spaceId") &&
           *window->FindString("spaceId") == profile;
  }
  const auto* spaces = state.FindDict("spaces");
  const auto* space = spaces ? spaces->FindDict(*space_id) : nullptr;
  if (!space || PrivateSpace(profile))
    return false;
  const auto* native_profile = space->FindString("profileId");
  const auto& expected =
      native_profile && !native_profile->empty() ? *native_profile : *space_id;
  return profile == (expected == "default" ? "" : expected);
}
bool CanMountRuntimePage(const base::DictValue& state,
                         const std::string& window_id,
                         const std::string& tab_id,
                         const std::string& profile) {
  if (window_id.empty() || !CanAcceptRuntimePageEvent(state, tab_id, profile))
    return false;
  const auto* tab = state.FindDict("tabs")->FindDict(tab_id);
  const auto* owner = tab->FindString("windowId");
  return owner && *owner == window_id;
}
bool CanMountRuntimePageOffer(const base::DictValue& state,
                              const std::string& tab_id,
                              const std::string& adopt_id) {
  const auto* tabs = state.FindDict("tabs");
  const auto* tab = tabs ? tabs->FindDict(tab_id) : nullptr;
  if (!tab)
    return false;
  const auto* adopted = tab->FindString("adoptId");
  const auto* wake = tab->FindString("wakeAdoptId");
  if (adopt_id.empty())
    return (!adopted || adopted->empty()) && (!wake || wake->empty());
  return (adopted && *adopted == adopt_id) || (wake && *wake == adopt_id);
}
std::optional<RuntimePageOpenTarget> FindRuntimePageOpenTarget(
    const base::DictValue& state,
    const std::string& offer_id,
    const std::string& profile,
    bool incognito) {
  if (offer_id.empty())
    return std::nullopt;
  const auto* tabs = state.FindDict("tabs");
  if (!tabs)
    return std::nullopt;
  std::optional<RuntimePageOpenTarget> target;
  for (const auto [id, value] : *tabs) {
    if (!value.is_dict())
      continue;
    const auto& tab = value.GetDict();
    const auto* adopted = tab.FindString("adoptId");
    const auto* wake = tab.FindString("wakeAdoptId");
    if ((!adopted || *adopted != offer_id) && (!wake || *wake != offer_id))
      continue;
    if (target || tab.FindBool("unloaded").value_or(false))
      return std::nullopt;
    const auto* owner = tab.FindString("windowId");
    const std::string expected = incognito && owner ? "incognito:" + *owner
                                                    : profile;
    if (!owner || !CanMountRuntimePage(state, *owner, std::string(id), expected))
      return std::nullopt;
    const auto* windows = state.FindDict("windows");
    const auto* window = windows ? windows->FindDict(*owner) : nullptr;
    if (!window || window->FindBool("incognito").value_or(false) != incognito)
      return std::nullopt;
    target = RuntimePageOpenTarget{std::string(id), *owner, expected};
  }
  return target;
}
std::optional<base::DictValue> RuntimePageEventCache::Record(
    const base::DictValue& state,
    const std::string& tab_id,
    const std::string& profile,
    int browser_id,
    const char* event,
    base::DictValue payload) {
  static constexpr const char* kEvents[] = {"onNavigationChange",
                                            "onProgress",
                                            "onFavicon",
                                            "onMedia",
                                            "onZoom",
                                            "onFindResult",
                                            "onDownloadNavigation",
                                            "onDiscarded",
                                            "onLoadError"};
  if (browser_id <= 0 || !CanAcceptRuntimePageEvent(state, tab_id, profile) ||
      std::ranges::find(kEvents, std::string_view(event)) ==
          std::end(kEvents) ||
      sequence_ >= 9007199254740991.0)
    return std::nullopt;
  // Native URLs can be large. Bound the cached transport payload as well as
  // the number of pages so a disconnected coordinator cannot grow memory.
  const auto encoded = base::WriteJson(payload);
  if (!encoded || encoded->size() > 256 * 1024)
    return std::nullopt;
  auto existing = facts_.find(tab_id);
  if (existing != facts_.end() && !existing->second.empty() &&
      existing->second.begin()->second.envelope.FindInt("browserId") !=
          browser_id)
    Remove(tab_id);
  const auto erase_fact = [&](const char* name) {
    auto page = facts_.find(tab_id);
    if (page == facts_.end())
      return;
    auto fact = page->second.find(name);
    if (fact != page->second.end()) {
      bytes_ -= fact->second.bytes;
      page->second.erase(fact);
    }
  };
  if (std::string_view(event) == "onNavigationChange") {
    auto page = facts_.find(tab_id);
    const base::DictValue* previous = nullptr;
    if (page != facts_.end()) {
      auto navigation = page->second.find("onNavigationChange");
      if (navigation != page->second.end())
        previous = navigation->second.envelope.FindDict("payload");
    }
    const auto* old_url = previous ? previous->FindString("url") : nullptr;
    const auto* url = payload.FindString("url");
    // Terminal facts from an earlier navigation must not affect the new page
    // when a replacement coordinator consumes the replay.
    if (payload.FindBool("isLoading").value_or(false) ||
        (old_url && url && *old_url != *url)) {
      erase_fact("onDownloadNavigation");
      erase_fact("onDiscarded");
      erase_fact("onLoadError");
    }
  }
  erase_fact(event);
  const size_t bytes = encoded->size() + tab_id.size() + profile.size() +
                       std::string_view(event).size() + 256;
  constexpr size_t kMaximumBytes = 16 * 1024 * 1024;
  while ((!facts_.contains(tab_id) && facts_.size() >= kMaximumTabs) ||
         bytes_ + bytes > kMaximumBytes) {
    auto oldest = facts_.begin();
    double oldest_sequence = sequence_;
    for (auto it = facts_.begin(); it != facts_.end(); ++it) {
      double newest = 0;
      for (const auto& [name, fact] : it->second)
        newest = std::max(newest, *fact.envelope.FindDouble("sequence"));
      if (newest < oldest_sequence) {
        oldest_sequence = newest;
        oldest = it;
      }
    }
    Remove(oldest->first);
  }
  auto envelope = base::DictValue()
                      .Set("tabId", tab_id)
                      .Set("profile", profile)
                      .Set("browserId", browser_id)
                      .Set("sequence", ++sequence_)
                      .Set("event", event)
                      .Set("payload", std::move(payload));
  facts_[tab_id].insert_or_assign(event, Fact{envelope.Clone(), bytes});
  bytes_ += bytes;
  return envelope;
}
void RuntimePageEventCache::Prune(const base::DictValue& state) {
  std::vector<std::string> remove;
  for (const auto& [id, facts] : facts_) {
    const auto* profile =
        facts.empty() ? nullptr
                      : facts.begin()->second.envelope.FindString("profile");
    if (!profile || !CanAcceptRuntimePageEvent(state, id, *profile))
      remove.push_back(id);
  }
  for (const auto& id : remove)
    Remove(id);
}
std::vector<base::DictValue> RuntimePageEventCache::Replay(
    const base::DictValue& state) {
  Prune(state);
  std::vector<base::DictValue> result;
  for (const auto& [id, facts] : facts_)
    for (const auto& [event, fact] : facts)
      result.push_back(fact.envelope.Clone());
  std::ranges::sort(result, [](const auto& first, const auto& second) {
    return *first.FindDouble("sequence") < *second.FindDouble("sequence");
  });
  return result;
}
void RuntimePageEventCache::Remove(const std::string& tab_id) {
  auto page = facts_.find(tab_id);
  if (page == facts_.end())
    return;
  for (const auto& [event, fact] : page->second)
    bytes_ -= fact.bytes;
  facts_.erase(page);
}

}  // namespace bay
