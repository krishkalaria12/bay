// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/shell_clipboard.h"

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/base64.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/test/bind.h"
#include "base/test/task_environment.h"
#include "base/test/test_future.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/base/clipboard/clipboard.h"
#include "ui/base/clipboard/test/test_clipboard.h"
#include "ui/gfx/codec/jpeg_codec.h"
#include "ui/gfx/codec/png_codec.h"

namespace bay {
namespace {

constexpr auto kBuffer = ui::ClipboardBuffer::kCopyPaste;

class ShellClipboardTest : public testing::Test {
 protected:
  void SetUp() override { ui::TestClipboard::CreateForCurrentThread(); }
  void TearDown() override {
    ui::Clipboard::DestroyClipboardForCurrentThread();
  }

  std::string Invoke(const std::string& method, base::ListValue args) {
    base::test::TestFuture<const std::string&> result;
    auto callback = result.GetCallback();
    EXPECT_TRUE(ShellClipboard::Dispatch("BayShell", method, args, callback));
    EXPECT_TRUE(result.IsReady());
    EXPECT_FALSE(callback);
    return result.Get();
  }
  std::string Copy(const std::string& method, const std::string& text) {
    return Invoke(method, base::ListValue().Append(text));
  }
  std::u16string ReadText() {
    base::test::TestFuture<std::u16string> result;
    ui::Clipboard::GetForCurrentThread()->ReadText(kBuffer, std::nullopt,
                                                   result.GetCallback());
    return result.Get();
  }
  SkBitmap ReadImage() {
    base::test::TestFuture<const std::vector<uint8_t>&> result;
    ui::Clipboard::GetForCurrentThread()->ReadPng(kBuffer, std::nullopt,
                                                  result.GetCallback());
    return gfx::PNGCodec::Decode(result.Get());
  }
  void ExpectInvalid(const std::string& response) {
    auto parsed = base::JSONReader::ReadDict(response, base::JSON_PARSE_RFC);
    ASSERT_TRUE(parsed);
    const auto* code = parsed->FindStringByDottedPath("error.code");
    ASSERT_TRUE(code);
    EXPECT_EQ(*code, "invalid_args");
    EXPECT_EQ(ReadText(), u"keep");
  }

