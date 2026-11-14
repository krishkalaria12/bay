// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_PAGE_MEDIA_EVENTS_H_
#define CHROME_BROWSER_BAY_WEBUI_PAGE_MEDIA_EVENTS_H_

#include <optional>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "base/values.h"
#include "chrome/browser/media/webrtc/media_stream_capture_indicator.h"
#include "content/public/browser/web_contents_observer.h"

namespace bay {

// Browser-owned capture and PiP state for one page. The page channel owns
// now-playing metadata because its live seekable ranges have no native media
// session equivalent. This observer never accepts capture state from a page.
class PageMediaEvents final : public content::WebContentsObserver,
                              public MediaStreamCaptureIndicator::Observer {
 public:
  using EventSink =
      base::RepeatingCallback<void(const char*, base::DictValue)>;
  PageMediaEvents(content::WebContents* contents, EventSink events);
  ~PageMediaEvents() override;
  PageMediaEvents(const PageMediaEvents&) = delete;
  PageMediaEvents& operator=(const PageMediaEvents&) = delete;

  // A new mount lease/coordinator may subscribe after capture or PiP starts.
  void Replay();

 private:
  void OnIsCapturingVideoChanged(content::WebContents*, bool) override;
  void OnIsCapturingAudioChanged(content::WebContents*, bool) override;
  void OnIsCapturingTabChanged(content::WebContents*, bool) override;
  void OnIsCapturingWindowChanged(content::WebContents*, bool) override;
  void OnIsCapturingDisplayChanged(content::WebContents*, bool) override;
  void MediaPictureInPictureChanged(bool) override;
  void WebContentsDestroyed() override;

  void CaptureChanged(content::WebContents* source);
  void Capture(bool force);
  void PictureInPicture(bool force);

  const EventSink events_;
  const scoped_refptr<MediaStreamCaptureIndicator> indicator_;
  base::ScopedObservation<MediaStreamCaptureIndicator,
                          MediaStreamCaptureIndicator::Observer>
      capture_observation_{this};
  std::optional<base::DictValue> last_capture_;
  std::optional<std::string> pip_kind_;
  bool pip_sent_ = false;
  bool capture_pending_ = false;
  base::WeakPtrFactory<PageMediaEvents> weak_factory_{this};
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_PAGE_MEDIA_EVENTS_H_
