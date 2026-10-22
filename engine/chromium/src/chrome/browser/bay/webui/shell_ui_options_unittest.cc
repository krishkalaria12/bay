// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/shell_ui_options.h"

#include "build/build_config.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
TEST(ShellUIOptionsTest, PreservesPromptFieldsAndExactWindow) {
  auto options = base::DictValue()
                     .Set("title", "Rename Space")
                     .Set("message", "Choose a name")
                     .Set("value", "Current name")
                     .Set("placeholder", "Space name")
                     .Set("confirmTitle", "Rename")
                     .Set("windowId", "window-42");
  auto parsed = ParseShellPromptOptions(options);
  ASSERT_TRUE(parsed);
  EXPECT_EQ(parsed->title, u"Rename Space");
  EXPECT_EQ(parsed->message, u"Choose a name");
  EXPECT_EQ(parsed->value, u"Current name");
  EXPECT_EQ(parsed->placeholder, u"Space name");
  EXPECT_EQ(parsed->confirm_title, u"Rename");
  ASSERT_TRUE(parsed->window_id);
  EXPECT_EQ(*parsed->window_id, "window-42");
}
TEST(ShellUIOptionsTest, AllowsOptionalFieldsWithoutInventingWindowIdentity) {
  auto parsed =
      ParseShellPromptOptions(base::DictValue().Set("title", "New Folder"));
  ASSERT_TRUE(parsed);
  EXPECT_TRUE(parsed->value.empty());
  EXPECT_TRUE(parsed->confirm_title.empty());
  EXPECT_FALSE(parsed->window_id);
}
TEST(ShellUIOptionsTest, RejectsMalformedOrOversizedPromptData) {
  EXPECT_FALSE(ParseShellPromptOptions(base::DictValue()));
  EXPECT_FALSE(ParseShellPromptOptions(base::DictValue().Set("title", 42)));
  EXPECT_FALSE(ParseShellPromptOptions(
      base::DictValue().Set("title", "New Folder").Set("value", true)));
  EXPECT_FALSE(ParseShellPromptOptions(
      base::DictValue().Set("title", "New Folder").Set("windowId", "")));
  EXPECT_FALSE(ParseShellPromptOptions(
      base::DictValue().Set("title", "New Folder").Set("windowId", 1)));
  EXPECT_FALSE(ParseShellPromptOptions(
      base::DictValue().Set("title", "New Folder").Set("role", "coordinator")));
  EXPECT_FALSE(ParseShellPromptOptions(
      base::DictValue().Set("title", std::string(4097, 'x'))));
  EXPECT_FALSE(
      ParseShellPromptOptions(base::DictValue()
                                  .Set("title", "New Folder")
                                  .Set("value", std::string(65537, 'x'))));
  EXPECT_FALSE(ParseShellPromptOptions(
      base::DictValue().Set("title", std::string("bad\0title", 9))));
}
TEST(ShellUIOptionsTest, PreservesConfirmFieldsAndExactWindow) {
  auto options = base::DictValue()
                     .Set("title", "Close 12 tabs?")
                     .Set("message", "Pinned tabs stay open")
                     .Set("confirmTitle", "Close Tabs")
                     .Set("cancelTitle", "Keep Them")
                     .Set("destructive", true)
                     .Set("suppression", "Don't ask again")
                     .Set("windowId", "window-7");
  auto parsed = ParseShellConfirmOptions(options);
  ASSERT_TRUE(parsed);
  EXPECT_EQ(parsed->title, u"Close 12 tabs?");
  EXPECT_EQ(parsed->message, u"Pinned tabs stay open");
  EXPECT_EQ(parsed->confirm_title, u"Close Tabs");
  EXPECT_EQ(parsed->cancel_title, u"Keep Them");
  EXPECT_TRUE(parsed->destructive);
  ASSERT_TRUE(parsed->suppression);
  EXPECT_EQ(*parsed->suppression, u"Don't ask again");
  ASSERT_TRUE(parsed->window_id);
  EXPECT_EQ(*parsed->window_id, "window-7");
}
TEST(ShellUIOptionsTest, ConfirmDefaultsToAPlainDialogWithoutSuppression) {
  auto parsed = ParseShellConfirmOptions(
      base::DictValue().Set("title", "Clear history?"));
  ASSERT_TRUE(parsed);
  EXPECT_TRUE(parsed->confirm_title.empty());
  EXPECT_TRUE(parsed->cancel_title.empty());
  EXPECT_FALSE(parsed->destructive);
  EXPECT_FALSE(parsed->suppression);
  EXPECT_FALSE(parsed->window_id);
}
TEST(ShellUIOptionsTest, RejectsMalformedConfirmData) {
  const auto base = [] { return base::DictValue().Set("title", "Quit?"); };
  EXPECT_FALSE(ParseShellConfirmOptions(base::DictValue()));
  EXPECT_FALSE(ParseShellConfirmOptions(base().Set("destructive", "yes")));
  EXPECT_FALSE(ParseShellConfirmOptions(base().Set("suppression", "")));
  EXPECT_FALSE(ParseShellConfirmOptions(base().Set("suppression", true)));
  EXPECT_FALSE(ParseShellConfirmOptions(base().Set("windowId", "")));
  EXPECT_FALSE(ParseShellConfirmOptions(
      base().Set("cancelTitle", std::string(257, 'x'))));
  // Prompt fields don't belong to a confirmation.
  EXPECT_FALSE(ParseShellConfirmOptions(base().Set("value", "text")));
}
TEST(ShellUIOptionsTest, ParsesMenuItemsSeparatorsAndSubmenus) {
  auto items =
      base::ListValue()
          .Append(base::DictValue()
                      .Set("id", "copy")
                      .Set("title", "Copy Link")
                      .Set("shortcut", "Ctrl+Shift+C")
                      .Set("symbol", "link")
                      .Set("key", "c"))
          .Append(base::DictValue().Set("separator", true))
          .Append(base::DictValue()
                      .Set("id", "color")
                      .Set("title", "Color")
                      .Set("children", base::ListValue().Append(
                                           base::DictValue()
                                               .Set("id", "blue")
                                               .Set("title", "Blue")
                                               .Set("swatch", "#4C8DF6")
                                               .Set("checked", true))))
          .Append(base::DictValue()
                      .Set("id", "pin")
                      .Set("title", "Pin")
                      .Set("enabled", false));
  auto parsed = ParseShellMenuArgs(base::ListValue().Append(std::move(items)));
  ASSERT_TRUE(parsed);
  ASSERT_EQ(parsed->size(), 4u);
  const auto& copy = (*parsed)[0];
  EXPECT_EQ(copy.id, "copy");
  EXPECT_EQ(copy.title, u"Copy Link");
  EXPECT_EQ(copy.shortcut, u"Ctrl+Shift+C");
  EXPECT_TRUE(copy.enabled);
  EXPECT_FALSE(copy.checked);
  EXPECT_FALSE(copy.children);
  EXPECT_TRUE((*parsed)[1].separator);
  const auto& color = (*parsed)[2];
  ASSERT_TRUE(color.children);
  ASSERT_EQ(color.children->size(), 1u);
  const auto& blue = color.children->front();
  EXPECT_EQ(blue.swatch, 0xFF4C8DF6u);
  EXPECT_EQ(blue.checked, true);
  EXPECT_FALSE((*parsed)[3].enabled);
}
TEST(ShellUIOptionsTest, RejectsMalformedMenus) {
  const auto menu = [](base::Value item) {
    return ParseShellMenuArgs(
        base::ListValue().Append(base::ListValue().Append(std::move(item))));
  };
  EXPECT_FALSE(ParseShellMenuArgs(base::ListValue()));
  EXPECT_FALSE(ParseShellMenuArgs(base::ListValue().Append("items")));
  EXPECT_FALSE(menu(base::Value("copy")));
  EXPECT_FALSE(menu(base::Value(base::DictValue().Set("title", "No id"))));
  EXPECT_FALSE(menu(base::Value(base::DictValue().Set("id", "no-title"))));
  EXPECT_FALSE(menu(base::Value(
      base::DictValue().Set("id", "a").Set("title", "A").Set("enabled", 1))));
  EXPECT_FALSE(menu(base::Value(
      base::DictValue().Set("id", "a").Set("title", "A").Set("children", 1))));
  // Deeper than 16 submenus.
  base::Value deep(base::DictValue().Set("id", "leaf").Set("title", "Leaf"));
  for (int depth = 0; depth < 17; ++depth)
    deep = base::Value(
        base::DictValue()
            .Set("id", "s")
            .Set("title", "S")
            .Set("children", base::ListValue().Append(std::move(deep))));
  EXPECT_FALSE(menu(std::move(deep)));
  base::ListValue many;
  for (int i = 0; i < 1001; ++i)
    many.Append(base::DictValue().Set("separator", true));
  EXPECT_FALSE(ParseShellMenuArgs(base::ListValue().Append(std::move(many))));
}
TEST(ShellUIOptionsTest, ReadsSwatchesLikeMacOS) {
  EXPECT_EQ(ParseShellSwatch("#8E8E93"), 0xFF8E8E93u);
  EXPECT_EQ(ParseShellSwatch("8e8e93"), 0xFF8E8E93u);
  EXPECT_EQ(ParseShellSwatch("#11223380"), 0x80112233u);
  for (const char* bad : {"", "#", "#FFF", "#12345", "#1234567", "0x1234",
                          "+12345", "#GGGGGG", "#123456789"})
    EXPECT_FALSE(ParseShellSwatch(bad)) << bad;
}
TEST(ShellUIOptionsTest, NormalizesUserResponseLikeMacOS) {
  EXPECT_FALSE(NormalizeShellPromptText(u""));
  EXPECT_FALSE(NormalizeShellPromptText(u" \t\n\r\u2003\u00a0"));
  EXPECT_EQ(NormalizeShellPromptText(u" \u2003Bay \U0001f30a\n"),
            "Bay \xf0\x9f\x8c\x8a");
  EXPECT_EQ(NormalizeShellPromptText(u"  A  B  "), "A  B");
}
TEST(ShellUIOptionsTest, AcceptsMissingFilenameForFileTypeFallback) {
  auto parsed =
      ParseShellFileIconArgs(base::ListValue().Append("file.bin").Append(32));
  ASSERT_TRUE(parsed);
  EXPECT_EQ(parsed->path.AsUTF8Unsafe(), "file.bin");
  EXPECT_EQ(parsed->pixels, 64);
}
TEST(ShellUIOptionsTest, AcceptsAbsoluteFileAndBoundsImageResolution) {
#if BUILDFLAG(IS_WIN)
  const char* path = "C:\\Users\\someone\\Downloads\\file.pdf";
#else
  const char* path = "/tmp/file.pdf";
#endif
  auto parsed =
      ParseShellFileIconArgs(base::ListValue().Append(path).Append(256));
  ASSERT_TRUE(parsed);
  EXPECT_TRUE(parsed->path.IsAbsolute());
  EXPECT_EQ(parsed->pixels, 512);
  EXPECT_EQ(ParseShellFileIconArgs(base::ListValue().Append(path).Append(16.25))
                ->pixels,
            33);
}
TEST(ShellUIOptionsTest, RejectsAmbiguousOrInvalidIconPaths) {
  for (const auto* path : {"", ".", "..", "../file.pdf", "relative/file.pdf"})
    EXPECT_FALSE(
        ParseShellFileIconArgs(base::ListValue().Append(path).Append(32)))
        << path;
  EXPECT_FALSE(ParseShellFileIconArgs(
      base::ListValue().Append(std::string("file\0.pdf", 9)).Append(32)));
  EXPECT_FALSE(ParseShellFileIconArgs(
      base::ListValue().Append(std::string("bad\xff.pdf")).Append(32)));
  EXPECT_FALSE(ParseShellFileIconArgs(
      base::ListValue().Append(std::string(131069, 'x')).Append(32)));
#if BUILDFLAG(IS_WIN)
  EXPECT_FALSE(ParseShellFileIconArgs(
      base::ListValue().Append(std::string(32768, 'x')).Append(32)));
  for (const char* path : {"*.pdf", "file?.pdf"})
    EXPECT_FALSE(ParseShellFileIconArgs(
        base::ListValue().Append(path).Append(32)));
  EXPECT_FALSE(ParseShellFileIconArgs(
      base::ListValue().Append("C:relative.pdf").Append(32)));
  EXPECT_FALSE(ParseShellFileIconArgs(
      base::ListValue().Append("relative\\file.pdf").Append(32)));
#endif
}
TEST(ShellUIOptionsTest, HandlesLiteralFilenamePunctuationPerPlatform) {
#if BUILDFLAG(IS_WIN)
  for (const char* path : {"C:\\Downloads\\report?.pdf",
                           "C:\\Downloads\\report*.pdf"})
    EXPECT_FALSE(ParseShellFileIconArgs(
        base::ListValue().Append(path).Append(32)))
        << path;
#else
  for (const char* path : {"/tmp/report?.pdf", "/tmp/report*.pdf",
                           "/tmp/report:notes\\draft.pdf", "report?.pdf",
                           "report*.pdf", "report:notes\\draft.pdf"}) {
    auto parsed =
        ParseShellFileIconArgs(base::ListValue().Append(path).Append(32));
    ASSERT_TRUE(parsed) << path;
    EXPECT_EQ(parsed->path.AsUTF8Unsafe(), path);
  }
#endif
  EXPECT_FALSE(ParseShellFileIconArgs(
      base::ListValue().Append("/tmp/../report.pdf").Append(32)));
}
TEST(ShellUIOptionsTest, RejectsInvalidIconSizeOrWireShape) {
  EXPECT_FALSE(ParseShellFileIconArgs(base::ListValue()));
  EXPECT_FALSE(ParseShellFileIconArgs(base::ListValue().Append("file.bin")));
  EXPECT_FALSE(ParseShellFileIconArgs(base::ListValue().Append(42).Append(32)));
  EXPECT_FALSE(ParseShellFileIconArgs(
      base::ListValue().Append("file.bin").Append("32")));
  EXPECT_FALSE(ParseShellFileIconArgs(
      base::ListValue().Append("file.bin").Append(32).Append(true)));
  for (double size : {-1.0, 0.0, 0.5, 256.5, 1000000.0})
    EXPECT_FALSE(ParseShellFileIconArgs(
        base::ListValue().Append("file.bin").Append(size)))
        << size;
}
}  // namespace bay
