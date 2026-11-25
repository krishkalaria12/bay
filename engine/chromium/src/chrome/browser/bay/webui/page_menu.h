// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_PAGE_MENU_H_
#define CHROME_BROWSER_BAY_WEBUI_PAGE_MENU_H_

namespace bay {

// Chrome's page menu in Bay's windows, as macOS's NNContextMenu: without the
// items for UI those windows don't have. Bay's windows have no toolbar or Chrome
// side panel, and on macOS picking Create QR Code in one crashed the browser on
// the missing toolbar.
class PageMenu {
 public:
  // Installs the menu's hook (chromium-context-menu-items-webui.patch).
  static void Start();
};

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_PAGE_MENU_H_
