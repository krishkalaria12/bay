// Copyright 2026 Bay. Apache-2.0.
//
// Dia's controls for the video Picture in Picture window, as subclasses of Chrome's,
// so VideoOverlayWindowViews keeps driving them: the corner buttons, the bare
// play/pause glyph, the progress bar and the controls' fade.

#ifndef CHROME_BROWSER_BAY_PIP_NN_PIP_CONTROLS_H_
#define CHROME_BROWSER_BAY_PIP_NN_PIP_CONTROLS_H_

#include <optional>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/timer/timer.h"
#include "chrome/browser/ui/views/overlay/back_to_tab_button.h"
#include "chrome/browser/ui/views/overlay/close_image_button.h"
#include "chrome/browser/ui/views/overlay/overlay_controls_fade_animation.h"
#include "chrome/browser/ui/views/overlay/playback_image_button.h"
#include "services/media_session/public/cpp/media_position.h"
#include "ui/base/metadata/metadata_header_macros.h"
#include "ui/views/view.h"

namespace gfx {
class Canvas;
}  // namespace gfx

// The corner buttons are a rounded square of white at 9 % (13 % under the
// pointer) holding a 1 pt white line glyph, with no ink drop, 12 pt from the
// window's top and side.
inline constexpr int kBayPipButtonMargin = 12;
inline constexpr int kBayPipButtonSize = 28;
// The app's speed button beside back to tab and its subtitles button beside
// close (packages/nncore/ios/NNCorePictureInPicture.mm), with the 6 pt gap
// before each: the origin keeps clear of the wider of them.
inline constexpr int kBayPipAppButtonsWidth = 6 + 42;

// Back to tab (top left): Dia's ↖, 28 × 28.
class BayBackToTabButton : public OverlayWindowBackToTabButton {
  METADATA_HEADER(BayBackToTabButton, OverlayWindowBackToTabButton)

 public:
  explicit BayBackToTabButton(PressedCallback callback);
  BayBackToTabButton(const BayBackToTabButton&) = delete;
  BayBackToTabButton& operator=(const BayBackToTabButton&) = delete;
  ~BayBackToTabButton() override;

  // Positions it for a window of `window_size`.
  void Place(const gfx::Size& window_size);

 protected:
  // views::View:
  void OnPaintBackground(gfx::Canvas* canvas) override;
  // views::Button:
  void PaintButtonContents(gfx::Canvas* canvas) override;
};

// Close (top right): Dia's ×, 1 pt wider than back to tab (29 × 28).
class BayCloseButton : public CloseImageButton {
  METADATA_HEADER(BayCloseButton, CloseImageButton)

 public:
  static constexpr int kWidth = 29;

  explicit BayCloseButton(PressedCallback callback);
  BayCloseButton(const BayCloseButton&) = delete;
  BayCloseButton& operator=(const BayCloseButton&) = delete;
  ~BayCloseButton() override;

  // Positions it for a window of `window_size`.
  void Place(const gfx::Size& window_size);

 protected:
  // views::View:
  void OnPaintBackground(gfx::Canvas* canvas) override;
  // views::Button:
  void PaintButtonContents(gfx::Canvas* canvas) override;
};

// Play/pause: no circle and no ink drop. Pause is two white 7 × 42 pt capsules
// 10 pt apart; play is a rounded triangle of the same height; replay keeps
// Chrome's icon, at 36 pt. A friend of PlaybackImageButton (hook patch) to read
// its state and resize its replay image.
class BayPlaybackButton : public PlaybackImageButton {
  METADATA_HEADER(BayPlaybackButton, PlaybackImageButton)

 public:
  explicit BayPlaybackButton(PressedCallback callback);
  BayPlaybackButton(const BayPlaybackButton&) = delete;
  BayPlaybackButton& operator=(const BayPlaybackButton&) = delete;
  ~BayPlaybackButton() override;

 protected:
  // views::View:
  void OnPaintBackground(gfx::Canvas* canvas) override;
  // views::Button:
  void PaintButtonContents(gfx::Canvas* canvas) override;
};

// Dia's progress bar: a 5 pt white capsule over a track of white at 27 %, 12 pt
// from the sides and 9 pt from the bottom. Click or drag to seek; the bar holds
// the released position until the page reports the seek.
class BayProgressBar : public views::View {
  METADATA_HEADER(BayProgressBar, views::View)

 public:
  // Hit slop around the bar, on every side.
  static constexpr int kSlopX = 4;
  static constexpr int kSlopY = 6;
  static constexpr float kBarHeight = 5;

  explicit BayProgressBar(base::RepeatingCallback<void(double)> seek);
  BayProgressBar(const BayProgressBar&) = delete;
  BayProgressBar& operator=(const BayProgressBar&) = delete;
  ~BayProgressBar() override;

  void SetMediaPosition(const media_session::MediaPosition& position);

  // Positions it for a window of `window_size`.
  void Place(const gfx::Size& window_size);

  // views::View:
  void OnPaint(gfx::Canvas* canvas) override;
  bool OnMousePressed(const ui::MouseEvent& event) override;
  bool OnMouseDragged(const ui::MouseEvent& event) override;
  void OnMouseReleased(const ui::MouseEvent& event) override;
  void OnMouseCaptureLost() override;
  ui::Cursor GetCursor(const ui::MouseEvent& event) override;

 private:
  double FractionAt(int x) const;
  void RepaintIfDrawn();

  base::RepeatingCallback<void(double)> seek_;
  media_session::MediaPosition position_;
  std::optional<double> drag_fraction_;
  bool dragging_ = false;
  base::RepeatingTimer timer_;
};

// The controls fade in and out over 200 ms with an ease-in-out curve (Chrome:
// 250 ms, linear).
class BayControlsFadeAnimation : public OverlayControlsFadeAnimation {
 public:
  BayControlsFadeAnimation(
      const std::vector<raw_ptr<views::View>>& controls,
      Type type);
  BayControlsFadeAnimation(const BayControlsFadeAnimation&) =
      delete;
  BayControlsFadeAnimation& operator=(
      const BayControlsFadeAnimation&) = delete;
  ~BayControlsFadeAnimation() override;

  // OverlayControlsFadeAnimation:
  void AnimateToState(double state) override;
};

#endif  // CHROME_BROWSER_BAY_PIP_NN_PIP_CONTROLS_H_
