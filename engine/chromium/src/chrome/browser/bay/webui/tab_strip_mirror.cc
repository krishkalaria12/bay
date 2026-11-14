// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/tab_strip_mirror.h"

#include <algorithm>
#include <cmath>
#include <set>
#include <utility>
#include <vector>

#include "base/json/json_writer.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/bay/webui/app_runtime.h"
#include "chrome/browser/bay/webui/download_controls.h"
#include "chrome/browser/bay/webui/host_context.h"
#include "chrome/browser/bay/webui/tab_broker.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_group_model.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/sessions/content/session_tab_helper.h"
#include "components/tab_groups/tab_group_color.h"
#include "components/tab_groups/tab_group_id.h"
#include "components/tab_groups/tab_group_visual_data.h"
#include "components/tabs/public/tab_group.h"
#include "content/public/browser/web_contents.h"

namespace bay {
namespace {
constexpr const char* kColors[] = {"grey", "blue",   "red",  "yellow", "green",
                                   "pink", "purple", "cyan", "orange"};
constexpr size_t kMaximumKeys = 10000;

std::optional<tab_groups::TabGroupColorId> ColorNamed(const std::string& name) {
  for (size_t i = 0; i < std::size(kColors); ++i)
    if (name == kColors[i])
      return static_cast<tab_groups::TabGroupColorId>(i);
  return std::nullopt;
}
const char* ColorName(tab_groups::TabGroupColorId color) {
  const int i = static_cast<int>(color);
  return i >= 0 && i < static_cast<int>(std::size(kColors)) ? kColors[i]
                                                            : "grey";
}
std::optional<tab_groups::TabGroupId> GroupNamed(TabStripModel* model,
                                                 const std::string& token) {
  if (model->SupportsTabGroups())
    for (auto id : model->group_model()->ListTabGroups())
      if (id.ToString() == token)
        return id;
  return std::nullopt;
}
std::string Reply(base::Value value = base::Value()) {
  return base::WriteJson(base::DictValue().Set("value", std::move(value)))
      .value_or("{}");
}
std::string Failure(const char* code, const char* message) {
  return base::WriteJson(
             base::DictValue().Set(
                 "error",
                 base::DictValue().Set("code", code).Set("message", message)))
      .value_or("{}");
}
// Private strips use the owning window's private-space id, never a profile's
// on-disk directory or Chrome's OTR id.
std::optional<std::string> ProfileId(BrowserWindowInterface* browser) {
  auto& windows = WindowRegistry::Get();
  if (!browser || windows.IdFor(browser).empty() || windows.IsUtility(browser))
    return std::nullopt;
  if (browser->GetProfile()->IsOffTheRecord())
    return "incognito:" + windows.IdFor(browser);
  return DownloadControls::ProfileId(browser->GetProfile());
}
base::DictValue Describe(BrowserWindowInterface* browser,
                         const std::string& profile,
                         bool picked_on_close) {
  auto* model = browser->GetTabStripModel();
  base::ListValue tabs;
  for (int i = 0; i < model->count(); ++i) {
    auto* contents = model->GetWebContentsAt(i);
    const auto key = TabBroker::Get().KeyFor(contents);
    const auto group = model->GetTabGroupForTab(i);
    tabs.Append(
        base::DictValue()
            .Set("key", key.empty() ? base::Value() : base::Value(key))
            .Set("browser", sessions::SessionTabHelper::IdForTab(contents).id())
            .Set("index", i)
            .Set("active", i == model->active_index())
            .Set("pinned", model->IsTabPinned(i))
            .Set("group",
                 group ? base::Value(group->ToString()) : base::Value()));
  }
  base::ListValue groups;
  if (model->SupportsTabGroups()) {
    for (auto id : model->group_model()->ListTabGroups()) {
      const auto* visuals =
          model->group_model()->GetTabGroup(id)->visual_data();
      groups.Append(base::DictValue()
                        .Set("id", id.ToString())
                        .Set("title", base::UTF16ToUTF8(visuals->title()))
                        .Set("color", ColorName(visuals->color()))
                        .Set("collapsed", visuals->is_collapsed()));
    }
  }
  auto* frame = WindowRegistry::Get().FrameOf(browser);
  return base::DictValue()
      .Set("strip", browser->GetSessionID().id())
      .Set("window", frame->GetSessionID().id())
      .Set("appWindow", WindowRegistry::Get().IdFor(browser))
      .Set("profile", profile)
      .Set("tabs", std::move(tabs))
      .Set("groups", std::move(groups))
      .Set("activePickedOnClose", picked_on_close);
}

// Identity is resolved afresh after each move because pinning and grouping can
// move a tab too. No renderer-supplied index is trusted.
int IndexOfKey(TabStripModel* model, const std::string& key) {
  for (int i = 0; i < model->count(); ++i)
    if (!key.empty() &&
        TabBroker::Get().KeyFor(model->GetWebContentsAt(i)) == key)
      return i;
  return TabStripModel::kNoTab;
}
std::optional<std::vector<std::string>> Keys(const base::DictValue& command) {
  const auto* list = command.FindList("keys");
  if (!list || list->size() > kMaximumKeys)
    return std::nullopt;
  std::set<std::string> seen;
  std::vector<std::string> keys;
  for (const auto& value : *list) {
    const auto* key = value.GetIfString();
    if (!key || key->empty() || key->size() > 1024 || !seen.insert(*key).second)
      return std::nullopt;
    keys.push_back(*key);
  }
  return keys;
}
}  // namespace

TabStripMirror& TabStripMirror::Get() {
  static base::NoDestructor<TabStripMirror> mirror;
  return *mirror;
}
TabStripMirror::TabStripMirror() = default;
TabStripMirror::~TabStripMirror() = default;

TabStripMirror::AppChange::AppChange() {
  ++Get().app_depth_;
}
TabStripMirror::AppChange::~AppChange() {
  auto& mirror = Get();
  if (--mirror.app_depth_ == 0 && mirror.pending_ && !mirror.command_)
    mirror.Flush();
}
void TabStripMirror::Start(Sink sink) {
  sink_ = std::move(sink);
  if (started_)
    return;
  started_ = true;
  observation_.Observe(GlobalBrowserCollection::GetInstance());
  GlobalBrowserCollection::GetInstance()->ForEach(
      [this](BrowserWindowInterface* browser) {
        Watch(browser);
        return true;
      });
}
void TabStripMirror::Watch(BrowserWindowInterface* browser) {
  if (auto* model = browser->GetTabStripModel();
      model && !picked_on_close_.contains(model)) {
    picked_on_close_[model] = false;
    model->AddObserver(this);
  }
}
void TabStripMirror::Refresh() {
  if (!started_)
    return;
  pending_ = true;
  app_changed_ |= app_depth_ > 0;
  if (app_depth_ == 0 && !command_)
    Flush();
}
base::DictValue TabStripMirror::Snapshot() {
  base::ListValue strips;
  GlobalBrowserCollection::GetInstance()->ForEach(
      [this, &strips](BrowserWindowInterface* browser) {
        auto profile = ProfileId(browser);
        if (profile && browser->GetTabStripModel()) {
          Watch(browser);
          auto strip = Describe(browser, *profile,
                                picked_on_close_[browser->GetTabStripModel()]);
          strips.Append(std::move(strip));
        }
        return true;
      });
  return base::DictValue()
      .Set("rev", static_cast<double>(revision_))
      .Set("cmd", base::Value())
      .Set("strips", std::move(strips));
}
void TabStripMirror::Flush(bool command_reply, bool rejected) {
  if (!started_ || (!command_reply && (app_depth_ > 0 || command_)))
    return;
  base::ListValue changed;
  std::map<int, base::DictValue> current;
  GlobalBrowserCollection::GetInstance()->ForEach(
      [this, &current, &changed,
       command_reply](BrowserWindowInterface* browser) {
        auto profile = ProfileId(browser);
        if (profile && browser->GetTabStripModel()) {
          const int id = browser->GetSessionID().id();
          auto strip = Describe(browser, *profile,
                                picked_on_close_[browser->GetTabStripModel()]);
          auto before = sent_.find(id);
          if (before == sent_.end() || before->second != strip ||
              (command_reply && command_strip_ == id))
            changed.Append(strip.Clone());
          current.emplace(id, std::move(strip));
        }
        return true;
      });
  for (const auto& [id, before] : sent_) {
    if (current.contains(id))
      continue;
    auto closed = before.Clone();
    closed.Set("closed", true);
    closed.Set("tabs", base::ListValue());
    closed.Set("groups", base::ListValue());
    changed.Append(std::move(closed));
  }
  sent_ = std::move(current);
  pending_ = false;
  const bool app_changed = std::exchange(app_changed_, false);
  if (changed.empty() && !command_reply)
    return;
  auto tx = base::DictValue()
                .Set("rev", static_cast<double>(++revision_))
                .Set("cmd", command_      ? base::Value(*command_)
                            : app_changed ? base::Value(-1)
                                          : base::Value())
                .Set("strips", std::move(changed));
  if (rejected)
    tx.Set("rejected", true);
  if (sink_)
    sink_.Run(std::move(tx));
}
BrowserWindowInterface* TabStripMirror::FindStrip(int id) const {
  auto* browser = GlobalBrowserCollection::GetInstance()->FindBrowserWithID(
      SessionID::FromSerializedValue(id));
  return browser && ProfileId(browser) ? browser : nullptr;
}

bool TabStripMirror::Dispatch(const HostContext& context,
                              const std::string& method,
                              const base::ListValue& args,
                              Response& response) {
  if (method != "tabStrips" && method != "tabStripCommand")
    return false;
  if (!context.profile() || context.is_window()) {
    std::move(response).Run(
        Failure("permission_denied", "Tab strips belong to the coordinator"));
    return true;
  }
  if (method == "tabStrips") {
    if (!args.empty())
      std::move(response).Run(Failure("invalid_args", "No arguments expected"));
    else
      std::move(response).Run(Reply(base::Value(Snapshot())));
    return true;
  }
  const auto* spec = args.size() == 2 ? args[1].GetIfDict() : nullptr;
  const double id = args.empty() || (!args[0].is_int() && !args[0].is_double())
                        ? 0
                        : args[0].GetDouble();
  if (!spec || !std::isfinite(id) || id <= 0 || std::floor(id) != id ||
      id > 9007199254740991.0 || !spec->FindInt("strip") ||
      !spec->FindString("op")) {
    std::move(response).Run(
        Failure("invalid_args", "Invalid tab strip command"));
    return true;
  }
  command_ = id;
  command_strip_ = *spec->FindInt("strip");
  auto* browser = FindStrip(*command_strip_);
  const bool accepted = browser && Apply(browser, *spec);
  // Every command is acknowledged, even when its strip or tabs disappeared.
  Flush(true, !accepted);
  command_.reset();
  command_strip_.reset();
  std::move(response).Run(Reply());
  return true;
}

bool TabStripMirror::Apply(BrowserWindowInterface* browser,
                           const base::DictValue& command) {
  auto* model = browser->GetTabStripModel();
  const auto& op = *command.FindString("op");
  if (op == "activate") {
    const auto* key = command.FindString("key");
    const int index = key ? IndexOfKey(model, *key) : TabStripModel::kNoTab;
    if (index == TabStripModel::kNoTab)
      return false;
    model->ActivateTabAt(index);
    return true;
  }
  auto keys = Keys(command);
  if (!keys || (op != "arrange" && op != "group"))
    return false;
  // A partially stale command still applies to surviving keys, as on macOS.
  std::vector<std::string> found;
  for (const auto& key : *keys)
    if (IndexOfKey(model, key) != TabStripModel::kNoTab)
      found.push_back(key);
  if (!keys->empty() && found.empty())
    return false;
  if (op == "arrange") {
    const auto pinned = command.FindInt("pinned");
    if (!pinned || *pinned < 0 || *pinned > static_cast<int>(keys->size()))
      return false;
    int placed = 0;
    for (size_t i = 0; i < keys->size(); ++i) {
      int index = IndexOfKey(model, (*keys)[i]);
      if (index == TabStripModel::kNoTab)
        continue;
      const bool pin = static_cast<int>(i) < *pinned;
      model->SetTabPinned(index, pin);
      index = IndexOfKey(model, (*keys)[i]);
      // MoveWebContentsAt preserves group contiguity and never activates.
      model->MoveWebContentsAt(index, placed++, false);
    }
    return true;
  }
  if (!model->SupportsTabGroups() || found.empty())
    return false;
  const auto* value = command.Find("group");
  if (!value || (!value->is_none() && !value->is_string()))
    return false;
  const std::string token = value->is_none() ? "" : value->GetString();
  std::optional<tab_groups::TabGroupId> group;
  if (!token.empty() && token != "new") {
    group = GroupNamed(model, token);
    if (!group)
      return false;
  }
  const auto* color = command.FindString("color");
  const auto* title = command.FindString("title");
  const auto collapsed = command.FindBool("collapsed");
  if ((command.contains("title") && !title) ||
      (command.contains("color") && (!color || !ColorNamed(*color))) ||
      (command.contains("collapsed") && !collapsed))
    return false;
  std::vector<int> indices;
  for (const auto& key : found) {
    const int index = IndexOfKey(model, key);
    if (!model->IsTabPinned(index))
      indices.push_back(index);
  }
  if (indices.empty())
    return false;
  std::sort(indices.begin(), indices.end());
  if (token.empty()) {
    model->RemoveFromGroup(indices);
    return true;
  }
  if (token == "new")
    group = model->AddToNewGroup(indices);
  else
    model->AddToExistingGroup(indices, *group);
  if (title || color || collapsed) {
    const auto* now = model->group_model()->GetTabGroup(*group)->visual_data();
    model->ChangeTabGroupVisuals(
        *group, tab_groups::TabGroupVisualData(
                    title ? base::UTF8ToUTF16(*title) : now->title(),
                    color ? *ColorNamed(*color) : now->color(),
                    collapsed.value_or(now->is_collapsed())));
  }
  return true;
}
void TabStripMirror::Changed(TabStripModel* model) {
  if (picked_on_close_.contains(model))
    Refresh();
}
void TabStripMirror::OnBrowserCreated(BrowserWindowInterface* browser) {
  Watch(browser);
  Refresh();
}
void TabStripMirror::OnBrowserClosed(BrowserWindowInterface* browser) {
  if (auto* model = browser->GetTabStripModel();
      model && picked_on_close_.erase(model))
    model->RemoveObserver(this);
  // GlobalBrowserCollection has already removed the closing browser.
  Refresh();
}
void TabStripMirror::OnTabStripModelChanged(
    TabStripModel* model,
    const TabStripModelChange& change,
    const TabStripSelectionChange& selection) {
  if (selection.active_tab_changed())
    picked_on_close_[model] = change.type() == TabStripModelChange::kRemoved;
  Changed(model);
}
void TabStripMirror::OnTabPinnedStateChanged(tabs::TabInterface*, int) {
  Refresh();
}
void TabStripMirror::TabGroupedStateChanged(
    TabStripModel* model,
    std::optional<tab_groups::TabGroupId>,
    std::optional<tab_groups::TabGroupId>,
    tabs::TabInterface*,
    int) {
  Changed(model);
}
void TabStripMirror::OnTabGroupChanged(const TabGroupChange& change) {
  Changed(change.model);
}
void TabStripMirror::OnTabStripModelDestroyed(TabStripModel* model) {
  picked_on_close_.erase(model);
}
}  // namespace bay
