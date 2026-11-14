// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/nn_external_apps_platform.h"

#include <windows.h>

#include <shellapi.h>
#include <shlwapi.h>

#include <optional>
#include <string>
#include <vector>

#include "base/base64.h"
#include "base/strings/strcat.h"
#include "base/strings/utf_string_conversions.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/win/icon_util.h"

namespace bay {
namespace {
// The handler's own icon, from its executable, as a PNG data: URI.
std::optional<std::string> AppIcon(const std::wstring& association) {
  DWORD length = 0;
  AssocQueryStringW(ASSOCF_IS_PROTOCOL, ASSOCSTR_EXECUTABLE,
                    association.c_str(), nullptr, nullptr, &length);
  if (length == 0 || length > 32768)
    return std::nullopt;
  std::vector<wchar_t> path(length);
  if (FAILED(AssocQueryStringW(ASSOCF_IS_PROTOCOL, ASSOCSTR_EXECUTABLE,
                               association.c_str(), nullptr, path.data(),
                               &length))) {
    return std::nullopt;
  }
  HICON large = nullptr;
  if (ExtractIconExW(path.data(), 0, &large, nullptr, 1) != 1 || !large)
    return std::nullopt;
  const SkBitmap bitmap = IconUtil::CreateSkBitmapFromHICON(large);
  DestroyIcon(large);
  if (bitmap.drawsNothing())
    return std::nullopt;
  const auto png = gfx::PNGCodec::EncodeBGRASkBitmap(bitmap, false);
  if (!png)
    return std::nullopt;
  return base::StrCat({"data:image/png;base64,", base::Base64Encode(*png)});
}
}  // namespace

base::DictValue AppForScheme(const std::string& scheme) {
  const std::wstring association = base::UTF8ToWide(scheme);
  DWORD length = 0;
  AssocQueryStringW(ASSOCF_IS_PROTOCOL, ASSOCSTR_FRIENDLYAPPNAME,
                    association.c_str(), nullptr, nullptr, &length);
  base::DictValue result;
  result.Set("app", base::Value());
  result.Set("icon", base::Value());
  // Shell associations are user-controlled. Bound the allocation and let the
  // caller keep the allowance even when its handler was uninstalled.
  if (length == 0 || length > 32768) return result;
  std::vector<wchar_t> name(length);
  if (SUCCEEDED(AssocQueryStringW(ASSOCF_IS_PROTOCOL, ASSOCSTR_FRIENDLYAPPNAME,
                                association.c_str(), nullptr, name.data(), &length))) {
    result.Set("app", base::WideToUTF8(name.data()));
    if (const auto icon = AppIcon(association))
      result.Set("icon", *icon);
  }
  return result;
}

}  // namespace bay
