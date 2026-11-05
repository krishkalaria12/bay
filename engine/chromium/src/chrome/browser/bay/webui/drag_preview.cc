// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/drag_preview.h"

#include <algorithm>
#include <utility>

#include "base/base64.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/task/sequenced_task_runner.h"
#include "base/timer/timer.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "cc/paint/paint_flags.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "third_party/skia/include/core/SkColor.h"
#include "third_party/skia/include/core/SkPath.h"
#include "ui/base/base_window.h"
#include "ui/gfx/canvas.h"
#include "ui/gfx/codec/jpeg_codec.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/font_list.h"
#include "ui/gfx/geometry/rect_conversions.h"
#include "ui/gfx/geometry/skia_conversions.h"
#include "ui/gfx/image/image.h"
#include "ui/snapshot/snapshot.h"
#include "ui/views/view.h"
#include "ui/views/widget/widget.h"

namespace bay {
namespace {
// Dia's card, and the timings macOS uses.
constexpr gfx::Size kCard(209, 110);
constexpr base::TimeDelta kMorph = base::Milliseconds(60);
constexpr base::TimeDelta kGrow = base::Milliseconds(200);
constexpr base::TimeDelta kFadeOut = base::Milliseconds(100);
// The longest a new window's content is waited for, as macOS's revealTimeout.
constexpr base::TimeDelta kRevealTimeout = base::Milliseconds(600);
constexpr std::string_view kPngDataUri = "data:image/png;base64,";

views::Widget* WidgetOf(BrowserWindowInterface* frame) {
  return frame && frame->GetWindow()
             ? views::Widget::GetWidgetForNativeWindow(
                   frame->GetWindow()->GetNativeWindow())
             : nullptr;
}
}  // namespace

// Runs `done` once when `document` has painted, or after the time-out.
class RevealWatch : public content::WebContentsObserver {
 public:
  RevealWatch(content::WebContents* document, base::OnceClosure done)
      : content::WebContentsObserver(document), done_(std::move(done)) {
    timeout_.Start(
        FROM_HERE, kRevealTimeout,
        base::BindOnce(&RevealWatch::Finish, base::Unretained(this)));
  }

 private:
  void Finish() {
    if (done_)
      std::move(done_).Run();
  }
  void DidFirstVisuallyNonEmptyPaint() override { Finish(); }
  void WebContentsDestroyed() override { Finish(); }

  base::OnceClosure done_;
  base::OneShotTimer timeout_;
};

// The picture with the card's rim: rounded, with a light border.
class DragPreviewView : public views::View {
 public:
  void Show(gfx::ImageSkia image,
            bool pill,
            std::u16string placeholder,
            gfx::ImageSkia icon) {
    image_ = std::move(image);
    pill_ = pill;
    placeholder_ = std::move(placeholder);
    icon_ = std::move(icon);
    SchedulePaint();
  }

  void OnPaint(gfx::Canvas* canvas) override {
    const gfx::RectF bounds(GetLocalBounds());
    const float radius = pill_ ? 10 : 4;
    canvas->ClipPath(SkPath::RRect(gfx::RectFToSkRect(bounds), radius, radius),
                     true);
    canvas->DrawColor(SkColorSetRGB(0x20, 0x20, 0x22));
    if (!image_.isNull()) {
      // Filling the card, cropped from the top; the pill as it is.
      const float scale =
          std::max(bounds.width() / image_.width(),
                   bounds.height() / image_.height());
      canvas->DrawImageInt(image_, 0, 0, image_.width(), image_.height(), 0, 0,
                           std::round(image_.width() * scale),
                           std::round(image_.height() * scale), true);
    } else if (!placeholder_.empty()) {
      constexpr int kIcon = 32;
      const int top = icon_.isNull() ? 12 : 16 + kIcon;
      if (!icon_.isNull()) {
        canvas->DrawImageInt(icon_, 0, 0, icon_.width(), icon_.height(),
                             (bounds.width() - kIcon) / 2, 10, kIcon, kIcon,
                             true);
      }
      canvas->DrawStringRectWithFlags(
          placeholder_, gfx::FontList(), SK_ColorWHITE,
          gfx::ToEnclosedRect(gfx::RectF(12, top, bounds.width() - 24,
                                         bounds.height() - top - 8)),
          gfx::Canvas::TEXT_ALIGN_CENTER | gfx::Canvas::MULTI_LINE);
    }
    cc::PaintFlags border;
    border.setStyle(cc::PaintFlags::kStroke_Style);
    border.setStrokeWidth(1);
    border.setAntiAlias(true);
    border.setColor(SkColorSetA(SK_ColorWHITE, pill_ ? 0x26 : 0x4d));
    gfx::RectF rim = bounds;
    rim.Inset(0.5);
    canvas->DrawRoundRect(rim, radius, border);
  }

