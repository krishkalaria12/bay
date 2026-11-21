// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_PAGE_SWIPE_EVENTS_H_
#define CHROME_BROWSER_BAY_WEBUI_PAGE_SWIPE_EVENTS_H_

#include <optional>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/values.h"
#include "content/public/browser/render_widget_host.h"
#include "content/public/browser/render_widget_host_observer.h"
#include "content/public/browser/web_contents_observer.h"

namespace content {
class Page;
class RenderFrameHost;
class WebContents;
}  // namespace content

namespace bay {

// A two-finger touchpad swipe the page leaves alone, as macOS's NNSwipe reads
// it: past a few points of mostly horizontal travel that the page didn't
// scroll, toward history the tab has. Chrome's own overscroll can't see a
// SurfaceEmbed page (its connector doesn't bubble unused scroll), so Bay
// reads the page's scroll acks and draws its own capsule (SwipeOverlay.tsx).
class SwipeTracker {
 public:
  struct Event {
    const char* phase;
    bool back;
    float distance;
    float dy;
  };
  static constexpr float kStartDistance = 8;
  static constexpr float kStartDominance = 1.5;
  static constexpr float kVerticalIntent = 4;
  static constexpr float kCancelDominance = 2;

  void Begin();
  // `consumed`: the page scrolled for this update. `momentum`: it is the
  // touchpad's fling after the fingers lifted.
  std::optional<Event> Update(float dx,
                              float dy,
                              bool consumed,
                              bool momentum,
                              bool can_go_back,
                              bool can_go_forward);
  std::optional<Event> End();

 private:
  enum class State { kIdle, kPending, kTracking, kIgnored };
  Event Emit(const char* phase) const;
  State state_ = State::kIdle;
  float dx_ = 0;
  float dy_ = 0;
  bool back_ = false;
};

class PageSwipeEvents final
    : public content::WebContentsObserver,
      public content::RenderWidgetHost::InputEventObserver,
      public content::RenderWidgetHostObserver {
 public:
  using EventSink =
      base::RepeatingCallback<void(const char*, base::DictValue)>;
  PageSwipeEvents(content::WebContents* contents, EventSink sink);
  ~PageSwipeEvents() override;

 private:
  void Watch(content::RenderWidgetHost* widget);
  void Send(const SwipeTracker::Event& event);
  void PrimaryPageChanged(content::Page& page) override;
  void RenderFrameHostChanged(content::RenderFrameHost* old_host,
                              content::RenderFrameHost* new_host) override;
  void WebContentsDestroyed() override;
  void RenderWidgetHostDestroyed(content::RenderWidgetHost* widget) override;
  void OnInputEventAck(const content::RenderWidgetHost& widget,
                       blink::mojom::InputEventResultSource source,
                       blink::mojom::InputEventResultState state,
                       const blink::WebInputEvent& event) override;
  EventSink sink_;
  SwipeTracker tracker_;
  raw_ptr<content::RenderWidgetHost> widget_ = nullptr;
};

}  // namespace bay
#endif
