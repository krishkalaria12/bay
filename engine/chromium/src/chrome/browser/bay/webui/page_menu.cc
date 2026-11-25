// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/page_menu.h"

#include "bay/core/nn_page_menu.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "ui/menus/simple_menu_model.h"

namespace content {
class WebContents;
}

// Defined in Chrome's page menu (chromium-context-menu-items-webui.patch).
extern void (*g_bay_context_menu_built)(content::WebContents* contents,
                                        ui::SimpleMenuModel* menu);

namespace bay {
namespace {

void MenuBuilt(content::WebContents* contents, ui::SimpleMenuModel* menu) {
  if (WindowRegistry::Get().HoldsTab(contents))
    PageMenu::RemoveViewlessItems(*menu);
}

}  // namespace

// static
void PageMenu::Start() {
  g_bay_context_menu_built = &MenuBuilt;
}

// static
void PageMenu::RemoveViewlessItems(ui::SimpleMenuModel& menu) {
  nncore::RemoveViewlessItems(menu);
}

}  // namespace bay