  base::test::TaskEnvironment tasks_{
      base::test::TaskEnvironment::MainThreadType::UI};
};

TEST_F(ShellClipboardTest, AdvertisesOnlyShellClipboardMethods) {
  auto methods = ShellClipboard::SupportedMethods();
  EXPECT_EQ(methods.size(), 2u);
  EXPECT_TRUE(methods.contains("BayShell.copyText"));
  EXPECT_TRUE(methods.contains("BayShell.copyImage"));
}

TEST_F(ShellClipboardTest,
       UnhandledDispatchLeavesResponseAndClipboardUntouched) {
  Copy("copyText", "keep");
  base::test::TestFuture<const std::string&> result;
  auto callback = result.GetCallback();
  EXPECT_FALSE(ShellClipboard::Dispatch("BaySystem", "copyText", {}, callback));
  EXPECT_FALSE(ShellClipboard::Dispatch("BayShell", "showMenu", {}, callback));
  EXPECT_FALSE(result.IsReady());
  EXPECT_TRUE(callback);
  EXPECT_EQ(ReadText(), u"keep");
}

TEST_F(ShellClipboardTest, WritesUnicodeTextIncludingEmbeddedNullAndEmptyText) {
  EXPECT_EQ(Copy("copyText", std::string("café \xf0\x9f\x8c\x8a\0end", 14)),
            R"({"value":null})");
  EXPECT_EQ(ReadText(), std::u16string(u"café 🌊\0end", 11));
  EXPECT_EQ(Copy("copyText", ""), R"({"value":null})");
  EXPECT_TRUE(ReadText().empty());
}

TEST_F(ShellClipboardTest, RejectsMissingAndNonStringArgumentsWithoutWriting) {
  Copy("copyText", "keep");
  for (const char* method : {"copyText", "copyImage"}) {
    ExpectInvalid(Invoke(method, {}));
    for (const char* json : {"[null]", "[1]", "[true]", "[{}]", "[[]]"}) {
      auto args = base::JSONReader::ReadList(json, base::JSON_PARSE_RFC);
      ASSERT_TRUE(args);
      ExpectInvalid(Invoke(method, std::move(*args)));
    }
  }
}

TEST_F(ShellClipboardTest,
       KeepsFirstArgumentSemanticsForContractValidatedCallers) {
  EXPECT_EQ(Invoke("copyText", base::ListValue().Append("text").Append(1)),
            R"({"value":null})");
  EXPECT_EQ(ReadText(), u"text");
}

TEST_F(ShellClipboardTest, RejectsMalformedBase64AndDataUrlsWithoutWriting) {
  Copy("copyText", "keep");
  for (const char* text : {"%%%", "a", "data:image/png;base64,AAAA"})
    ExpectInvalid(Copy("copyImage", text));
}

TEST_F(ShellClipboardTest, ReturnsFalseForEmptyUnsupportedOrCorruptImageBytes) {
  Copy("copyText", "keep");
  for (const std::string& bytes :
       {std::string(), std::string("not an image"), std::string("GIF89a"),
        std::string("\x89PNG\r\n\x1a\n"), std::string("\xff\xd8\xff")}) {
    EXPECT_EQ(Copy("copyImage", base::Base64Encode(bytes)),
              R"({"value":false})");
    EXPECT_EQ(ReadText(), u"keep");
  }
}

TEST_F(ShellClipboardTest, RejectsPngDimensionsBeyondTheCodecLimits) {
  Copy("copyText", "keep");
  // Complete PNG containers with valid checksums and tiny pixel streams.
  // The codec must reject the dimensions before allocating a pixel buffer.
  // First: width 1,000,001. Second: 32,768 * 16,384 * 4 >= INT_MAX bytes.
  for (const char* encoded : {
           "iVBORw0KGgoAAAANSUhEUgAPQkEAAAABCAYAAAB9H/"
           "x2AAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
           "iVBORw0KGgoAAAANSUhEUgAAgAAAAEAACAYAAAAIYTz0AAAAC0lEQVR4nGNgAAIAAAU"
           "AAXpeqz8AAAAASUVORK5CYII=",
       }) {
    EXPECT_EQ(Copy("copyImage", encoded), R"({"value":false})");
    EXPECT_EQ(ReadText(), u"keep");
  }
}

TEST_F(ShellClipboardTest, WritesPngPixelsWithTransparency) {
  SkBitmap image;
  image.allocN32Pixels(2, 1);
  image.eraseColor(SkColorSetARGB(128, 0, 255, 0));
  auto png = gfx::PNGCodec::EncodeBGRASkBitmap(image, false);
  ASSERT_TRUE(png);
  EXPECT_EQ(Copy("copyImage", base::Base64Encode(*png)), R"({"value":true})");
  const auto copied = ReadImage();
  ASSERT_FALSE(copied.isNull());
  EXPECT_EQ(copied.width(), 2);
  EXPECT_EQ(copied.height(), 1);
  EXPECT_EQ(copied.getColor(0, 0), image.getColor(0, 0));
}

TEST_F(ShellClipboardTest, WritesJpegPixelsThroughTheFallbackDecoder) {
  SkBitmap image;
  image.allocN32Pixels(2, 2);
  image.eraseColor(SK_ColorRED);
  auto jpeg = gfx::JPEGCodec::Encode(image, 100);
  ASSERT_TRUE(jpeg);
  const auto expected = gfx::JPEGCodec::Decode(*jpeg);
  ASSERT_FALSE(expected.isNull());
  EXPECT_EQ(Copy("copyImage", base::Base64Encode(*jpeg)), R"({"value":true})");
  const auto copied = ReadImage();
  ASSERT_FALSE(copied.isNull());
  EXPECT_EQ(copied.width(), expected.width());
  EXPECT_EQ(copied.height(), expected.height());
  EXPECT_EQ(copied.getColor(0, 0), expected.getColor(0, 0));
}

TEST_F(ShellClipboardTest, CommitsBeforeTheResponseAndAllowsAReentrantWrite) {
  int calls = 0;
  ShellClipboard::Response callback =
      base::BindLambdaForTesting([this, &calls](const std::string& response) {
        ++calls;
        EXPECT_EQ(response, R"({"value":null})");
        EXPECT_EQ(ReadText(), u"first");
        EXPECT_EQ(Copy("copyText", "second"), R"({"value":null})");
      });
  EXPECT_TRUE(ShellClipboard::Dispatch(
      "BayShell", "copyText", base::ListValue().Append("first"), callback));
  EXPECT_EQ(ReadText(), u"second");
  tasks_.RunUntilIdle();
  EXPECT_EQ(calls, 1);
}

}  // namespace
}  // namespace bay
