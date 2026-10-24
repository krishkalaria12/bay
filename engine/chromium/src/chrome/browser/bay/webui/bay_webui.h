// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_BAY_WEBUI_H_
#define CHROME_BROWSER_BAY_WEBUI_BAY_WEBUI_H_

#include "build/build_config.h"
#include "chrome/browser/bay/webui/native_host.mojom-forward.h"
#include "chrome/browser/ui/webui_browser/webui_browser_ui.h"
#include "chrome/browser/ui/webui_browser/webui_browser_window.h"
#include "content/public/browser/webui_config.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"

namespace content {
class WebUI;
}

namespace bay {
inline constexpr char kBayHost[] = "bay";
inline constexpr char kBayURL[] = "chrome://bay/";

// Reuse upstream's controller type. Its window, modal-dialog, fullscreen,
// side-panel and tracked-element code all query WebUIBrowserUI explicitly.
// The Bay origin supplies its own resources and its own NativeHost receiver.
using BayWebUI = WebUIBrowserUI;

class BayWebUIConfig : public content::DefaultWebUIConfig<BayWebUI> {
 public:
  BayWebUIConfig();
  bool IsWebUIEnabled(content::BrowserContext* browser_context) override;
};

class BayWebUIBrowserWindow : public WebUIBrowserWindow {
 public:
  explicit BayWebUIBrowserWindow(BrowserWindowInterface* browser);
  void SetFocusToLocationBar(bool is_user_initiated) override;
  // A window Chrome opened beside Bay's own is never shown (WindowRegistry).
  void Show() override;
  void ShowInactive() override;
#if BUILDFLAG(IS_LINUX)
  // Ctrl+Q quits, as Linux desktops expect (quit_shortcut_linux.h).
  content::KeyboardEventProcessingResult PreHandleKeyboardEvent(
      const input::NativeWebKeyboardEvent& event) override;
#endif
};

// Called by the shared upstream controller after its Browser association is
// established. Returns true only when it configured the Bay document.
bool ConfigureBayWebUI(content::WebUI* web_ui);
void BindNativeHost(content::WebUI* web_ui,
                    mojo::PendingReceiver<mojom::NativeHost> receiver);
void ShutdownAppRuntimeIfStarted();
void BindAppRuntime(content::WebUI* web_ui,
                    mojo::PendingReceiver<mojom::AppRuntime> receiver);
void EmitWindowCommand(BrowserWindowInterface* browser, const char* command);

}  // namespace bay
#endif
