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
  for (const auto* path : {"", ".", "..", "../file.pdf", "relative/file.pdf",
                           "*.pdf", "file?.pdf"})
    EXPECT_FALSE(
        ParseShellFileIconArgs(base::ListValue().Append(path).Append(32)))
        << path;
  EXPECT_FALSE(ParseShellFileIconArgs(
      base::ListValue().Append(std::string("file\0.pdf", 9)).Append(32)));
  EXPECT_FALSE(ParseShellFileIconArgs(
      base::ListValue().Append(std::string(32768, 'x')).Append(32)));
#if BUILDFLAG(IS_WIN)
  EXPECT_FALSE(ParseShellFileIconArgs(
      base::ListValue().Append("C:relative.pdf").Append(32)));
  EXPECT_FALSE(ParseShellFileIconArgs(
      base::ListValue().Append("relative\\file.pdf").Append(32)));
#endif
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
