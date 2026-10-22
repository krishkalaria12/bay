// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_SHELL_UI_OPTIONS_H_
#define CHROME_BROWSER_BAY_WEBUI_SHELL_UI_OPTIONS_H_

#include <optional>
#include <string>
#include <string_view>

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
struct ShellIconRequest {
  base::FilePath path;
  int pixels;
};
std::optional<ShellPromptOptions> ParseShellPromptOptions(
    const base::DictValue& options);
std::optional<ShellConfirmOptions> ParseShellConfirmOptions(
    const base::DictValue& options);
std::optional<ShellIconRequest> ParseShellFileIconArgs(
    const base::ListValue& args);
// Matches the macOS shell: accepting whitespace-only text is cancellation.
std::optional<std::string> NormalizeShellPromptText(std::u16string_view text);
}  // namespace bay
#endif
