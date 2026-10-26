// Copyright 2026 Bay. Apache-2.0.
//
// Platform support for the video Picture in Picture window: remembered bounds,
// its close fade, and telling the host when its controls show.

#ifndef CHROME_BROWSER_BAY_PIP_NN_PIP_PLATFORM_H_
#define CHROME_BROWSER_BAY_PIP_NN_PIP_PLATFORM_H_

#include <optional>

#include "base/time/time.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/native_ui_types.h"

// The window opens where the user last left it, across sessions and restarts:
// screen DIPs in BayPictureInPicture.plist in the user data dir (a file
// rather than user defaults, so test instances with their own data dir keep
// their own).
std::optional<gfx::Rect> LoadBayPictureInPictureBounds();
void SaveBayPictureInPictureBounds(const gfx::Rect& bounds);

// Fades the window's content out (and drops its shadow) in Core Animation, off
// the main thread, so it stays smooth while the tab it goes back to is being
// shown; Reset puts it back before the window shows again.
void FadeOutBayPictureInPicture(gfx::NativeWindow window,
                                      base::TimeDelta duration);
void ResetBayPictureInPictureFade(gfx::NativeWindow window);

// The controls showed or hid by Chrome's rules. On macOS the app's overlay
// follows via BayPictureInPictureControlsDidChange, with the NSWindow as the
// object and {visible, animate} as NSNumbers. Other hosts use Chrome's controls.
void NotifyBayPictureInPictureControls(gfx::NativeWindow window,
                                       bool visible,
                                       bool animate);

#endif  // CHROME_BROWSER_BAY_PIP_NN_PIP_PLATFORM_H_
