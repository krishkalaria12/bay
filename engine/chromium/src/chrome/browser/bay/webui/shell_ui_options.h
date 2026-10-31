// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_SHELL_UI_OPTIONS_H_
#define CHROME_BROWSER_BAY_WEBUI_SHELL_UI_OPTIONS_H_

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/files/file_path.h"
#include "base/values.h"

namespace bay {
struct ShellPromptOptions {
  std::u16string title;
  std::u16string message;
  std::u16string value;
  std::u16string placeholder;
  std::u16string confirm_title;
  std::optional<std::string> window_id;
};
struct ShellConfirmOptions {
  std::u16string title;
  std::u16string message;
  std::u16string confirm_title;
  std::u16string cancel_title;
  bool destructive = false;
  // The "Don't ask again" checkbox label, when the caller offers one.
  std::optional<std::u16string> suppression;
  std::optional<std::string> window_id;
};
struct ShellMenuItem {
  bool separator = false;
  std::string id;
  std::u16string title;
  // The trailing hint, already formatted for the platform ("Ctrl+Shift+C").
  std::u16string shortcut;
  // A color dot before the title, as 0xAARRGGBB.
  std::optional<uint32_t> swatch;
  bool enabled = true;
  // Present makes a check item.
  std::optional<bool> checked;
  // Present makes a submenu.
  std::optional<std::vector<ShellMenuItem>> children;
};
struct ShellIconRequest {
  base::FilePath path;
  int pixels;
};
std::optional<ShellPromptOptions> ParseShellPromptOptions(
    const base::DictValue& options);
std::optional<ShellConfirmOptions> ParseShellConfirmOptions(
    const base::DictValue& options);
// BayShell.showMenu's one argument. Fields only macOS draws (symbol, key and
// modifiers) are ignored.
std::optional<std::vector<ShellMenuItem>> ParseShellMenuArgs(
    const base::ListValue& args);
// "#RRGGBB" or "#RRGGBBAA", with or without the "#", as macOS reads swatches.
std::optional<uint32_t> ParseShellSwatch(std::string_view hex);
std::optional<ShellIconRequest> ParseShellFileIconArgs(
    const base::ListValue& args);
// Matches the macOS shell: accepting whitespace-only text is cancellation.
std::optional<std::string> NormalizeShellPromptText(std::u16string_view text);
}  // namespace bay
#endif
