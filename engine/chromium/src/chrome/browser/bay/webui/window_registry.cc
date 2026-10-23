// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/window_registry.h"

#include <algorithm>
#include <utility>
#include <vector>

#include "base/check.h"
#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/memory/raw_ref.h"
#include "base/path_service.h"
#include "base/task/single_thread_task_runner.h"
#include "build/build_config.h"
#include "chrome/browser/bay/webui/app_runtime.h"
#include "chrome/browser/bay/webui/native_host.h"
#include "chrome/browser/bay/webui/tab_broker.h"
#include "chrome/browser/bay/webui/window_placement.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_destroyer.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/ui/browser_window/public/browser_collection.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/create_browser_window.h"
#include "chrome/browser/ui/navigator/browser_navigator.h"
#include "chrome/browser/ui/navigator/browser_navigator_params.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/webui_browser/webui_browser_window.h"
#include "chrome/browser/ui/window_metadata/window_metadata_controller.h"
#include "chrome/common/chrome_paths.h"
#include "content/public/browser/web_contents.h"
#include "ui/base/base_window.h"
#include "ui/base/page_transition_types.h"
#include "ui/base/window_open_disposition.h"
#include "ui/display/screen.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_observer.h"
#include "url/gurl.h"
#if BUILDFLAG(IS_WIN)
#include "chrome/browser/bay/webui/frame_win.h"
#endif

namespace bay {
bool IsUtilityWindowKind(const std::string& kind) {
  return kind == "settings" || kind == "import" || kind == "taskManager";
}
namespace {
WindowRegistry::Result Success() {
  return {true, {}};
}
WindowRegistry::Result Failure(const char* message) {
  return {false, message};
}
bool ValidName(const std::string& name) {
  return !name.empty() && name.size() <= 256 &&
         name.find_first_not_of(
             "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_"
             "-") == std::string::npos;
}
bool KnownKind(const std::string& kind) {
  return kind == "browser" || kind == "small" || IsUtilityWindowKind(kind);
}
base::ListValue RectValue(const gfx::Rect& rect) {
  return base::ListValue()
      .Append(rect.x())
      .Append(rect.y())
      .Append(rect.width())
      .Append(rect.height());
}
}  // namespace

class WindowRegistry::Entry final : public views::WidgetObserver {
 public:
  Entry(WindowRegistry& registry, BrowserWindowInterface* browser)
      : registry_(registry), browser_(browser->GetWeakPtr()) {
    if (auto* window = browser->GetWindow();
        window && !GlobalWindowCoordinates())
      restored_size.Seed(window->GetRestoredBounds().size());
  }
  void ObserveWidget() {
    auto* window = WebUIBrowserWindow::FromBrowser(browser_.get());
    if (window && window->widget() && !observation_.IsObserving())
      observation_.Observe(window->widget());
  }
  void OnWidgetBoundsChanged(views::Widget*, const gfx::Rect& bounds) override {
    if (browser_)
      registry_->BoundsChanged(browser_.get(), bounds);
  }
  void OnWidgetShowStateChanged(views::Widget*) override {
    if (browser_)
      registry_->ShowStateChanged(browser_.get());
  }
  void OnWidgetDestroyed(views::Widget*) override { observation_.Reset(); }

  std::string id;
  base::DictValue options;
  bool absorbed = false;
  RestoredWindowSize restored_size;

