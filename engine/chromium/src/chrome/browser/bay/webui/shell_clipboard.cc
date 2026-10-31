// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/shell_clipboard.h"

#include <utility>

#include "base/base64.h"
#include "base/containers/span.h"
#include "base/json/json_writer.h"
#include "base/strings/utf_string_conversions.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/base/clipboard/scoped_clipboard_writer.h"
#include "ui/gfx/codec/jpeg_codec.h"
#include "ui/gfx/codec/png_codec.h"

namespace bay {
namespace {

std::string Success(base::Value value = {}) {
  return base::WriteJson(base::DictValue().Set("value", std::move(value)))
      .value_or("{}");
}

std::string InvalidArguments() {
  return base::WriteJson(
             base::DictValue().Set(
                 "error",
                 base::DictValue()
                     .Set("code", "invalid_args")
                     .Set("message", "Invalid native method arguments")))
      .value_or("{}");
}

}  // namespace

// static
base::ListValue ShellClipboard::SupportedMethods() {
  return base::ListValue()
      .Append("BayShell.copyText")
      .Append("BayShell.copyImage");
}

// static
bool ShellClipboard::Dispatch(const std::string& module,
                              const std::string& method,
                              const base::ListValue& args,
                              Response& callback) {
  if (module != "BayShell" || (method != "copyText" && method != "copyImage"))
    return false;
  if (args.empty() || !args[0].is_string()) {
    std::move(callback).Run(InvalidArguments());
    return true;
  }
  const auto& text = args[0].GetString();
  if (method == "copyText") {
    {
      ui::ScopedClipboardWriter writer(ui::ClipboardBuffer::kCopyPaste);
      writer.WriteText(base::UTF8ToUTF16(text));
    }
    std::move(callback).Run(Success());
    return true;
  }

  std::string bytes;
  if (!base::Base64Decode(text, &bytes)) {
    std::move(callback).Run(InvalidArguments());
    return true;
  }
  // Retain Windows' PNG-then-JPEG decoding and codec allocation limits. These
  // codecs return owned N32 pixels, as required by ScopedClipboardWriter.
  auto bitmap = gfx::PNGCodec::Decode(base::as_byte_span(bytes));
  if (bitmap.isNull())
    bitmap = gfx::JPEGCodec::Decode(base::as_byte_span(bytes));
  if (!bitmap.isNull()) {
    ui::ScopedClipboardWriter writer(ui::ClipboardBuffer::kCopyPaste);
    writer.WriteImage(bitmap);
  }
  std::move(callback).Run(Success(base::Value(!bitmap.isNull())));
  return true;
}

}  // namespace bay
