// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_BROWSER_SERVICES_H_
#define CHROME_BROWSER_BAY_WEBUI_BROWSER_SERVICES_H_

#include <map>
#include <memory>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"

class BrowserWindowInterface;
class Profile;

namespace bay {

// UI-sequence services for Chrome's browser features. Profile IDs supplied to
// EngineInvoker are logical Bay IDs, resolved and validated by the host. The
// invoker replies with a complete native wire envelope whose value is the
// parsed engine result, as NativeHost::InvokeEngine(raw_json=false) does.
class BrowserServices {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  using EngineInvoker = base::RepeatingCallback<
      void(const std::string&, const std::string&, base::DictValue, Response)>;
  using EventSink =
      base::RepeatingCallback<void(const char*, const char*, base::DictValue)>;

  BrowserServices(BrowserWindowInterface* browser,
                  EngineInvoker engine,
                  EventSink events);
  ~BrowserServices();
  BrowserServices(const BrowserServices&) = delete;
  BrowserServices& operator=(const BrowserServices&) = delete;

  bool DispatchBrowserModule(const std::string& module,
                             const std::string& method,
                             const base::ListValue& args,
                             Response& response);
  base::ListValue Modules() const;
  base::ListValue SupportedMethods() const;

 private:
  class FolderPicker;
  class RoutesWatcher;
  void FolderPickerFinished();
  void RouteProfileGone(Profile* profile);
  bool DispatchExtensions(const std::string& method,
                          const base::ListValue& args,
                          Response& response);
  bool DispatchChromeUI(const std::string& method,
                        const base::ListValue& args,
                        Response& response);

  raw_ptr<BrowserWindowInterface> browser_;
  EngineInvoker engine_;
  EventSink events_;
  std::unique_ptr<FolderPicker> folder_picker_;
  std::map<Profile*, std::unique_ptr<RoutesWatcher>> route_watchers_;
  base::WeakPtrFactory<BrowserServices> weak_factory_{this};
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_BROWSER_SERVICES_H_