 private:
  const raw_ref<WindowRegistry> registry_;
  const base::WeakPtr<BrowserWindowInterface> browser_;
  base::ScopedObservation<views::Widget, views::WidgetObserver> observation_{
      this};
};

struct WindowRegistry::Host {
  base::WeakPtr<NativeHost> host;
  base::RepeatingClosure publish_host_info;
};
struct WindowRegistry::PendingOpen {
  raw_ptr<Profile> profile;
  std::string id;
  base::DictValue options;
};

WindowRegistry& WindowRegistry::Get() {
  static base::NoDestructor<WindowRegistry> registry;
  return *registry;
}
WindowRegistry::WindowRegistry() {
  observation_.Observe(GlobalBrowserCollection::GetInstance());
  TabBroker::Get().SetProfileReleasedCallback(base::BindRepeating(
      &WindowRegistry::ReleasePrivateProfile, base::Unretained(this)));
}
WindowRegistry::~WindowRegistry() = default;

WindowRegistry::Entry& WindowRegistry::EnsureEntry(
    BrowserWindowInterface* browser) {
  auto& entry = entries_[browser];
  if (!entry)
    entry = std::make_unique<Entry>(*this, browser);
  entry->ObserveWidget();
  return *entry;
}
std::string WindowRegistry::RegisterHost(
    BrowserWindowInterface* browser,
    base::WeakPtr<NativeHost> host,
    base::RepeatingClosure publish_host_info) {
  CHECK(browser);
  CHECK(host);
  NativeHost* key = host.get();
  hosts_[key] =
      std::make_unique<Host>(std::move(host), std::move(publish_host_info));
  OnBrowserCreated(browser);
  return IdFor(browser);
}
void WindowRegistry::UnregisterHost(NativeHost* host) {
  hosts_.erase(host);
}
std::string WindowRegistry::IdFor(BrowserWindowInterface* browser) const {
  auto it = entries_.find(browser);
  return it == entries_.end() ? std::string() : it->second->id;
}
base::DictValue WindowRegistry::OptionsFor(
    BrowserWindowInterface* browser) const {
  auto it = entries_.find(browser);
  return it == entries_.end() ? base::DictValue() : it->second->options.Clone();
}
bool WindowRegistry::IsUtility(BrowserWindowInterface* browser) const {
  auto it = entries_.find(browser);
  const auto* kind =
      it == entries_.end() ? nullptr : it->second->options.FindString("kind");
  return kind && IsUtilityWindowKind(*kind);
}
BrowserWindowInterface* WindowRegistry::Find(const std::string& id) const {
  if (id.empty())
    return nullptr;
  for (const auto& [browser, entry] : entries_) {
    if (entry->id == id)
      return browser;
  }
  return nullptr;
}
base::ListValue WindowRegistry::Ids() const {
  base::ListValue ids;
  for (const auto& [browser, entry] : entries_) {
    if (!entry->id.empty())
      ids.Append(entry->id);
  }
  return ids;
}

WindowRegistry::Result WindowRegistry::Open(const HostContext& context,
                                            const std::string& id,
                                            const base::DictValue& options) {
  if (!context.profile())
    return Failure("The host profile is no longer available");
  auto* requester = context.window();
  if (context.is_window() && !requester)
    return Failure("The requesting window is no longer available");
  if (!ValidName(id))
    return Failure("Invalid window id");
  for (const char* field : {"kind", "profile", "title", "pane", "spaceId"}) {
    if (const auto* value = options.Find(field);
        value && (!value->is_string() || value->GetString().size() > 1024))
      return Failure("Window text options must be strings");
  }
  for (const char* field : {"focus", "incognito"}) {
    if (const auto* value = options.Find(field); value && !value->is_bool())
      return Failure("Window flags must be booleans");
  }
  const bool global_coordinates = GlobalWindowCoordinates();
  WindowPlacement placement;
  const auto placement_error =
      ParseWindowPlacement(options, global_coordinates, placement);
  if (!placement_error.empty())
    return {false, placement_error};
  const std::string kind =
      options.FindString("kind") ? *options.FindString("kind") : "browser";
  if (!KnownKind(kind))
    return Failure("Unknown window kind");
  const bool focus = options.FindBool("focus").value_or(true);
  if (auto* existing = Find(id)) {
    // A utility window named again takes the request's place (Settings: its
    // pane), and its document hears it.
    if (IsUtility(existing)) {
      auto& current = *entries_.at(existing);
      for (const char* field : {"pane", "spaceId"}) {
        if (const auto* value = options.FindString(field))
          current.options.Set(field, *value);
        else
          current.options.Remove(field);
      }
      EmitToWindow(id, base::DictValue()
                           .Set("type", "opened")
                           .Set("id", id)
                           .Set("options", current.options.Clone()));
    }
    if (focus)
      existing->GetWindow()->Activate();
    return Success();
  }
  if (pending_open_)
    return Failure("A window is already being created");
  auto frame = placement.frame;
  if (global_coordinates && !frame && placement.size) {
    gfx::Point center;
    if (requester) {
      center = requester->GetWindow()->GetBounds().CenterPoint();
    } else {
      auto* screen = display::Screen::Get();
      if (!screen)
        return Failure("No display is available for the requested window");
      center = screen->GetPrimaryDisplay().work_area().CenterPoint();
    }
    frame.emplace(center.x() - placement.size->width() / 2,
                  center.y() - placement.size->height() / 2,
                  placement.size->width(), placement.size->height());
  }
  const bool incognito = options.FindBool("incognito").value_or(false);
  const std::string profile_name =
      options.FindString("profile") ? *options.FindString("profile") : "";
  if (!profile_name.empty() &&
      !(incognito && profile_name == "incognito:" + id) &&
      (!ValidName(profile_name) || profile_name.size() > 128)) {
    return Failure("Invalid profile id");
  }
  if (incognito && !profile_name.empty() && profile_name != "incognito:" + id)
    return Failure("Incognito profile id must match its window id");
  Profile* profile = nullptr;
  if (!context.is_window() && AppRuntime::Enabled()) {
    if (auto* runtime = AppRuntime::GetIfStarted())
      profile = runtime->PageOpenProfileForWindow(id);
    if (profile && !incognito)
      return Failure("The offered page requires a private window");
  }
  const bool offered_profile = !!profile;
  if (!profile) {
    base::FilePath root;
    if (!base::PathService::Get(chrome::DIR_USER_DATA, &root))
      return Failure("The user data directory is unavailable");
    const auto profile_path = root.AppendASCII(
        profile_name.empty() || incognito ? "Default" : profile_name);
    auto* manager = g_browser_process->profile_manager();
    profile = manager ? manager->GetProfileByPath(profile_path) : nullptr;
    if (!profile)
      return Failure("The requested profile has not been loaded");
  }
  if (incognito && !offered_profile) {
    // Each Bay private window has its own cookie/storage context. Non-primary
    // Chrome OTR profiles intentionally do not expose installed extensions.
    const auto otr = Profile::OTRProfileID::CreateUniqueForBay();
    profile = profile->GetOffTheRecordProfile(otr, true);
    if (!profile)
      return Failure("Could not create an incognito profile");
    private_profiles_[profile] = profile->GetWeakPtr();
  }
  // Only the authenticated coordinator may claim the exact initial shell.
  // A missing requester or a matching profile alone grants no authority.
  if (!context.is_window() && !requester && kind == "browser") {
    if (auto* runtime = AppRuntime::GetIfStarted())
      requester = runtime->TakeStartupWindowForAdoption(profile);
  }
  if (requester) {
    auto& current = EnsureEntry(requester);
    if (current.id.empty() && requester->GetProfile() == profile &&
        kind == "browser") {
      current.id = id;
      current.options = options.Clone();
      current.options.Set("kind", kind);
      auto* window = requester->GetWindow();
      if (!global_coordinates && placement.size) {
        // The startup shell already exists. Resize it without asking for or
        // setting a global origin, before applying its restored show state.
        if (auto* shell = WebUIBrowserWindow::FromBrowser(requester)) {
          current.restored_size.Seed(*placement.size);
          if (window->IsMaximized() || window->IsMinimized())
            window->Restore();
          shell->widget()->SetSize(*placement.size);
        }
      } else if (frame) {
        window->SetBounds(*frame);
      }
      if (placement.maximized.has_value()) {
        if (*placement.maximized)
          window->Maximize();
        else if (window->IsMaximized() || window->IsMinimized())
          window->Restore();
      }
      if (const auto* title = options.FindString("title"))
        SetTitle(id, *title);
      PublishHostInfo();
      if (focus)
        requester->GetWindow()->Activate();
      return Success();
    }
  }
  BrowserWindowCreateParams params(profile, true);
  if (GetBrowserWindowCreationStatusForProfile(*profile) !=
      BrowserWindowInterface::CreationStatus::kOk) {
    if (incognito)
      ReleasePrivateProfile(profile->GetWeakPtr());
    return Failure("The profile cannot create a browser window");
  }
  params.should_trigger_session_restore = false;
  params.omit_from_session_restore = true;
  if (frame) {
    params.initial_bounds = *frame;
  } else if (!global_coordinates && placement.size) {
    params.initial_bounds = gfx::Rect(*placement.size);
    params.initial_origin_specified =
        BrowserWindowCreateParams::ValueSpecified::kUnspecified;
  }
  if (placement.maximized.has_value()) {
    params.initial_show_state = *placement.maximized
                                    ? ui::mojom::WindowShowState::kMaximized
                                    : ui::mojom::WindowShowState::kNormal;
  }
  if (const auto* title = options.FindString("title"))
    params.user_title = *title;
  pending_open_ = std::make_unique<PendingOpen>(profile, id, options.Clone());
  pending_open_->options.Set("kind", kind);
  auto* created = CreateBrowserWindow(std::move(params));
  if (created)
    OnBrowserCreated(created);
  pending_open_.reset();
  if (!created) {
    if (incognito)
      ReleasePrivateProfile(profile->GetWeakPtr());
    return Failure("Chrome could not create the requested window");
  }
  if (IdFor(created) != id) {
    created->GetWindow()->Close();
    return Failure("Chrome did not create a Bay WebUI window");
  }
  PublishHostInfo();
  if (focus)
    created->GetWindow()->Show();
  else
    created->GetWindow()->ShowInactive();
  return Success();
}

WindowRegistry::Result WindowRegistry::Close(const std::string& id) {
  auto* browser = Find(id);
  if (!browser)
    return Success();
  browser->GetWindow()->Close();
  return Success();
}
WindowRegistry::Result WindowRegistry::Focus(const std::string& id) {
  auto* browser = Find(id);
  if (!browser)
    return Failure("Unknown window id");
  if (browser->GetWindow()->IsMinimized())
    browser->GetWindow()->Restore();
  browser->GetWindow()->Show();
  browser->GetWindow()->Activate();
  return Success();
}
WindowRegistry::Result WindowRegistry::SetTitle(const std::string& id,
                                                const std::string& title) {
  auto* browser = Find(id);
  if (!browser)
    return Failure("Unknown window id");
  if (auto* metadata = WindowMetadataController::From(browser)) {
    metadata->SetWindowUserTitle(title);
    return Success();
  }
  return Failure("Window metadata is not ready");
}
WindowRegistry::Result WindowRegistry::SetFrame(const std::string& id,
                                                const gfx::Rect& frame) {
  auto* browser = Find(id);
  if (!browser)
    return Failure("Unknown window id");
  if (frame.IsEmpty())
    return Failure("Invalid window frame");
  if (!GlobalWindowCoordinates())
    return Failure("Global window coordinates are unavailable");
  browser->GetWindow()->SetBounds(frame);
  return Success();
}
WindowRegistry::Result WindowRegistry::Minimize(const std::string& id) {
  auto* browser = Find(id);
  if (!browser)
    return Failure("Unknown window id");
  browser->GetWindow()->Minimize();
  return Success();
}
WindowRegistry::Result WindowRegistry::ToggleMaximize(const std::string& id) {
  auto* browser = Find(id);
  if (!browser)
    return Failure("Unknown window id");
  auto* window = browser->GetWindow();
  // The caption's maximize button has no meaning while a page is full screen.
  if (window->IsFullscreen())
    return Success();
  if (window->IsMaximized())
    window->Restore();
  else
    window->Maximize();
  return Success();
}
WindowRegistry::Result WindowRegistry::SetCaption(const std::string& id,
                                                  const base::Value* caption) {
  auto* browser = Find(id);
  if (!browser)
    return Failure("Unknown window id");
  const auto* fields = caption ? caption->GetIfDict() : nullptr;
  const auto dark = fields ? fields->FindBool("dark") : std::nullopt;
  const auto* maximize = fields ? fields->Find("maximize") : nullptr;
  std::optional<gfx::Rect> bounds;
  if (maximize && !maximize->is_none())
    bounds = ReadWindowFrame(maximize);
  if (!dark || !maximize || (!maximize->is_none() && !bounds))
    return Failure("Invalid window caption");
#if BUILDFLAG(IS_WIN)
  auto* window = WebUIBrowserWindow::FromBrowser(browser);
  if (!window || !window->widget() ||
      !FrameWin::SetCaption(window->widget(), bounds, *dark))
    return Failure("This window has no Bay frame");
#endif
  return Success();
}
base::DictValue WindowRegistry::StateValue(
    BrowserWindowInterface* browser) const {
  auto* window = browser->GetWindow();
  auto state = base::DictValue()
                   .Set("maximized", window->IsMaximized())
                   .Set("fullscreen", window->IsFullscreen());
  if (!GlobalWindowCoordinates()) {
    state.Set("minimized", window->IsMinimized());
    const auto& size = entries_.at(browser)->restored_size.size();
    if (size)
      state.Set("size",
                base::ListValue().Append(size->width()).Append(size->height()));
  }
  return state;
}
std::optional<base::DictValue> WindowRegistry::State(
    const std::string& id) const {
  auto* browser = Find(id);
  return browser ? std::make_optional(StateValue(browser)) : std::nullopt;
}
std::optional<gfx::Rect> WindowRegistry::Frame(const std::string& id) const {
  if (!GlobalWindowCoordinates())
    return std::nullopt;
  auto* browser = Find(id);
  return browser ? std::make_optional(browser->GetWindow()->GetBounds())
                 : std::nullopt;
}

void WindowRegistry::PublishHostInfo() {
  if (AppRuntime::Enabled()) {
    auto* runtime = AppRuntime::GetIfStarted();
    if (auto host =
            runtime ? runtime->coordinator_host() : base::WeakPtr<NativeHost>())
      host->PublishHostInfo();
  }
  std::vector<std::pair<base::WeakPtr<NativeHost>, base::RepeatingClosure>>
      callbacks;
  for (const auto& [host, state] : hosts_)
    callbacks.emplace_back(state->host, state->publish_host_info);
  for (auto& [host, callback] : callbacks) {
    if (host)
      callback.Run();
  }
}
void WindowRegistry::Broadcast(base::DictValue event) {
  if (AppRuntime::Enabled()) {
    // The coordinator hears every window; a window document its own events,
    // for its caption and its focus.
    if (const auto* id = event.FindString("id"))
      EmitToWindow(*id, event.Clone());
    auto* runtime = AppRuntime::GetIfStarted();
    if (auto host =
            runtime ? runtime->coordinator_host() : base::WeakPtr<NativeHost>())
      host->Emit("BayShell", "onWindowEvent", base::Value(std::move(event)));
    return;
  }
  std::vector<base::WeakPtr<NativeHost>> hosts;
  for (const auto& [host, state] : hosts_)
    hosts.push_back(state->host);
  for (const auto& host : hosts) {
    if (host)
      host->Emit("BayShell", "onWindowEvent", base::Value(event.Clone()));
  }
}
void WindowRegistry::EmitToWindow(const std::string& id,
                                  base::DictValue event) {
  std::vector<base::WeakPtr<NativeHost>> hosts;
  for (const auto& [host, state] : hosts_)
    if (state->host && state->host->browser() &&
        IdFor(state->host->browser()) == id)
      hosts.push_back(state->host);
  for (const auto& host : hosts) {
    if (host)
      host->Emit("BayShell", "onWindowEvent", base::Value(event.Clone()));
  }
}
void WindowRegistry::BoundsChanged(BrowserWindowInterface* browser,
                                   const gfx::Rect& bounds) {
  if (!GlobalWindowCoordinates()) {
    auto* window = browser->GetWindow();
    entries_.at(browser)->restored_size.BoundsChanged(
        bounds.size(), !window->IsMaximized() && !window->IsFullscreen() &&
                           !window->IsMinimized());
    ShowStateChanged(browser);
    return;
  }
  const auto id = IdFor(browser);
  if (!id.empty())
    Broadcast(base::DictValue()
                  .Set("type", "frame")
                  .Set("id", id)
                  .Set("frame", RectValue(bounds)));
}
void WindowRegistry::ShowStateChanged(BrowserWindowInterface* browser) {
  const auto id = IdFor(browser);
  if (!id.empty())
    Broadcast(StateValue(browser).Set("type", "state").Set("id", id));
}
void WindowRegistry::OnBrowserCreated(BrowserWindowInterface* browser) {
  if (!WebUIBrowserWindow::FromBrowser(browser))
    return;
  const bool known = entries_.contains(browser);
  auto& entry = EnsureEntry(browser);
  if (entry.id.empty() && pending_open_ && !Find(pending_open_->id) &&
      browser->GetProfile() == pending_open_->profile) {
    entry.id = pending_open_->id;
    entry.options = pending_open_->options.Clone();
    if (!GlobalWindowCoordinates()) {
      WindowPlacement placement;
      if (ParseWindowPlacement(entry.options, false, placement).empty() &&
          placement.size)
        entry.restored_size.Seed(*placement.size);
    }
  }
  // Decided once, before the window's document can ask for host info.
  if (!known && entry.id.empty() &&
      !base::CommandLine::ForCurrentProcess()->HasSwitch("bay-hosting-spike")) {
    entry.absorbed =
        std::ranges::any_of(entries_, [browser](const auto& other) {
          return other.first != browser && !other.second->absorbed;
        });
  }
}
bool WindowRegistry::IsAbsorbed(BrowserWindowInterface* browser) const {
  auto it = entries_.find(browser);
  return it != entries_.end() && it->second->absorbed;
}
bool WindowRegistry::AbsorbOnShow(BrowserWindowInterface* browser) {
  if (!IsAbsorbed(browser))
    return false;
  // Chrome adds the window's tabs before showing it. Move them once the
  // caller's stack, which may still use the window, has unwound.
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&WindowRegistry::MoveIntoBayWindow,
                                base::Unretained(this), browser->GetWeakPtr()));
  return true;
}
void WindowRegistry::MoveIntoBayWindow(
    base::WeakPtr<BrowserWindowInterface> source) {
  if (!source)
    return;
  // With the shared runtime the coordinator owns every tab: the pages go to it,
  // for a regular browser window.
  const bool shared = AppRuntime::Enabled();
  BrowserWindowInterface* target = nullptr;
  GlobalBrowserCollection::GetInstance()->ForEach(
      [&](BrowserWindowInterface* browser) {
        auto it = entries_.find(browser);
        if (browser == source.get() || it == entries_.end() ||
            it->second->absorbed || browser->IsDeleteScheduled())
          return true;
        const auto* kind = it->second->options.FindString("kind");
        if (shared && (it->second->id.empty() || !kind || *kind != "browser" ||
                       browser->GetProfile()->IsOffTheRecord()))
          return true;
        target = browser;
        return false;
      },
      BrowserCollection::Order::kActivation);
  auto* runtime = shared ? AppRuntime::GetIfStarted() : nullptr;
  if (target && runtime) {
    // Offering a page parks it, out of this tab strip.
    TabStripModel* from = source->GetTabStripModel();
    const auto* active = from->GetActiveWebContents();
    std::vector<base::WeakPtr<content::WebContents>> pages;
    for (int i = 0; i < from->count(); ++i)
      pages.push_back(from->GetWebContentsAt(i)->GetWeakPtr());
    for (const auto& page : pages) {
      if (page)
        runtime->AdoptPage(page.get(), IdFor(target), page.get() == active);
    }
    target->GetWindow()->Activate();
  } else if (target && !shared) {
    TabStripModel* from = source->GetTabStripModel();
    TabStripModel* to = target->GetTabStripModel();
    if (source->GetProfile() == target->GetProfile()) {
      while (!from->empty())
        to->AppendTab(from->DetachTabAtForInsertion(0), /*foreground=*/true);
    } else if (!source->GetProfile()->IsOffTheRecord()) {
      // Pages cannot change profile. Reopen them in the Bay window's profile;
      // private pages are never copied into a regular one.
      for (int i = 0; i < from->count(); ++i) {
        NavigateParams params(target,
                              from->GetWebContentsAt(i)->GetVisibleURL(),
                              ui::PAGE_TRANSITION_AUTO_TOPLEVEL);
        params.disposition = WindowOpenDisposition::NEW_FOREGROUND_TAB;
        Navigate(&params);
      }
    }
    target->GetWindow()->Activate();
  }
  if (source)
    source->GetWindow()->Close();
}
void WindowRegistry::OnBrowserClosed(BrowserWindowInterface* browser) {
  const auto id = IdFor(browser);
  entries_.erase(browser);
  if (!id.empty()) {
    PublishHostInfo();
    Broadcast(base::DictValue().Set("type", "close").Set("id", id));
  }
  auto private_profile = private_profiles_.find(browser->GetProfile());
  if (private_profile != private_profiles_.end() && private_profile->second) {
    // Chrome destroys primary incognito profiles automatically. These are
    // isolated non-primary profiles owned by Bay, so release them after the
    // browser is gone and only after any DevTools window has also closed.
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(&WindowRegistry::ReleasePrivateProfile,
                       base::Unretained(this), private_profile->second));
  } else if (private_profile != private_profiles_.end()) {
    private_profiles_.erase(private_profile);
  }
}
void WindowRegistry::ReleasePrivateProfile(base::WeakPtr<Profile> profile) {
  if (!profile || !profile->IsOffTheRecord() ||
      g_browser_process->IsShuttingDown())
    return;
  if (TabBroker::Get().UsesProfile(profile.get()))
    return;
  bool in_use = false;
  GlobalBrowserCollection::GetInstance()->ForEach(
      [&profile, &in_use](BrowserWindowInterface* browser) {
        in_use = browser->GetProfile() == profile.get();
        return !in_use;
      });
  if (!in_use && private_profiles_.erase(profile.get()))
    ProfileDestroyer::DestroyOTRProfileWhenAppropriate(profile.get());
}
void WindowRegistry::OnBrowserActivated(BrowserWindowInterface* browser) {
  const auto id = IdFor(browser);
  if (!id.empty())
    Broadcast(base::DictValue().Set("type", "focus").Set("id", id));
}
}  // namespace bay
