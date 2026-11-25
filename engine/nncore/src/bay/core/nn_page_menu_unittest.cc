// Copyright 2026 Bay. Apache-2.0.
#include "bay/core/nn_page_menu.h"

#include "chrome/app/chrome_command_ids.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/menus/simple_menu_model.h"

namespace nncore {

// Items for UI Bay's windows don't have never show: on macOS, picking Create QR
// Code in one crashed on the missing toolbar.
TEST(PageMenuTest, RemovesViewlessItemsAndTheSeparatorsTheyLeave) {
  ui::SimpleMenuModel menu(nullptr);
  menu.AddItem(IDC_CONTENT_CONTEXT_OPEN_IN_READING_MODE, u"Reading mode");
  menu.AddSeparator(ui::NORMAL_SEPARATOR);
  menu.AddItem(IDC_CONTENT_CONTEXT_COPY, u"Copy");
  menu.AddSeparator(ui::NORMAL_SEPARATOR);
  menu.AddItem(IDC_CONTENT_CONTEXT_GENERATE_QR_CODE, u"Create QR Code");
  menu.AddItem(IDC_SEND_TAB_TO_SELF, u"Send to your devices");
  menu.AddSeparator(ui::NORMAL_SEPARATOR);
  menu.AddItem(IDC_VIEW_SOURCE, u"View source");
  menu.AddItem(IDC_CONTENT_CONTEXT_OPEN_IN_READING_MODE, u"Reading mode");
  menu.AddSeparator(ui::NORMAL_SEPARATOR);
  menu.AddItem(IDC_CONTENT_CONTEXT_LENS_REGION_SEARCH, u"Lens");
  RemoveViewlessItems(menu);
  ASSERT_EQ(menu.GetItemCount(), 3u);
  EXPECT_EQ(menu.GetCommandIdAt(0), IDC_CONTENT_CONTEXT_COPY);
  EXPECT_EQ(menu.GetTypeAt(1), ui::MenuModel::TYPE_SEPARATOR);
  EXPECT_EQ(menu.GetCommandIdAt(2), IDC_VIEW_SOURCE);
}

TEST(PageMenuTest, LeavesAMenuWithNothingToRemoveAsItIs) {
  ui::SimpleMenuModel menu(nullptr);
  menu.AddItem(IDC_BACK, u"Back");
  menu.AddSeparator(ui::NORMAL_SEPARATOR);
  menu.AddItem(IDC_CONTENT_CONTEXT_COPY, u"Copy");
  RemoveViewlessItems(menu);
  ASSERT_EQ(menu.GetItemCount(), 3u);
  EXPECT_EQ(menu.GetTypeAt(1), ui::MenuModel::TYPE_SEPARATOR);
}

}  // namespace nncore
