// Copyright 2026 Bay. Apache-2.0.
// Chrome's page context menu as both desktop hosts show it: macOS (nn_context_menu.mm) and Windows and Linux
// (webui/page_menu.cc).
#ifndef BAY_CORE_NN_PAGE_MENU_H_
#define BAY_CORE_NN_PAGE_MENU_H_

namespace ui {
class SimpleMenuModel;
}

namespace nncore {

// Removes Chrome's items for UI Bay's windows have none of: the side panel (Reading mode, Listen to this page) and
// the bubbles that anchor to a toolbar or need the side panel (Create QR Code, Send to your devices, Google Lens,
// which Chrome offers once Google is its search engine). No separator is left doubled or at either end.
void RemoveViewlessItems(ui::SimpleMenuModel& menu);

}  // namespace nncore

#endif  // BAY_CORE_NN_PAGE_MENU_H_
