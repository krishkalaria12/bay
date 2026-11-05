// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_CLEAR_SPECKS_H_
#define CHROME_BROWSER_BAY_WEBUI_CLEAR_SPECKS_H_

#include <vector>

#include "base/functional/callback.h"
#include "base/values.h"
#include "ui/gfx/geometry/rect_f.h"

class SkBitmap;
namespace content {
class WebContents;
}

namespace bay {
// The sidebar's Clear (Disintegrate.swift): each cleared row's own pixels, the
// ones that aren't its background, a point apart and at most a share of the
// budget each. One list per row of [x, y, r, g, b, a] runs, x and y in the
// document's points and the colour unpremultiplied, 0 to 255.
//
// `bitmap` holds `area` (document points) at `scale` pixels a point.
base::ListValue RowSpecks(const SkBitmap& bitmap,
                          const gfx::RectF& area,
                          float scale,
                          const std::vector<gfx::RectF>& rows);

// Copies the rows from the document's own surface and answers with their
// specks, or an empty list when the document can't be copied.
void CaptureRowSpecks(content::WebContents* document,
                      std::vector<gfx::RectF> rows,
                      base::OnceCallback<void(base::Value)> done);
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_CLEAR_SPECKS_H_
