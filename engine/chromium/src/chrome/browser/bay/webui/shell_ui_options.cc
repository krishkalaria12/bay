// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/shell_ui_options.h"

#include <algorithm>
#include <cmath>
#include <utility>

#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "build/build_config.h"

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
// A dialog targets the caller's own window unless it names one.
bool WindowId(const base::DictValue& options,
              std::optional<std::string>& output) {
  const auto* window = options.Find("windowId");
  if (!window)
    return true;
  if (!window->is_string() || window->GetString().empty() ||
      window->GetString().size() > 128 ||
      window->GetString().find('\0') != std::string::npos ||
      !base::IsStringUTF8(window->GetString()))
    return false;
  output = window->GetString();
  return true;
}
// The limits Windows' menu builder enforced: 16 levels and 1000 items.
bool MenuItems(const base::ListValue& items,
               unsigned depth,
               size_t& count,
               std::vector<ShellMenuItem>& output) {
  if (depth > 16)
    return false;
  for (const auto& value : items) {
    if (++count > 1000)
      return false;
    const auto* item = value.GetIfDict();
    if (!item)
      return false;
    ShellMenuItem parsed;
    if (item->FindBool("separator").value_or(false)) {
      parsed.separator = true;
      output.push_back(std::move(parsed));
      continue;
    }
    const auto* id = item->FindString("id");
    if (!id || id->size() > 4096 ||
        !Text(*item, "title", 4096, parsed.title, true) ||
        !Text(*item, "shortcut", 64, parsed.shortcut))
      return false;
    parsed.id = *id;
    if (const auto* swatch = item->FindString("swatch"))
      parsed.swatch = ParseShellSwatch(*swatch);
    if (const auto* enabled = item->Find("enabled")) {
      if (!enabled->is_bool())
        return false;
      parsed.enabled = enabled->GetBool();
    }
    if (const auto* checked = item->Find("checked")) {
      if (!checked->is_bool())
        return false;
      parsed.checked = checked->GetBool();
    }
    if (const auto* children = item->Find("children")) {
      if (!children->is_list())
        return false;
      parsed.children.emplace();
      if (!MenuItems(children->GetList(), depth + 1, count, *parsed.children))
        return false;
    }
    output.push_back(std::move(parsed));
  }
  return true;
}
}  // namespace
std::optional<std::vector<ShellMenuItem>> ParseShellMenuArgs(
    const base::ListValue& args) {
  if (args.size() != 1 || !args[0].is_list())
    return std::nullopt;
  std::vector<ShellMenuItem> items;
  size_t count = 0;
  if (!MenuItems(args[0].GetList(), 0, count, items))
    return std::nullopt;
  return items;
}
std::optional<uint32_t> ParseShellSwatch(std::string_view hex) {
  if (hex.starts_with('#'))
    hex.remove_prefix(1);
  uint32_t value = 0;
  // HexStringToUInt alone would also take "0x" and a sign.
  if ((hex.size() != 6 && hex.size() != 8) ||
      !std::ranges::all_of(hex, base::IsHexDigit<char>) ||
      !base::HexStringToUInt(hex, &value))
    return std::nullopt;
  // RRGGBB is opaque; RRGGBBAA moves its alpha to the top byte.
  return hex.size() == 6 ? 0xFF000000u | value : (value >> 8) | (value << 24);
}
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
      !Text(options, "confirmTitle", 256, parsed.confirm_title) ||
      !WindowId(options, parsed.window_id))
    return std::nullopt;
  return parsed;
}
std::optional<ShellConfirmOptions> ParseShellConfirmOptions(
    const base::DictValue& options) {
  for (const auto [key, value] : options) {
    if (key != "title" && key != "message" && key != "confirmTitle" &&
        key != "cancelTitle" && key != "destructive" && key != "suppression" &&
        key != "windowId")
      return std::nullopt;
  }
  ShellConfirmOptions parsed;
  if (!Text(options, "title", 4096, parsed.title, true) ||
      !Text(options, "message", 65536, parsed.message) ||
      !Text(options, "confirmTitle", 256, parsed.confirm_title) ||
      !Text(options, "cancelTitle", 256, parsed.cancel_title) ||
      !WindowId(options, parsed.window_id))
    return std::nullopt;
  if (const auto* destructive = options.Find("destructive")) {
    if (!destructive->is_bool())
      return std::nullopt;
    parsed.destructive = destructive->GetBool();
  }
  if (options.contains("suppression")) {
    std::u16string label;
    if (!Text(options, "suppression", 256, label) || label.empty())
      return std::nullopt;
    parsed.suppression = std::move(label);
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
      value.find('\0') != std::string::npos ||
      !base::IsStringUTF8(value) || !points || !std::isfinite(*points) ||
      *points < 1 || *points > 256)
    return std::nullopt;
  auto path = base::FilePath::FromUTF8Unsafe(value);
#if BUILDFLAG(IS_WIN)
  if (path.value().size() > 32767 ||
      value.find_first_of("*?") != std::string::npos ||
      (!path.IsAbsolute() && value.find_first_of("/\\:") != std::string::npos))
    return std::nullopt;
#endif
  // A missing file name deliberately asks for its file-type icon. Relative
  // directory paths would instead depend on the browser's working directory.
  // POSIX names treat backslashes, colons, '*' and '?' as literal characters.
  if (path.ReferencesParent() ||
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
