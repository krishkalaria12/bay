// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_DRAG_PREVIEW_H_
#define CHROME_BROWSER_BAY_WEBUI_DRAG_PREVIEW_H_

#include <memory>
#include <optional>
#include <string>

#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/image/image.h"
#include "ui/gfx/image/image_skia.h"

class BrowserWindowInterface;
namespace views {
class Widget;
}

namespace bay {
class DragPreviewView;

// A tab dragged out of its window (DragPreview in Windows.swift): its pill
// while it's over a tab list, a card of its page anywhere else, which grows
// into the new window a drop makes. Points are in the source window, from its
// top left, as the tab strip measures them; the preview floats on screen.
// Only on desktops that place windows globally (not Wayland).
class DragPreview {
 public:
  static DragPreview& Get();

  void Begin(BrowserWindowInterface* source, const gfx::Rect& chip,
             const gfx::Point& grab);
  // The page as the engine painted it, a JPEG.
  void SetPage(const std::string& jpeg);
  // A tab never painted: its title where its page would be.
  void SetPlaceholder(const std::u16string& title);
  // "hidden", "pill" or "card", with the pointer.
  void Update(const std::string& shape, const gfx::Point& pointer);
  // Grows into `target`'s window (or `fallback`, a frame on screen) and fades,
  // or just fades.
  void End(BrowserWindowInterface* target, std::optional<gfx::Rect> fallback);
  void Cancel();

  std::string shape_for_testing() const { return shape_; }
  gfx::Rect bounds_for_testing() const;

 private:
  friend class base::NoDestructor<DragPreview>;
  DragPreview();
  ~DragPreview();

  void Snapshotted(uint64_t generation, bool pill, gfx::Image image);
  void Place(bool animated);
  void Animate(const gfx::Rect& to, float opacity, base::TimeDelta duration,
               base::OnceClosure done);
  void Step();
  void Close();

  uint64_t generation_ = 0;
  base::WeakPtr<BrowserWindowInterface> source_;
  gfx::Point origin_;
  gfx::Size pill_size_;
  gfx::Point grab_;
  gfx::Point pointer_;
  std::string shape_ = "hidden";
  gfx::ImageSkia pill_image_;
  gfx::ImageSkia window_image_;
  gfx::ImageSkia page_image_;
  std::u16string placeholder_;
  std::unique_ptr<views::Widget> widget_;
  raw_ptr<DragPreviewView> view_ = nullptr;
  // A frame and opacity animation, as AppKit's animator doesn't run for an
  // inactive app's panel; driven here the same way on every desktop.
  base::RepeatingTimer animation_;
  gfx::Rect from_, to_;
  float from_opacity_ = 1, to_opacity_ = 1;
  base::TimeTicks started_;
  base::TimeDelta duration_;
  base::OnceClosure animated_;
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_DRAG_PREVIEW_H_
