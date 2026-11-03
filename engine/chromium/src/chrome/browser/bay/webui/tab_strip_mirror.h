// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_TAB_STRIP_MIRROR_H_
#define CHROME_BROWSER_BAY_WEBUI_TAB_STRIP_MIRROR_H_

#include <cstdint>
#include <map>
#include <optional>
#include <string>

#include "base/functional/callback.h"
#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "base/values.h"
#include "chrome/browser/ui/browser_window/public/browser_collection_observer.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/tabs/tab_strip_model_observer.h"

class BrowserWindowInterface;
class TabStripModel;

namespace bay {
class HostContext;

// The desktop host's revisioned Chrome tab strips. One observer owns all Bay
// strips; shared-runtime events and writes belong to its coordinator only.
class TabStripMirror final : public BrowserCollectionObserver,
                             public TabStripModelObserver {
 public:
  using Sink = base::RepeatingCallback<void(base::DictValue)>;
  using Response = base::OnceCallback<void(const std::string&)>;
  static TabStripMirror& Get();

  // Groups the app's synchronous native mutations into one transaction whose
  // cmd is -1. Chrome's own changes have cmd=null; tabStripCommand has its id.
  class AppChange {
   public:
    AppChange();
    ~AppChange();
    AppChange(const AppChange&) = delete;
    AppChange& operator=(const AppChange&) = delete;
  };

  void Start(Sink sink);
  // A tab acquired its Bay transfer key, or a window acquired its app id.
  void Refresh();
  // Returns false without consuming response for another method.
  bool Dispatch(const HostContext& context,
                const std::string& method,
                const base::ListValue& args,
                Response& response);

 private:
  friend class base::NoDestructor<TabStripMirror>;
  TabStripMirror();
  ~TabStripMirror() override;
  void Watch(BrowserWindowInterface* browser);
  void Flush(bool command_reply = false, bool rejected = false);
  base::DictValue Snapshot();
  BrowserWindowInterface* FindStrip(int id) const;
  bool Apply(BrowserWindowInterface* browser, const base::DictValue& command);
  void Changed(TabStripModel* model);

  void OnBrowserCreated(BrowserWindowInterface* browser) override;
  void OnBrowserClosed(BrowserWindowInterface* browser) override;
  void OnTabStripModelChanged(
      TabStripModel* model,
      const TabStripModelChange& change,
      const TabStripSelectionChange& selection) override;
  void OnTabPinnedStateChanged(tabs::TabInterface* tab, int index) override;
  void TabGroupedStateChanged(TabStripModel* model,
                              std::optional<tab_groups::TabGroupId> old_group,
                              std::optional<tab_groups::TabGroupId> new_group,
                              tabs::TabInterface* tab,
                              int index) override;
  void OnTabGroupChanged(const TabGroupChange& change) override;
  void OnTabStripModelDestroyed(TabStripModel* model) override;

  Sink sink_;
  bool started_ = false;
  int app_depth_ = 0;
  bool app_changed_ = false;
  bool pending_ = false;
  int64_t revision_ = 0;
  std::optional<double> command_;
  std::optional<int> command_strip_;
  std::map<TabStripModel*, bool> picked_on_close_;
  std::map<int, base::DictValue> sent_;
  base::ScopedObservation<BrowserCollection, BrowserCollectionObserver>
      observation_{this};
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_TAB_STRIP_MIRROR_H_
