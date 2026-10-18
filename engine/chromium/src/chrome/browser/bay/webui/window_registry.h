// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_WINDOW_REGISTRY_H_
#define CHROME_BROWSER_BAY_WEBUI_WINDOW_REGISTRY_H_

#include <map>
#include <memory>
#include <optional>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "base/values.h"
#include "chrome/browser/ui/browser_window/public/browser_collection_observer.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "ui/gfx/geometry/rect.h"

class BrowserWindowInterface;
class Profile;

namespace bay {
class NativeHost;

// UI-thread registry. A Chrome window is not a Bay application window until its
// persisted JS id has been adopted or assigned by Open(). Document replacement
// disconnects a host without discarding the native window's identity.
class WindowRegistry final : public BrowserCollectionObserver {
 public:
  struct Result {
    bool ok;
    std::string error;
  };

  static WindowRegistry& Get();
  std::string RegisterHost(BrowserWindowInterface* browser,
                           base::WeakPtr<NativeHost> host,
                           base::RepeatingClosure publish_host_info);
  void UnregisterHost(NativeHost* host);
  std::string IdFor(BrowserWindowInterface* browser) const;
  base::DictValue OptionsFor(BrowserWindowInterface* browser) const;
  BrowserWindowInterface* Find(const std::string& id) const;
  base::ListValue Ids() const;

  Result Open(BrowserWindowInterface* requester,
              const std::string& id,
              const base::DictValue& options);
  Result Close(const std::string& id);
  Result Focus(const std::string& id);
  Result SetTitle(const std::string& id, const std::string& title);
  Result SetFrame(const std::string& id, const gfx::Rect& frame);
  Result Minimize(const std::string& id);
  std::optional<gfx::Rect> Frame(const std::string& id) const;

 private:
  friend class base::NoDestructor<WindowRegistry>;
  class Entry;
  struct Host;
  struct PendingOpen;

  WindowRegistry();
  ~WindowRegistry() override;
  Entry& EnsureEntry(BrowserWindowInterface* browser);
  void PublishHostInfo();
  void Broadcast(base::DictValue event);
  void BoundsChanged(BrowserWindowInterface* browser, const gfx::Rect& bounds);
  void ReleasePrivateProfile(base::WeakPtr<Profile> profile);
  void OnBrowserCreated(BrowserWindowInterface* browser) override;
  void OnBrowserClosed(BrowserWindowInterface* browser) override;
  void OnBrowserActivated(BrowserWindowInterface* browser) override;

  std::map<BrowserWindowInterface*, std::unique_ptr<Entry>> entries_;
  std::map<NativeHost*, std::unique_ptr<Host>> hosts_;
  std::unique_ptr<PendingOpen> pending_open_;
  std::map<Profile*, base::WeakPtr<Profile>> private_profiles_;
  base::ScopedObservation<GlobalBrowserCollection, BrowserCollectionObserver>
      observation_{this};
};
}  // namespace bay
#endif
