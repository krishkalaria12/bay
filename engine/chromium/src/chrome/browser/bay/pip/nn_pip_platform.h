// Copyright 2026 Bay. Apache-2.0.
//
// Platform storage and window fade for Bay's video Picture in Picture window.

#ifndef CHROME_BROWSER_BAY_PIP_NN_PIP_PLATFORM_H_
#define CHROME_BROWSER_BAY_PIP_NN_PIP_PLATFORM_H_

#include <optional>

#include "base/time/time.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/native_ui_types.h"

// The window opens where the user last left it, across sessions and restarts:
// screen DIPs in BayPictureInPicture.plist on macOS or BayPictureInPicture.json
// on Aura, in the user data directory. Window placement remains subject to
// the window system's rules.
std::optional<gfx::Rect> LoadBayPictureInPictureBounds();
void SaveBayPictureInPictureBounds(const gfx::Rect& bounds);

// Fades the window's content out using the platform compositor while the tab
// it goes back to is being shown. Reset puts it back before the window shows.
void FadeOutBayPictureInPicture(gfx::NativeWindow window,
                                      base::TimeDelta duration);
void ResetBayPictureInPictureFade(gfx::NativeWindow window);

#endif  // CHROME_BROWSER_BAY_PIP_NN_PIP_PLATFORM_H_
