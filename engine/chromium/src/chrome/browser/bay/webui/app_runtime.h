// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_APP_RUNTIME_H_
#define CHROME_BROWSER_BAY_WEBUI_APP_RUNTIME_H_

#include <deque>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "chrome/browser/bay/webui/native_host.mojom.h"
#include "chrome/browser/bay/webui/runtime_state.h"
#include "chrome/browser/profiles/profile_manager_observer.h"
#include "content/public/browser/web_contents_observer.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "ui/base/window_open_disposition.h"

class GURL;
class BrowserWindowInterface;
class Profile;
class ProfileManager;
class ScopedProfileKeepAlive;
namespace content {
class WebUI;
class WebContents;
}  // namespace content
namespace bay {
class RuntimeConnection;
class NativeHost;

// Browser-owned application lifetime. Detached contents have a profile
// keep-alive, never a process keep-alive: closing the app still exits Chrome.
class AppRuntime final : public ProfileManagerObserver,
                         public content::WebContentsObserver {
 public:
  static bool Enabled();
  static AppRuntime* GetIfStarted();
  static void StartForWindow(BrowserWindowInterface& window);
  static void ShutdownIfStarted();
  bool Owns(content::WebContents* contents) const;
  Profile* profile() const;
  BrowserWindowInterface* TakeStartupWindowForAdoption(Profile* profile);
  bool IsRetiringStartupWindow(BrowserWindowInterface* window) const;
  void SetCoordinatorHost(base::WeakPtr<NativeHost> host);
  base::WeakPtr<NativeHost> coordinator_host() const;
  bool CanMountPage(const std::string& window_id,
                    const std::string& tab_id,
                    const std::string& profile,
                    const std::string& adopt_id) const;
  void OpenPage(content::WebContents* source,
                content::WebContents* opened,
                const std::string& source_tab_id,
                const std::string& source_window_id,
                const GURL& url,
                WindowOpenDisposition disposition);
  // A page from a window Chrome opened on its own (a relaunch, the taskbar, an
  // extension) is offered as a new tab of `window_id`, a regular Bay window.
  // Private pages and new tab pages stay behind and close with their window.
  void AdoptPage(content::WebContents* contents,
                 const std::string& window_id,
                 bool foreground);
  bool FinishPageOpen(NativeHost* host,
                      const std::string& offer_id,
                      const std::string* target_tab_id);
  void PageOpenMounted(const std::string& offer_id,
                       const std::string& tab_id);
  Profile* PageOpenProfileForWindow(const std::string& window_id) const;
  bool StartPageEvents(NativeHost* host);
  bool StopPageEvents(NativeHost* host);
  void PageEvent(const std::string& tab_id,
                 const std::string& profile,
                 int browser_id,
                 const char* event,
                 base::DictValue payload);
  void ForgetPage(const std::string& tab_id);
  void Bind(content::WebUI* web_ui,
            mojo::PendingReceiver<mojom::AppRuntime> receiver);

 private:
  friend class RuntimeConnection;
  explicit AppRuntime(BrowserWindowInterface& window);
  ~AppRuntime() override;
  friend struct std::default_delete<AppRuntime>;
  struct Pending;
  struct PageOpen;
  void OfferPage(base::WeakPtr<content::WebContents> opened,
                 base::WeakPtr<Profile> profile,
                 base::DictValue event);
  bool ValidatePageOpens(const base::DictValue& state) const;
  void ReconcilePageOpens();
  void ReleasePageOpen(std::string offer_id);
  void Start();
  void RetireUnusedStartupWindow();
  void ProfileLoaded(Profile* profile);
  void Shutdown();
  void ConnectionClosed(RuntimeConnection* connection);
  void FailPending(const char* code);
  void CoordinatorClosed();
  void RestartCoordinator();
  void Queue(RuntimeConnection& connection,
             const std::string& token,
             double request_id,
             RuntimeResultKind result_kind,
             mojom::AppRuntime::DispatchCallback callback);
  void Timeout(const std::string& token);
  std::optional<base::DictValue> Snapshot(RuntimeConnection& connection) const;
  void OnProfileManagerDestroying() override;
  void PrimaryMainFrameRenderProcessGone(
      base::TerminationStatus status) override;

  base::WeakPtr<BrowserWindowInterface> startup_window_;
  base::WeakPtr<BrowserWindowInterface> retiring_startup_window_;
  std::unique_ptr<ScopedProfileKeepAlive> profile_keep_alive_;
  std::unique_ptr<content::WebContents> contents_;
  base::ScopedObservation<ProfileManager, ProfileManagerObserver>
      profile_observation_{this};
  std::map<std::string, base::WeakPtr<RuntimeConnection>> connections_;
  base::WeakPtr<RuntimeConnection> coordinator_;
  base::WeakPtr<NativeHost> coordinator_host_;
  std::map<std::string, std::unique_ptr<Pending>> pending_;
  std::optional<base::DictValue> accepted_;
  RuntimePageEventCache page_events_;
  std::map<std::string, std::unique_ptr<PageOpen>> page_opens_;
  bool page_events_started_ = false;
  std::string epoch_;
  base::OneShotTimer restart_;
  std::deque<base::TimeTicks> restart_times_;
  bool coordinator_document_live_ = false;
  bool ready_ = false;
  bool shutdown_ = false;
  base::WeakPtrFactory<AppRuntime> weak_factory_{this};
};

void BindAppRuntime(content::WebUI* web_ui,
                    mojo::PendingReceiver<mojom::AppRuntime> receiver);
}  // namespace bay
#endif
