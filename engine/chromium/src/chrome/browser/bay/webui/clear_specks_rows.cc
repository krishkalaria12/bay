// Copyright 2026 Bay. Apache-2.0.
// RowSpecks alone: no browser code, so its test links on every desktop.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <utility>

#include "base/rand_util.h"
#include "chrome/browser/bay/webui/clear_specks.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/rect_conversions.h"

namespace bay {
namespace {
// Specks a row may become, and in all (a screenful of rows).
constexpr int kPerRow = 700;
constexpr int kTotal = 4000;

struct Pixel {
  int x;
  int y;
  SkColor color;
};
// How far apart two colours are, 0 to 4: each channel's difference, summed.
float Distance(SkColor a, SkColor b) {
  const auto channel = [](unsigned x, unsigned y) {
    return std::abs(static_cast<int>(x) - static_cast<int>(y));
  };
  return (channel(SkColorGetR(a), SkColorGetR(b)) +
          channel(SkColorGetG(a), SkColorGetG(b)) +
          channel(SkColorGetB(a), SkColorGetB(b)) +
          channel(SkColorGetA(a), SkColorGetA(b))) /
         255.f;
}
}  // namespace

base::ListValue RowSpecks(const SkBitmap& bitmap,
                          const gfx::RectF& area,
                          float scale,
                          const std::vector<gfx::RectF>& rows) {
  base::ListValue result;
  if (rows.empty() || !(scale > 0))
    return result;
  const int budget = std::max(
      80, std::min(kPerRow, kTotal / static_cast<int>(rows.size())));
  const int step = std::max(1, static_cast<int>(std::lround(scale)));
  for (const auto& row : rows) {
    base::ListValue specks;
    // The row in the bitmap's pixels, clipped to what was copied.
    gfx::Rect pixels = gfx::ToEnclosedRect(gfx::ScaleRect(
        gfx::RectF(row.x() - area.x(), row.y() - area.y(), row.width(),
                   row.height()),
        scale));
    pixels.Intersect(gfx::Rect(bitmap.width(), bitmap.height()));
    if (pixels.width() <= 2 || pixels.height() <= 2) {
      result.Append(std::move(specks));
      continue;
    }
    // The background: what the row's ends show (its ink is in between).
    const std::array<SkColor, 3> background = {
        bitmap.getColor(pixels.x() + 1, pixels.y() + pixels.height() / 2),
        bitmap.getColor(pixels.right() - 2, pixels.y() + pixels.height() / 2),
        bitmap.getColor(pixels.x() + pixels.width() / 2, pixels.y() + 1)};
    std::vector<Pixel> found;
    for (int y = pixels.y(); y < pixels.bottom(); y += step) {
      for (int x = pixels.x(); x < pixels.right(); x += step) {
        const SkColor color = bitmap.getColor(x, y);
        if (SkColorGetA(color) <= 0.15f * 255)
          continue;
        if (std::ranges::all_of(background, [&](SkColor seen) {
              return Distance(color, seen) > 0.28f;
            })) {
          found.push_back({x, y, color});
        }
      }
    }
    if (found.size() > static_cast<size_t>(budget)) {
      base::RandomShuffle(found.begin(), found.end());
      found.resize(budget);
    }
    for (const auto& pixel : found) {
      specks.Append(area.x() + pixel.x / scale);
      specks.Append(area.y() + pixel.y / scale);
      specks.Append(static_cast<int>(SkColorGetR(pixel.color)));
      specks.Append(static_cast<int>(SkColorGetG(pixel.color)));
      specks.Append(static_cast<int>(SkColorGetB(pixel.color)));
      specks.Append(static_cast<int>(SkColorGetA(pixel.color)));
    }
    result.Append(std::move(specks));
  }
  return result;
}
}  // namespace bay
