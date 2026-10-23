// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/window_placement.h"

#include <cmath>
#include <limits>

#include "build/build_config.h"
#if BUILDFLAG(IS_LINUX)
#include "ui/ozone/public/ozone_platform.h"
#endif

namespace bay {
bool GlobalWindowCoordinates() {
#if BUILDFLAG(IS_LINUX)
  return ui::OzonePlatform::IsInitialized() &&
         ui::OzonePlatform::GetInstance()
             ->GetPlatformProperties()
             .supports_global_screen_coordinates;
#else
  return true;
#endif
}

std::optional<gfx::Rect> ReadWindowFrame(const base::Value* value) {
  if (!value || !value->is_list() || value->GetList().size() != 4)
    return std::nullopt;
  int numbers[4];
  for (size_t i = 0; i < 4; ++i) {
    const auto number = value->GetList()[i].GetIfDouble();
    if (!number || !std::isfinite(*number) ||
        *number < std::numeric_limits<int>::min() ||
        *number > std::numeric_limits<int>::max()) {
      return std::nullopt;
    }
    numbers[i] = static_cast<int>(std::round(*number));
  }
  if (numbers[2] <= 0 || numbers[3] <= 0)
    return std::nullopt;
  return gfx::Rect(numbers[0], numbers[1], numbers[2], numbers[3]);
}

std::string ParseWindowPlacement(const base::DictValue& options,
                                 bool global_coordinates,
                                 WindowPlacement& placement) {
  placement = {};
  if (const auto* maximized = options.Find("maximized")) {
    if (!maximized->is_bool())
      return "Window maximized must be a boolean";
    placement.maximized = maximized->GetBool();
  }
  if (const auto* value = options.Find("size")) {
    const auto* size = value->GetIfList();
    if (!size || size->size() != 2)
      return "Invalid window size";
    const auto width = (*size)[0].GetIfDouble();
    const auto height = (*size)[1].GetIfDouble();
    if (!width || !height || !std::isfinite(*width) ||
        !std::isfinite(*height) || *width < 1 || *height < 1 ||
        *width > 32768 || *height > 32768) {
      return "Invalid window size";
    }
    placement.size.emplace(static_cast<int>(std::round(*width)),
                           static_cast<int>(std::round(*height)));
  }
  if (const auto* frame = options.Find("frame"); frame && !frame->is_none()) {
    placement.frame = ReadWindowFrame(frame);
    if (!placement.frame)
      return "Invalid window frame";
    if (!global_coordinates) {
      // Prefer an explicit restored size over a legacy saved frame.
      if (!placement.size)
        placement.size = placement.frame->size();
      placement.frame.reset();
    }
  }
  return {};
}

void RestoredWindowSize::Seed(const gfx::Size& size) {
  if (!size.IsEmpty())
    size_ = size;
}
void RestoredWindowSize::BoundsChanged(const gfx::Size& size, bool normal) {
  if (normal)
    Seed(size);
}
}  // namespace bay
