// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/page_media_events.h"

#include <utility>

#include "base/functional/bind.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/media/webrtc/media_capture_devices_dispatcher.h"
#include "content/public/browser/web_contents.h"

namespace bay {

PageMediaEvents::PageMediaEvents(content::WebContents* contents,
                                 EventSink events)
    : WebContentsObserver(contents),
      events_(std::move(events)),
      indicator_(MediaCaptureDevicesDispatcher::GetInstance()
                     ->GetMediaStreamCaptureIndicator()) {
  capture_observation_.Observe(indicator_.get());
}
PageMediaEvents::~PageMediaEvents() = default;

void PageMediaEvents::Replay() {
  const auto weak = weak_factory_.GetWeakPtr();
  Capture(true);
  if (weak)
    PictureInPicture(true);
}

void PageMediaEvents::CaptureChanged(content::WebContents* source) {
  // A page can embed inner WebContents; Chrome's capture accessors aggregate
  // those descendants too. Another tab's camera must not change this tab.
  for (; source; source = source->GetOuterWebContents()) {
    if (source != web_contents())
      continue;
    if (!capture_pending_) {
      capture_pending_ = true;
      // UnregisterWebContents notifies before erasing its usage record. Query
      // after the mutation, and coalesce a camera+microphone pair into one event.
      base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE,
          base::BindOnce(&PageMediaEvents::Capture,
                         weak_factory_.GetWeakPtr(), false));
    }
    return;
  }
}

void PageMediaEvents::Capture(bool force) {
  capture_pending_ = false;
  if (!web_contents())
    return;
  auto state = base::DictValue()
                   .Set("camera", indicator_->IsCapturingVideo(web_contents()))
                   .Set("microphone", indicator_->IsCapturingAudio(web_contents()))
                   .Set("screen", indicator_->IsCapturingTab(web_contents()) ||
                                      indicator_->IsCapturingWindow(web_contents()) ||
                                      indicator_->IsCapturingDisplay(web_contents()));
  if (!force && last_capture_ && *last_capture_ == state)
    return;
  last_capture_ = state.Clone();
  events_.Run("onMediaAccess", std::move(state));
}

void PageMediaEvents::PictureInPicture(bool force) {
  if (!web_contents())
    return;
  std::optional<std::string> kind;
  if (web_contents()->HasPictureInPictureDocument())
    kind = "document";
  else if (web_contents()->HasPictureInPictureVideo())
    kind = "video";
  if (!force && pip_sent_ && kind == pip_kind_)
    return;
  // Emit a single state. Sending an inactive video state after an active
  // document state would incorrectly clear the shared UI's one PiP entry.
  auto state = base::DictValue()
                   .Set("kind", kind.value_or(pip_kind_.value_or("video")))
                   .Set("active", kind.has_value());
  pip_kind_ = std::move(kind);
  pip_sent_ = true;
  events_.Run("onPictureInPicture", std::move(state));
}

void PageMediaEvents::OnIsCapturingVideoChanged(content::WebContents* source,
                                                bool) {
  CaptureChanged(source);
}
void PageMediaEvents::OnIsCapturingAudioChanged(content::WebContents* source,
                                                bool) {
  CaptureChanged(source);
}
void PageMediaEvents::OnIsCapturingTabChanged(content::WebContents* source,
                                              bool) {
  CaptureChanged(source);
}
void PageMediaEvents::OnIsCapturingWindowChanged(content::WebContents* source,
                                                 bool) {
  CaptureChanged(source);
}
void PageMediaEvents::OnIsCapturingDisplayChanged(content::WebContents* source,
                                                  bool) {
  CaptureChanged(source);
}
void PageMediaEvents::MediaPictureInPictureChanged(bool) {
  PictureInPicture(false);
}

void PageMediaEvents::WebContentsDestroyed() {
  capture_observation_.Reset();
  weak_factory_.InvalidateWeakPtrs();
  const auto weak = weak_factory_.GetWeakPtr();
  const auto events = events_;
  const auto kind = pip_kind_.value_or("video");
  // Detach before callbacks: a callback may destroy the owner and this helper.
  Observe(nullptr);
  events.Run("onMediaAccess", base::DictValue()
                                 .Set("camera", false)
                                 .Set("microphone", false)
                                 .Set("screen", false));
  if (weak)
    events.Run("onPictureInPicture",
                base::DictValue().Set("kind", kind).Set("active", false));
}
}  // namespace bay
