// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_TAB_BROKER_H_
#define CHROME_BROWSER_BAY_WEBUI_TAB_BROKER_H_

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/values.h"

class BrowserWindowInterface;
class Profile;
namespace content {
class WebContents;
}
namespace bay {

// Owns the actual Chrome TabModel while a page moves between SurfaceEmbeds.
// A mount lease prevents a late source unmount from closing the destination.
class TabBroker final {
 public:
  struct Result {
    content::WebContents* contents = nullptr;
    uint64_t lease = 0;
    bool reused = false;
    std::string error;
  };
  struct OfferResult {
    std::string adopt_id;
    std::string error;
  };
  static TabBroker& Get();
  Result Mount(BrowserWindowInterface* browser, const base::DictValue& props);
  std::optional<std::string> PrepareTransfer(const std::string& key);
  void ReleaseTransfer(const std::string& key);
  void Unmount(content::WebContents* contents, uint64_t lease);
  bool IsCurrent(content::WebContents* contents, uint64_t lease) const;
  bool IsLastLease(content::WebContents* contents, uint64_t lease) const;
  bool UsesProfile(Profile* profile) const;
  // Reattach parked pages before Chrome runs every beforeunload handler. A
  // cancelled quit leaves those pages available for their next mount.
  bool PrepareForQuit();

  // Chrome-created popup/new-tab pages can be offered without re-navigation.
  // Tokens have no expiry; the producer must explicitly release rejected ones.
  OfferResult Offer(content::WebContents* contents, bool park = true);
  void ReleaseOffer(const std::string& adopt_id);
  bool HasPageKey(content::WebContents* contents) const;
  void SetProfileReleasedCallback(
      base::RepeatingCallback<void(base::WeakPtr<Profile>)> callback);
  // Must run before explicit app quit starts destroying browser profiles.
  void Shutdown();

 private:
  friend class base::NoDestructor<TabBroker>;
  class Entry;
  TabBroker();
  ~TabBroker();
  void PruneDestroyed();
  Entry* ByKey(const std::string& key) const;
  Entry* ByOffer(const std::string& adopt_id) const;
  std::optional<std::string> Park(Entry& entry);
  void Attach(Entry& entry, BrowserWindowInterface* browser);
  void Close(Entry& entry);
  size_t ParkedCount() const;

  std::map<content::WebContents*, std::unique_ptr<Entry>> entries_;
  base::RepeatingCallback<void(base::WeakPtr<Profile>)> profile_released_;
  uint64_t next_lease_ = 0;
  bool shutting_down_ = false;
};
}  // namespace bay
#endif
