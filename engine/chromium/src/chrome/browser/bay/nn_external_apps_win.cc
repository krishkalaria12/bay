// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/nn_external_apps_platform.h"

#include <windows.h>
#include <shlwapi.h>

#include <string>
#include <vector>

#include "base/strings/utf_string_conversions.h"

namespace bay {

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
  }
  return result;
}

}  // namespace bay
