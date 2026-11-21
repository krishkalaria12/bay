// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/page_swipe_events.h"

#include <cmath>
#include <utility>

#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/page.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "third_party/blink/public/common/input/web_gesture_event.h"
#include "third_party/blink/public/common/input/web_input_event.h"

namespace bay {

void SwipeTracker::Begin() {
  state_ = State::kPending;
  dx_ = dy_ = 0;
}

std::optional<SwipeTracker::Event> SwipeTracker::Update(float dx,
                                                        float dy,
                                                        bool consumed,
                                                        bool momentum,
                                                        bool can_go_back,
                                                        bool can_go_forward) {
  if (momentum) {
    // The fingers lifted: a swipe ends there, and its fling is the page's.
    if (state_ == State::kTracking) {
      state_ = State::kIgnored;
      return Emit("ended");
    }
    return std::nullopt;
  }
  if (state_ == State::kIgnored || state_ == State::kIdle)
    return std::nullopt;
  dx_ += dx;
  dy_ += dy;
  if (state_ == State::kTracking)
    return Emit("changed");
  // What the page scrolled is the page's, until the fingers lift.
  if (consumed) {
    state_ = State::kIgnored;
    return std::nullopt;
  }
  const float x = std::fabs(dx_), y = std::fabs(dy_);
  if (y >= kVerticalIntent && kCancelDominance * x < y) {
    state_ = State::kIgnored;
    return std::nullopt;
  }
  if (x < kStartDistance || kStartDominance * x < y)
    return std::nullopt;
  // Fingers moving right scroll toward the start: back, as in Chrome.
  back_ = dx_ > 0;
  if (!(back_ ? can_go_back : can_go_forward)) {
    state_ = State::kIgnored;
    return std::nullopt;
  }
  state_ = State::kTracking;
  return Emit("began");
}

std::optional<SwipeTracker::Event> SwipeTracker::End() {
  const bool tracking = state_ == State::kTracking;
  state_ = State::kIdle;
  if (tracking)
    return Emit("ended");
  return std::nullopt;
}

SwipeTracker::Event SwipeTracker::Emit(const char* phase) const {
  return {phase, back_, back_ ? dx_ : -dx_, dy_};
}

namespace {
bool IsTouchpadScroll(const blink::WebGestureEvent& gesture) {
  if (gesture.SourceDevice() != blink::WebGestureDevice::kTouchpad)
    return false;
  // A mouse wheel's lines or pixels never swipe; only a touchpad's precise
  // deltas do (Chrome's OverscrollController::ShouldProcessEvent).
  switch (gesture.GetType()) {
    case blink::WebInputEvent::Type::kGestureScrollBegin:
      return gesture.data.scroll_begin.delta_hint_units ==
             ui::ScrollGranularity::kScrollByPrecisePixel;
    case blink::WebInputEvent::Type::kGestureScrollUpdate:
      return gesture.data.scroll_update.delta_units ==
             ui::ScrollGranularity::kScrollByPrecisePixel;
    case blink::WebInputEvent::Type::kGestureScrollEnd:
      return true;
    default:
      return false;
  }
}
}  // namespace

PageSwipeEvents::PageSwipeEvents(content::WebContents* contents,
                                 EventSink sink)
    : WebContentsObserver(contents), sink_(std::move(sink)) {
  Watch(contents->GetPrimaryMainFrame()->GetRenderWidgetHost());
}

PageSwipeEvents::~PageSwipeEvents() {
  Watch(nullptr);
}

void PageSwipeEvents::Watch(content::RenderWidgetHost* widget) {
  if (widget == widget_)
    return;
  if (widget_) {
    widget_->RemoveInputEventObserver(this);
    widget_->RemoveObserver(this);
  }
  tracker_.End();
  widget_ = widget;
  if (widget_) {
    widget_->AddInputEventObserver(this);
    widget_->AddObserver(this);
  }
}

void PageSwipeEvents::Send(const SwipeTracker::Event& event) {
  sink_.Run("onSwipe", base::DictValue()
                           .Set("phase", event.phase)
                           .Set("direction", event.back ? "back" : "forward")
                           .Set("distance", event.distance)
                           .Set("dy", event.dy)
                           .Set("velocity", 0)
                           .Set("available", true)
                           .Set("width", 0));
}

void PageSwipeEvents::PrimaryPageChanged(content::Page& page) {
  Watch(page.GetMainDocument().GetRenderWidgetHost());
}

void PageSwipeEvents::RenderFrameHostChanged(content::RenderFrameHost*,
                                             content::RenderFrameHost* now) {
  if (now && now == web_contents()->GetPrimaryMainFrame())
    Watch(now->GetRenderWidgetHost());
}

void PageSwipeEvents::WebContentsDestroyed() {
  Watch(nullptr);
}

void PageSwipeEvents::RenderWidgetHostDestroyed(
    content::RenderWidgetHost* widget) {
  if (widget == widget_)
    Watch(nullptr);
}

void PageSwipeEvents::OnInputEventAck(
    const content::RenderWidgetHost&,
    blink::mojom::InputEventResultSource,
    blink::mojom::InputEventResultState state,
    const blink::WebInputEvent& event) {
  if (!blink::WebInputEvent::IsGestureEventType(event.GetType()) ||
      !web_contents())
    return;
  const auto& gesture = static_cast<const blink::WebGestureEvent&>(event);
  if (!IsTouchpadScroll(gesture))
    return;
  std::optional<SwipeTracker::Event> out;
  switch (gesture.GetType()) {
    case blink::WebInputEvent::Type::kGestureScrollBegin:
      // A fling's own begin continues the swipe the fingers made.
      if (gesture.data.scroll_begin.inertial_phase !=
          blink::WebGestureEvent::InertialPhaseState::kMomentum)
        tracker_.Begin();
      break;
    case blink::WebInputEvent::Type::kGestureScrollUpdate: {
      auto& controller = web_contents()->GetController();
      out = tracker_.Update(
          gesture.data.scroll_update.delta_x,
          gesture.data.scroll_update.delta_y,
          state == blink::mojom::InputEventResultState::kConsumed,
          gesture.data.scroll_update.inertial_phase ==
              blink::WebGestureEvent::InertialPhaseState::kMomentum,
          controller.CanGoBack(), controller.CanGoForward());
      break;
    }
    case blink::WebInputEvent::Type::kGestureScrollEnd:
      out = tracker_.End();
      break;
    default:
      break;
  }
  if (out)
    Send(*out);
}

}  // namespace bay
