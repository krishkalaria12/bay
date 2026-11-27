// Copyright 2026 Bay. Apache-2.0.
#include "bay/core/nn_page_menu.h"

#include <optional>

#include "chrome/app/chrome_command_ids.h"
#include "ui/menus/simple_menu_model.h"

namespace nncore {

void RemoveViewlessItems(ui::SimpleMenuModel& menu) {
  for (int command :
       {IDC_CONTENT_CONTEXT_OPEN_IN_READING_MODE,
        IDC_CONTENT_CONTEXT_LISTEN_TO_THIS_PAGE,
        IDC_CONTENT_CONTEXT_GENERATE_QR_CODE, IDC_SEND_TAB_TO_SELF,
        IDC_CONTENT_CONTEXT_SEARCHLENSFORIMAGE,
        IDC_CONTENT_CONTEXT_SEARCHLENSFORVIDEOFRAME,
        IDC_CONTENT_CONTEXT_LENS_REGION_SEARCH}) {
    // Reading mode can be added twice (a selection in a text field).
    while (std::optional<size_t> index = menu.GetIndexOfCommandId(command)) {
      menu.RemoveItemAt(*index);
    }
  }
  const auto separator = [&menu](size_t i) {
    return menu.GetTypeAt(i) == ui::MenuModel::TYPE_SEPARATOR;
  };
  for (size_t i = menu.GetItemCount(); i-- > 0;) {
    const size_t count = menu.GetItemCount();
    if (i < count && separator(i) &&
        (i == 0 || i + 1 == count || separator(i + 1))) {
      menu.RemoveItemAt(i);
    }
  }
}

}  // namespace nncore