 private:
  gfx::ImageSkia image_;
  bool pill_ = false;
  std::u16string placeholder_;
  gfx::ImageSkia icon_;
};

// static
DragPreview& DragPreview::Get() {
  static base::NoDestructor<DragPreview> preview;
  return *preview;
}
DragPreview::DragPreview() = default;
DragPreview::~DragPreview() = default;

gfx::Rect DragPreview::bounds_for_testing() const {
  return widget_ ? widget_->GetWindowBoundsInScreen() : gfx::Rect();
}

void DragPreview::Begin(BrowserWindowInterface* source,
                        const gfx::Rect& chip,
                        const gfx::Point& grab) {
  Cancel();
  auto* widget = WidgetOf(source);
  if (!widget)
    return;
  source_ = source->GetWeakPtr();
  origin_ = widget->GetClientAreaBoundsInScreen().origin();
  pill_size_ = chip.size();
  grab_ = gfx::Point(grab.x() - chip.x(), grab.y() - chip.y());
  const uint64_t generation = generation_;
  // The whole window for the card, until the page's own picture arrives, and
  // the item itself for the pill.
  ui::GrabWindowSnapshot(
      widget->GetNativeWindow(),
      gfx::Rect(widget->GetClientAreaBoundsInScreen().size()),
      base::BindOnce(&DragPreview::Snapshotted, base::Unretained(this),
                     generation, false));
  ui::GrabWindowSnapshot(
      widget->GetNativeWindow(), chip,
      base::BindOnce(&DragPreview::Snapshotted, base::Unretained(this),
                     generation, true));
}
void DragPreview::Snapshotted(uint64_t generation, bool pill,
                              gfx::Image image) {
  if (generation != generation_ || image.IsEmpty())
    return;
  (pill ? pill_image_ : window_image_) = image.AsImageSkia();
  Compose();
  if (shape_ != "hidden")
    Place(false);
}
void DragPreview::Compose() {
  if (page_image_.isNull() || window_image_.isNull()) {
    card_image_ = page_image_.isNull() ? window_image_ : page_image_;
    return;
  }
  gfx::Canvas canvas(window_image_.size(), 1.0f, /*is_opaque=*/true);
  canvas.DrawImageInt(window_image_, 0, 0);
  canvas.DrawImageInt(page_image_, 0, 0, page_image_.width(),
                      page_image_.height(), page_frame_.x(), page_frame_.y(),
                      page_frame_.width(), page_frame_.height(), true);
  card_image_ = gfx::ImageSkia::CreateFrom1xBitmap(canvas.GetBitmap());
}
void DragPreview::SetPage(const std::string& jpeg, const gfx::Rect& frame) {
  if (!source_)
    return;
  const SkBitmap bitmap = gfx::JPEGCodec::Decode(base::as_byte_span(jpeg));
  if (bitmap.drawsNothing())
    return;
  page_image_ = gfx::ImageSkia::CreateFrom1xBitmap(bitmap);
  page_frame_ = frame;
  placeholder_.clear();
  Compose();
  if (shape_ == "card")
    Place(false);
}
void DragPreview::SetPlaceholder(const std::u16string& title,
                                 const std::string& favicon) {
  if (!source_ || !page_image_.isNull())
    return;
  placeholder_ = title;
  placeholder_icon_ = gfx::ImageSkia();
  std::string png;
  if (favicon.starts_with(kPngDataUri) &&
      base::Base64Decode(favicon.substr(kPngDataUri.size()), &png)) {
    const SkBitmap icon = gfx::PNGCodec::Decode(base::as_byte_span(png));
    if (!icon.drawsNothing())
      placeholder_icon_ = gfx::ImageSkia::CreateFrom1xBitmap(icon);
  }
  // The window's own picture is hiding what the tab has: show this instead.
  window_image_ = gfx::ImageSkia();
  Compose();
  if (shape_ == "card")
    Place(false);
}
void DragPreview::Update(const std::string& shape, const gfx::Point& pointer) {
  if (!source_)
    return;
  pointer_ = origin_ + pointer.OffsetFromOrigin();
  if (shape == "hidden") {
    shape_ = shape;
    animation_.Stop();
    if (widget_)
      widget_->Hide();
    return;
  }
  const bool morph = shape_ != "hidden" && shape_ != shape;
  shape_ = shape;
  if (!widget_) {
    widget_ = std::make_unique<views::Widget>();
    views::Widget::InitParams params(
        views::Widget::InitParams::CLIENT_OWNS_WIDGET,
        views::Widget::InitParams::TYPE_DRAG);
    params.opacity = views::Widget::InitParams::WindowOpacity::kTranslucent;
    params.accept_events = false;
    params.activatable = views::Widget::InitParams::Activatable::kNo;
    params.shadow_type = views::Widget::InitParams::ShadowType::kNone;
    params.z_order = ui::ZOrderLevel::kFloatingUIElement;
    widget_->Init(std::move(params));
    view_ = widget_->SetContentsView(std::make_unique<DragPreviewView>());
  }
  Place(morph);
  widget_->ShowInactive();
}
void DragPreview::Place(bool animated) {
  if (!widget_ || !view_)
    return;
  const bool pill = shape_ == "pill";
  const gfx::Size size = pill ? pill_size_ : kCard;
  // The pill keeps the pointer where it held the tab; the card is centred.
  const gfx::Vector2d offset =
      pill ? grab_.OffsetFromOrigin()
           : gfx::Vector2d(size.width() / 2, size.height() / 2);
  const gfx::Rect bounds(pointer_ - offset, size);
  view_->Show(pill ? pill_image_ : card_image_, pill,
              pill ? std::u16string() : placeholder_,
              pill ? gfx::ImageSkia() : placeholder_icon_);
  if (animated)
    Animate(bounds, 1, kMorph, base::DoNothing());
  else if (animation_.IsRunning())
    to_ = bounds;
  else
    widget_->SetBounds(bounds);
}
void DragPreview::End(BrowserWindowInterface* target,
                      std::optional<gfx::Rect> fallback) {
  const bool showing = widget_ && shape_ != "hidden";
  ++generation_;
  source_.reset();
  shape_ = "hidden";
  if (!showing) {
    Close();
    return;
  }
  auto fade =
      base::BindOnce(&DragPreview::Fade, base::Unretained(this), generation_);
  auto* widget = WidgetOf(target);
  std::optional<gfx::Rect> frame =
      widget ? std::make_optional(widget->GetWindowBoundsInScreen()) : fallback;
  if (!frame || frame->IsEmpty()) {
    std::move(fade).Run();
    return;
  }
  if (!card_image_.isNull())
    view_->Show(card_image_, false, std::u16string(), gfx::ImageSkia());
  // Fades once the new window shows its content, so nothing blinks between.
  auto* document = target ? WindowRegistry::Get().DocumentOf(target) : nullptr;
  auto reveal = base::BindOnce(
      [](DragPreview* preview, base::WeakPtr<content::WebContents> document,
         base::OnceClosure fade) {
        if (!document || document->CompletedFirstVisuallyNonEmptyPaint()) {
          std::move(fade).Run();
          return;
        }
        preview->reveal_ =
            std::make_unique<RevealWatch>(document.get(), std::move(fade));
      },
      base::Unretained(this),
      document ? document->GetWeakPtr()
               : base::WeakPtr<content::WebContents>(),
      std::move(fade));
  Animate(*frame, 1, kGrow, std::move(reveal));
}
void DragPreview::Fade(uint64_t generation) {
  if (generation != generation_ || !widget_)
    return;
  Animate(widget_->GetWindowBoundsInScreen(), 0, kFadeOut,
          base::BindOnce(&DragPreview::Close, base::Unretained(this)));
}
void DragPreview::Cancel() {
  ++generation_;
  source_.reset();
  shape_ = "hidden";
  Close();
}
void DragPreview::Close() {
  animation_.Stop();
  animated_.Reset();
  // Posted: the watch may be what's calling.
  if (reveal_) {
    base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(
        FROM_HERE, std::move(reveal_));
  }
  view_ = nullptr;
  widget_.reset();
  pill_image_ = window_image_ = page_image_ = card_image_ = gfx::ImageSkia();
  placeholder_icon_ = gfx::ImageSkia();
  placeholder_.clear();
}
void DragPreview::Animate(const gfx::Rect& to, float opacity,
                          base::TimeDelta duration, base::OnceClosure done) {
  if (!widget_)
    return;
  from_ = widget_->GetWindowBoundsInScreen();
  to_ = to;
  from_opacity_ = to_opacity_;
  to_opacity_ = opacity;
  started_ = base::TimeTicks::Now();
  duration_ = duration;
  animated_ = std::move(done);
  animation_.Start(FROM_HERE, base::Milliseconds(16),
                   base::BindRepeating(&DragPreview::Step,
                                       base::Unretained(this)));
  Step();
}
void DragPreview::Step() {
  if (!widget_)
    return;
  const base::TimeDelta length = std::max(duration_, base::Milliseconds(1));
  const double t = std::min(1.0, (base::TimeTicks::Now() - started_) / length);
  const double eased = t * t * (3 - 2 * t);
  const auto mix = [&](int a, int b) {
    return static_cast<int>(std::round(a + (b - a) * eased));
  };
  widget_->SetBounds(gfx::Rect(mix(from_.x(), to_.x()), mix(from_.y(), to_.y()),
                               mix(from_.width(), to_.width()),
                               mix(from_.height(), to_.height())));
  widget_->SetOpacity(from_opacity_ + (to_opacity_ - from_opacity_) * eased);
  if (t < 1)
    return;
  animation_.Stop();
  if (animated_)
    std::move(animated_).Run();
}
}  // namespace bay
