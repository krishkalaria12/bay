// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_ENGINE_SERVICES_H_
#define CHROME_BROWSER_BAY_WEBUI_ENGINE_SERVICES_H_

#include <memory>
#include <string>

#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "chrome/browser/bay/webui/browser_services.h"
#include "chrome/browser/bay/webui/host_context.h"

class BrowserWindowInterface;
namespace content {
class WebContents;
}

namespace bay {

// Adapts the shared BayCEF facade to the existing NN engine API. The invoker
// accepts validated logical profiles and replies with native wire envelopes,
// exactly as BrowserServices::EngineInvoker does.
class EngineServices {
 public:
  using Response = BrowserServices::Response;
  using EngineInvoker = BrowserServices::EngineInvoker;

  EngineServices(HostContext context, EngineInvoker engine);
  ~EngineServices();
  EngineServices(const EngineServices&) = delete;
  EngineServices& operator=(const EngineServices&) = delete;

  bool DispatchEngineModule(const std::string& module,
                            const std::string& method,
                            const base::ListValue& args,
                            Response& response);
  base::ListValue SupportedMethods() const;
  // Install before the first page interaction to observe the field Chrome's
  // autofill manager last focused. Safe to call again when adopting a tab.
  void TrackTab(content::WebContents* contents);

 private:
  class PasswordExportPicker;
  void PasswordExportPickerFinished();

  const HostContext context_;
  EngineInvoker engine_;
  std::unique_ptr<PasswordExportPicker> password_export_picker_;
  base::WeakPtrFactory<EngineServices> weak_factory_{this};
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_ENGINE_SERVICES_H_
