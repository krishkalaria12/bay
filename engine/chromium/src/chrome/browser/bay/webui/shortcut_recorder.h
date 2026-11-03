// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_SHORTCUT_RECORDER_H_
#define CHROME_BROWSER_BAY_WEBUI_SHORTCUT_RECORDER_H_

#include <optional>

#include "base/values.h"

namespace bay {
// What a key press answers BaySystem.recordShortcut with, in the menus'
// vocabulary (ShortcutRecorder in System.swift): nothing while recording goes
// on, null for cancelled, or `{key, modifiers, keyCode}`. Ctrl is "command":
// the modifier Bay's shortcuts call `mod`. `keyCode` is the virtual key the
// host matches shortcuts by, so a shortcut follows the key on any layout.
std::optional<base::Value> RecordedShortcutFor(int key_code,
                                               bool ctrl,
                                               bool shift,
                                               bool alt,
                                               bool meta);
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_SHORTCUT_RECORDER_H_
