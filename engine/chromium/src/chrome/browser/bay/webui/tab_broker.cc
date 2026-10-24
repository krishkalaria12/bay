// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/tab_broker.h"

#include <utility>
#include <vector>

#include "base/check.h"
#include "base/check_op.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/logging.h"
#include "base/memory/raw_ptr.h"
#include "base/strings/string_number_conversions.h"
#include "base/uuid.h"
#include "build/build_config.h"
#include "chrome/browser/bay/webui/app_runtime.h"
#include "chrome/browser/bay/webui/page_observer.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/lifetime/browser_close_manager.h"
#include "chrome/browser/lifetime/browser_shutdown.h"
#include "chrome/browser/profiles/keep_alive/profile_keep_alive_types.h"
#include "chrome/browser/profiles/keep_alive/scoped_profile_keep_alive.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_tabstrip.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/create_browser_window.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/tabs/tab_enums.h"
#include "chrome/browser/ui/tabs/tab_model.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/guest_contents/browser/guest_contents_handle.h"
#include "components/keep_alive_registry/keep_alive_types.h"
#include "components/keep_alive_registry/scoped_keep_alive.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "ui/base/window_open_disposition.h"
#include "ui/base/base_window.h"
#include "url/gurl.h"

namespace bay {
namespace {
constexpr size_t kMaximumParkedTabs = 1024;
BrowserWindowInterface* BrowserFor(content::WebContents* contents) {
  return GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(contents);
}
void DetachSurface(content::WebContents* contents) {
  if (auto* handle =
          guest_contents::GuestContentsHandle::FromWebContents(contents))
    handle->DetachFromOuterWebContents();
}
content::WebContents* TabWithId(int id) {
  content::WebContents* found = nullptr;
  GlobalBrowserCollection::GetInstance()->ForEach(
      [&found, id](BrowserWindowInterface* browser) {
        auto* strip = browser->GetTabStripModel();
        for (int i = 0; i < strip->count(); ++i) {
          auto* contents = strip->GetWebContentsAt(i);
          if (sessions::SessionTabHelper::IdForTab(contents).id() == id) {
            found = contents;
            return false;
          }
        }
        return true;
      });
  return found;
}
}  // namespace

class TabBroker::Entry final : public content::WebContentsObserver {
 public:
  explicit Entry(content::WebContents* contents)
      : WebContentsObserver(contents),
        contents(contents),
        profile(Profile::FromBrowserContext(contents->GetBrowserContext())
                    ->GetWeakPtr()) {}
  ~Entry() override {
    facts.reset();
    ForgetPage();
    Observe(nullptr);
    parked.reset();
  }
  void ForgetPage() {
    if (auto* runtime = AppRuntime::GetIfStarted(); runtime && !key.empty())
      runtime->ForgetPage(key);
  }
  void WebContentsDestroyed() override {
    ForgetPage();
    contents = nullptr;
  }
  void DidOpenRequestedURL(content::WebContents* opened,
                           content::RenderFrameHost*,
                           const GURL& url,
                           const content::Referrer&,
                           WindowOpenDisposition disposition,
                           ui::PageTransition,
                           bool,
                           bool) override {
    if (!AppRuntime::Enabled())
      return;
    AppRuntime::MarkOpenedByPage(opened);
    if (key.empty() || !contents || !profile)
      return;
    if (auto* runtime = AppRuntime::GetIfStarted())
      runtime->OpenPage(contents, opened, key, {}, url, disposition);
  }
  void EmitFact(const char* event, base::DictValue payload) {
    if (!contents || !profile || key.empty() ||
        Profile::FromBrowserContext(contents->GetBrowserContext()) !=
            profile.get())
      return;
    if (auto* runtime = AppRuntime::GetIfStarted())
      runtime->PageEvent(key, native_profile,
                         sessions::SessionTabHelper::IdForTab(contents).id(),
                         event, std::move(payload));
  }
  void ObserveFacts(const std::string& profile_id) {
    if (!AppRuntime::Enabled() || key.empty()) {
      facts.reset();
      return;
    }
    native_profile = profile_id;
    if (!facts)
      facts = std::make_unique<TabObserver>(
          contents,
          base::BindRepeating(&Entry::EmitFact, base::Unretained(this)));
    facts->State();
    facts->Media();
  }
  raw_ptr<content::WebContents> contents;
  base::WeakPtr<Profile> profile;
  std::string key;
  std::string native_profile;
  std::unique_ptr<TabObserver> facts;
  std::string offer;
  std::string adopted_from;
  uint64_t lease = 0;
  bool prepared = false;
  BrowserWindowInterface::Type source_type =
      BrowserWindowInterface::Type::TYPE_NORMAL;
  std::unique_ptr<ScopedProfileKeepAlive> profile_keep_alive;
  std::unique_ptr<ScopedKeepAlive> process_keep_alive;
  std::unique_ptr<tabs::TabModel> parked;
};
TabBroker& TabBroker::Get() {
  static base::NoDestructor<TabBroker> broker;
  return *broker;
}
TabBroker::TabBroker() {
#if !BUILDFLAG(IS_WIN)
  BrowserCloseManager::SetBayClosePreflight(
      [](base::OnceCallback<void(bool)> completion) {
        std::move(completion).Run(TabBroker::Get().PrepareForQuit());
      },
      nullptr);
#endif
}
TabBroker::~TabBroker() = default;
void TabBroker::PruneDestroyed() {
  std::erase_if(entries_,
                [](const auto& entry) { return !entry.second->contents; });
}
TabBroker::Entry* TabBroker::ByKey(const std::string& key) const {
  if (key.empty())
    return nullptr;
  for (const auto& [contents, entry] : entries_) {
    if (entry->contents && entry->key == key)
      return entry.get();
  }
  return nullptr;
}
TabBroker::Entry* TabBroker::ByOffer(const std::string& adopt_id) const {
  for (const auto& [contents, entry] : entries_) {
    if (entry->contents && entry->offer == adopt_id)
      return entry.get();
  }
  return nullptr;
}
size_t TabBroker::ParkedCount() const {
  size_t count = 0;
  for (const auto& [contents, entry] : entries_)
    count += !!entry->parked;
  return count;
}
std::optional<std::string> TabBroker::Park(Entry& entry) {
  if (entry.parked)
    return std::nullopt;
  if (ParkedCount() >= kMaximumParkedTabs)
    return "Too many pending tab handoffs; release unused transfers first";
  if (!entry.contents || !entry.profile || shutting_down_ ||
      g_browser_process->IsShuttingDown()) {
    return "The tab is closing";
  }
  auto* browser = BrowserFor(entry.contents);
  if (!browser)
    return "The tab is not in a Chrome tab strip";
  auto* strip = browser->GetTabStripModel();
  if (strip->closing_all())
    return "The source window is already closing";
  const int index = strip->GetIndexOfWebContents(entry.contents);
  if (index == TabStripModel::kNoTab)
    return "The tab is no longer in its source window";
  auto profile_keep_alive = ScopedProfileKeepAlive::TryAcquire(
      entry.profile->GetOriginalProfile(),
      ProfileKeepAliveOrigin::kBrowserWindow);
  if (!profile_keep_alive)
    return "The tab profile is scheduled for deletion";
  auto process_keep_alive = std::make_unique<ScopedKeepAlive>(
      KeepAliveOrigin::BROWSER, KeepAliveRestartOption::DISABLED);
  DetachSurface(entry.contents);
  entry.source_type = browser->GetType();
  entry.parked = strip->DetachTabAtForInsertion(index);
  entry.profile_keep_alive = std::move(profile_keep_alive);
  entry.process_keep_alive = std::move(process_keep_alive);
  return std::nullopt;
}
void TabBroker::Attach(Entry& entry, BrowserWindowInterface* browser) {
  auto* strip = browser->GetTabStripModel();
  if (entry.source_type == browser->GetType()) {
    strip->InsertDetachedTabAt(strip->count(), std::move(entry.parked),
                               ADD_ACTIVE);
  } else {
    // Chrome requires type-specific TabFeatures to be rebuilt on a move
    // between normal and popup windows. The live WebContents is retained.
    auto contents =
        tabs::TabModel::DestroyAndTakeWebContents(std::move(entry.parked));
    strip->InsertWebContentsAt(strip->count(), std::move(contents), ADD_ACTIVE);
  }
  entry.profile_keep_alive.reset();
  entry.process_keep_alive.reset();
}
TabBroker::Result TabBroker::Mount(BrowserWindowInterface* browser,
                                   const base::DictValue& props) {
  PruneDestroyed();
  if (!browser || shutting_down_ || g_browser_process->IsShuttingDown())
    return {.error = "The browser is shutting down"};
  if (const auto* profile_value = props.Find("profile")) {
    if (!profile_value->is_string())
      return {.error = "The tab profile must be a string"};
    const auto& requested = profile_value->GetString();
    const bool is_private = requested.starts_with("incognito:");
    const auto current_name = browser->GetProfile()
                                  ->GetOriginalProfile()
                                  ->GetPath()
                                  .BaseName()
                                  .AsUTF8Unsafe();
    const std::string current = current_name == "Default" ? "" : current_name;
    if (is_private != browser->GetProfile()->IsOffTheRecord() ||
        (!is_private && requested != current) ||
        (is_private &&
         requested != "incognito:" + WindowRegistry::Get().IdFor(browser))) {
      return {.error =
                  "The requested tab profile does not belong to this window"};
    }
  } else if (browser->GetProfile()->IsOffTheRecord()) {
    return {.error = "Private tabs must name their private profile"};
  }
  const auto* key_value = props.Find("transferKey");
  const auto* adopt_value = props.Find("adoptId");
  if ((key_value && !key_value->is_string()) ||
      (adopt_value && !adopt_value->is_string())) {
    return {.error = "Transfer keys and adoption ids must be strings"};
  }
  const std::string key = key_value ? key_value->GetString() : "";
  const std::string adopt_id = adopt_value ? adopt_value->GetString() : "";
  if (key.size() > 256 || adopt_id.size() > 256)
    return {.error = "Transfer key or adoption id is too long"};
  if (AppRuntime::Enabled() && !adopt_id.empty() && key.empty())
    return {.error = "An adopted page requires its accepted application tab key"};
  const auto profile_name = browser->GetProfile()
                                ->GetOriginalProfile()
                                ->GetPath()
                                .BaseName()
                                .AsUTF8Unsafe();
  const std::string native_profile =
      browser->GetProfile()->IsOffTheRecord()
          ? "incognito:" + WindowRegistry::Get().IdFor(browser)
      : profile_name == "Default" ? ""
                                  : profile_name;
  if (AppRuntime::Enabled() && !key.empty()) {
    auto* runtime = AppRuntime::GetIfStarted();
    if (!runtime || !runtime->CanMountPage(WindowRegistry::Get().IdFor(browser),
                                           key, native_profile, adopt_id))
      return {.error =
                  "The tab key does not belong to this window and profile"};
  }
  Entry* entry = ByKey(key);
  if (entry && !adopt_id.empty() && adopt_id != entry->adopted_from &&
      adopt_id != entry->offer) {
    return {.error = "The transfer key belongs to a different adopted page"};
  }
  if (!entry && !adopt_id.empty()) {
    entry = ByOffer(adopt_id);
    if (!entry && adopt_id.starts_with("tab:")) {
      int id = 0;
      if (!base::StringToInt(adopt_id.substr(4), &id) || id <= 0)
        return {.error = "Invalid Chrome tab adoption id"};
      auto* contents = TabWithId(id);
      if (!contents)
        return {.error = "The offered Chrome tab no longer exists"};
      auto existing = entries_.find(contents);
      if (existing != entries_.end() && existing->second->lease)
        return {.error = "The offered Chrome tab already has a mounted owner"};
      if (existing == entries_.end())
        existing =
            entries_.emplace(contents, std::make_unique<Entry>(contents)).first;
      entry = existing->second.get();
    }
    if (!entry)
      return {.error = "Unknown or already consumed tab adoption token"};
  }
  if (entry && entry->profile.get() != browser->GetProfile())
    return {.error = "Tabs can only move within the exact same Chrome profile"};
  const bool reused = !!entry;
  if (!entry) {
    const auto* url = props.FindString("url");
    const GURL target(url && !url->empty() ? *url : "about:blank");
    if (!target.is_valid() || target.SchemeIs("javascript") ||
        target.SchemeIs("bay"))
      return {.error = "Navigation URL is not allowed"};
    auto* contents = chrome::AddAndReturnTabAt(
        browser, target, -1, props.FindBool("visible").value_or(true));
    if (!contents)
      return {.error = "Chrome could not create the tab"};
    auto owned = std::make_unique<Entry>(contents);
    entry = owned.get();
    entries_[contents] = std::move(owned);
  } else {
    if (!entry->parked && BrowserFor(entry->contents) != browser) {
      if (auto error = Park(*entry))
        return {.error = *error};
    }
    DetachSurface(entry->contents);
    if (entry->parked) {
      Attach(*entry, browser);
    }
  }
  if (entry->key != key) {
    entry->ForgetPage();
    entry->facts.reset();
  }
  entry->key = key;
  if (!adopt_id.empty())
    entry->adopted_from = adopt_id;
  entry->offer.clear();
  entry->prepared = false;
  entry->lease = ++next_lease_;
  CHECK_NE(entry->lease, 0u);
  entry->ObserveFacts(native_profile);
  if (!adopt_id.empty() && AppRuntime::Enabled()) {
    if (auto* runtime = AppRuntime::GetIfStarted())
      runtime->PageOpenMounted(adopt_id, key);
  }
  return {entry->contents.get(), entry->lease, reused, {}};
}
std::optional<std::string> TabBroker::PrepareTransfer(const std::string& key) {
  PruneDestroyed();
  auto* entry = ByKey(key);
  if (!entry)
    return "Unknown tab transfer key";
  if (auto error = Park(*entry))
    return error;
  entry->prepared = true;
  return std::nullopt;
}
void TabBroker::ReleaseTransfer(const std::string& key) {
  PruneDestroyed();
  if (auto* entry = ByKey(key)) {
    entry->prepared = false;
    if (entry->parked)
      Close(*entry);
  }
}
void TabBroker::PreserveTransfers(const base::DictValue* previous,
                                  const base::DictValue& next) {
  PruneDestroyed();
  if (!previous)
    return;
  const auto* before = previous->FindDict("tabs");
  const auto* after = next.FindDict("tabs");
  std::vector<std::string> release;
  for (const auto& [contents, entry] : entries_) {
    if (entry->key.empty())
      continue;
    const auto* prior = before ? before->FindDict(entry->key) : nullptr;
    const auto* target = after ? after->FindDict(entry->key) : nullptr;
    if (!target) {
      if (entry->prepared)
        release.push_back(entry->key);
      continue;
    }
    const auto* from = prior ? prior->FindString("windowId") : nullptr;
    const auto* to = target->FindString("windowId");
    if (!from || !to || *from == *to)
      continue;
    // Best effort: a page that cannot be parked loads its URL afresh in the
    // destination, which is better than refusing the user's accepted move.
    if (auto error = Park(*entry)) {
      LOG(WARNING) << "Bay could not keep a moved page live: " << *error;
      continue;
    }
    entry->prepared = true;
  }
  for (const auto& key : release)
    ReleaseTransfer(key);
}
void TabBroker::Unmount(content::WebContents* contents, uint64_t lease) {
  PruneDestroyed();
  auto it = entries_.find(contents);
  if (it == entries_.end() || !lease || it->second->lease != lease)
    return;
  it->second->lease = 0;
  if (!it->second->prepared)
    Close(*it->second);
}
bool TabBroker::IsCurrent(content::WebContents* contents,
                          uint64_t lease) const {
  auto it = entries_.find(contents);
  return lease && it != entries_.end() && it->second->contents &&
         it->second->lease == lease && !it->second->parked;
}
bool TabBroker::IsLastLease(content::WebContents* contents,
                            uint64_t lease) const {
  auto it = entries_.find(contents);
  return lease && it != entries_.end() && it->second->lease == lease;
}
bool TabBroker::UsesProfile(Profile* profile) const {
  for (const auto& [contents, entry] : entries_) {
    if (entry->parked && entry->profile.get() == profile)
      return true;
  }
  return false;
}
bool TabBroker::PrepareForQuit() {
  if (browser_shutdown::ShouldIgnoreUnloadHandlers()) {
    Shutdown();
    return true;
  }
  PruneDestroyed();
  for (auto& [contents, owned] : entries_) {
    auto& entry = *owned;
    if (!entry.parked)
      continue;
    if (!entry.profile)
      return false;
    BrowserWindowInterface* target = nullptr;
    GlobalBrowserCollection::GetInstance()->ForEach(
        [&](BrowserWindowInterface* browser) {
          if (browser->GetProfile() != entry.profile.get() ||
              browser->GetTabStripModel()->closing_all())
            return true;
          target = browser;
          return false;
        });
    if (!target) {
      if (GetBrowserWindowCreationStatusForProfile(*entry.profile) !=
          BrowserWindowInterface::CreationStatus::kOk)
        return false;
      // A stock popup has no Bay application renderer. Showing it inactive
      // gives Chrome's beforeunload dialogs a visible parent if consent is
      // needed; normal close preflight destroys it immediately otherwise.
      BrowserWindowCreateParams params(BrowserWindowInterface::Type::TYPE_POPUP,
                                       entry.profile.get(), true);
      params.should_trigger_session_restore = false;
      params.omit_from_session_restore = true;
      target = CreateBrowserWindow(std::move(params));
      if (!target)
        return false;
      target->GetWindow()->ShowInactive();
    }
    entry.lease = 0;
    entry.prepared = false;
    Attach(entry, target);
  }
  return true;
}
TabBroker::OfferResult TabBroker::Offer(content::WebContents* contents, bool park) {
  PruneDestroyed();
  if (!contents)
    return {.error = "A real Chrome tab is required"};
  auto it = entries_.find(contents);
  if (it == entries_.end())
    it = entries_.emplace(contents, std::make_unique<Entry>(contents)).first;
  auto& entry = *it->second;
  if (entry.lease || !entry.key.empty())
    return {.error = "The offered Chrome tab already has a mounted owner"};
  if (park) {
    if (auto error = Park(entry))
      return {.error = *error};
  }
  if (entry.offer.empty())
    entry.offer =
        "bay-tab:" + base::Uuid::GenerateRandomV4().AsLowercaseString();
  return {entry.offer, {}};
}
bool TabBroker::HasPageKey(content::WebContents* contents) const {
  const auto it = entries_.find(contents);
  return it != entries_.end() && !it->second->key.empty();
}
bool TabBroker::Tracks(content::WebContents* contents) {
  PruneDestroyed();
  return entries_.contains(contents);
}
void TabBroker::ReleaseOffer(const std::string& adopt_id) {
  PruneDestroyed();
  if (auto* entry = ByOffer(adopt_id))
    Close(*entry);
}
void TabBroker::Close(Entry& entry) {
  auto profile = entry.profile;
  const bool was_parked = !!entry.parked;
  auto* contents = entry.contents.get();
  DetachSurface(contents);
  if (entry.parked) {
    entries_.erase(contents);
  } else if (auto* browser = BrowserFor(contents)) {
    auto* strip = browser->GetTabStripModel();
    const int index = strip->GetIndexOfWebContents(contents);
    entries_.erase(contents);
    if (index != TabStripModel::kNoTab)
      strip->DetachAndDeleteWebContentsAt(index);
  } else {
    entries_.erase(contents);
  }
  if (was_parked && profile && profile_released_)
    profile_released_.Run(profile);
}
void TabBroker::SetProfileReleasedCallback(
    base::RepeatingCallback<void(base::WeakPtr<Profile>)> callback) {
  profile_released_ = std::move(callback);
}
void TabBroker::Shutdown() {
  shutting_down_ = true;
  // Attached tabs remain owned by Chrome's normal shutdown path. Destroy parked
  // tabs before dropping their profile/process keep-alives.
  entries_.clear();
}
}  // namespace bay
