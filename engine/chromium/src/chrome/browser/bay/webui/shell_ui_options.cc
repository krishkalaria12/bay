// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/shell_ui_options.h"

#include <cmath>
#include <utility>

#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"

namespace bay {
namespace {
bool Text(const base::DictValue& options,
          const char* key,
          size_t limit,
          std::u16string& output,
          bool required = false) {
  const auto* item = options.Find(key);
  if (!item)
    return !required;
  if (!item->is_string())
    return false;
  const auto& value = item->GetString();
  if (value.size() > limit || value.find('\0') != std::string::npos ||
      !base::IsStringUTF8(value))
    return false;
  output = base::UTF8ToUTF16(value);
  return true;
}
}  // namespace
std::optional<ShellPromptOptions> ParseShellPromptOptions(
    const base::DictValue& options) {
  for (const auto [key, value] : options) {
    if (key != "title" && key != "message" && key != "value" &&
        key != "placeholder" && key != "confirmTitle" && key != "windowId")
      return std::nullopt;
  }
  ShellPromptOptions parsed;
  if (!Text(options, "title", 4096, parsed.title, true) ||
      !Text(options, "message", 65536, parsed.message) ||
      !Text(options, "value", 65536, parsed.value) ||
      !Text(options, "placeholder", 4096, parsed.placeholder) ||
      !Text(options, "confirmTitle", 256, parsed.confirm_title))
    return std::nullopt;
  if (const auto* window = options.Find("windowId")) {
    if (!window->is_string() || window->GetString().empty() ||
        window->GetString().size() > 128 ||
        window->GetString().find('\0') != std::string::npos ||
        !base::IsStringUTF8(window->GetString()))
      return std::nullopt;
    parsed.window_id = window->GetString();
  }
  return parsed;
}
std::optional<ShellIconRequest> ParseShellFileIconArgs(
    const base::ListValue& args) {
  if (args.size() != 2 || !args[0].is_string())
    return std::nullopt;
  const auto& value = args[0].GetString();
  const auto points = args[1].GetIfDouble();
  if (value.empty() || value == "." || value.size() > 131068 ||
      value.find_first_of(std::string("\0*?", 3)) != std::string::npos ||
      !base::IsStringUTF8(value) || !points || !std::isfinite(*points) ||
      *points < 1 || *points > 256)
    return std::nullopt;
  auto path = base::FilePath::FromUTF8Unsafe(value);
  // A missing file name deliberately asks for its file-type icon. Relative
  // directory paths would instead depend on the browser's working directory.
  if (path.value().size() > 32767 || path.ReferencesParent() ||
      (!path.IsAbsolute() && path != path.BaseName()))
    return std::nullopt;
  return ShellIconRequest{std::move(path),
                          static_cast<int>(std::round(*points * 2))};
}
std::optional<std::string> NormalizeShellPromptText(std::u16string_view text) {
  const auto trimmed = base::TrimWhitespace(text, base::TRIM_ALL);
  if (trimmed.empty())
    return std::nullopt;
  return base::UTF16ToUTF8(trimmed);
}
}  // namespace bay
