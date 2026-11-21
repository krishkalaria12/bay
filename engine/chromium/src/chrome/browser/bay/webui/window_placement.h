// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_WINDOW_PLACEMENT_H_
#define CHROME_BROWSER_BAY_WEBUI_WINDOW_PLACEMENT_H_

#include <optional>
#include <string>

#include "base/values.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"

namespace bay {
// The native backend decides this, independently of renderer options.
bool GlobalWindowCoordinates();

struct WindowPlacement {
  std::optional<gfx::Rect> frame;
  std::optional<gfx::Size> size;
  std::optional<bool> maximized;
};

std::optional<gfx::Rect> ReadWindowFrame(const base::Value* value);
// Validates all placement fields, even those shadowed by a frame. Without
// global coordinates a legacy frame contributes only its dimensions.
std::string ParseWindowPlacement(const base::DictValue& options,
                                 bool global_coordinates,
                                 WindowPlacement& placement);

// Show-state notifications precede bounds notifications on Wayland. Keep the
// last normal dimensions through that transition, fullscreen and minimization.
class RestoredWindowSize {
 public:
  void Seed(const gfx::Size& size);
  void BoundsChanged(const gfx::Size& size, bool normal);
  const std::optional<gfx::Size>& size() const { return size_; }

 private:
  std::optional<gfx::Size> size_;
};
}  // namespace bay
#endif
