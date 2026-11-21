// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/clear_specks.h"

#include <utility>

#include "base/functional/bind.h"
#include "base/task/bind_post_task.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "components/viz/common/frame_sinks/copy_output_result.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/gfx/geometry/rect_conversions.h"

namespace bay {
void CaptureRowSpecks(content::WebContents* document,
                      std::vector<gfx::RectF> rows,
                      base::OnceCallback<void(base::Value)> done) {
  auto* view = document ? document->GetRenderWidgetHostView() : nullptr;
  gfx::RectF area;
  for (const auto& row : rows)
    area.Union(row);
  area.Intersect(gfx::RectF(view ? view->GetViewBounds().size() : gfx::Size()));
  if (!view || area.IsEmpty()) {
    std::move(done).Run(base::Value(base::ListValue()));
    return;
  }
  const gfx::Rect copied = gfx::ToEnclosingRect(area);
  view->CopyFromSurface(
      copied, gfx::Size(), base::Seconds(1),
      base::BindPostTaskToCurrentDefault(base::BindOnce(
          [](gfx::RectF area, std::vector<gfx::RectF> rows,
             base::OnceCallback<void(base::Value)> done,
             const content::CopyFromSurfaceResult& result) {
            if (!result.has_value() || result->bitmap.drawsNothing()) {
              std::move(done).Run(base::Value(base::ListValue()));
              return;
            }
            const float scale = result->bitmap.width() / area.width();
            base::ThreadPool::PostTaskAndReplyWithResult(
                FROM_HERE, {base::TaskPriority::USER_BLOCKING},
                base::BindOnce(
                    [](SkBitmap bitmap, gfx::RectF area, float scale,
                       std::vector<gfx::RectF> rows) {
                      return base::Value(
                          RowSpecks(bitmap, area, scale, rows));
                    },
                    result->bitmap, area, scale, std::move(rows)),
                std::move(done));
          },
          gfx::RectF(copied), std::move(rows), std::move(done))));
}
}  // namespace bay
