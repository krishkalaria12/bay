// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/page_media_events.h"

#include <memory>
#include <utility>
#include <vector>

#include "base/run_loop.h"
#include "base/test/bind.h"
#include "chrome/browser/media/webrtc/media_capture_devices_dispatcher.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "content/public/browser/web_contents.h"
#include "content/public/test/web_contents_tester.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/blink/public/common/mediastream/media_stream_request.h"
#include "third_party/blink/public/mojom/mediastream/media_stream.mojom.h"

namespace bay {
namespace {
using Stream = std::unique_ptr<content::MediaStreamUI>;
class PageMediaEventsTest : public ChromeRenderViewHostTestHarness {
 protected:
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    NavigateAndCommit(GURL("https://media.test/"));
    observer_ = std::make_unique<PageMediaEvents>(
        web_contents(), base::BindLambdaForTesting(
            [this](const char* event, base::DictValue payload) {
              events_.emplace_back(event, std::move(payload));
              if (destroy_on_event_)
                observer_.reset();
            }));
  }
  void TearDown() override {
    observer_.reset();
    ChromeRenderViewHostTestHarness::TearDown();
  }
  Stream Start(blink::mojom::MediaStreamType type,
               std::optional<media::mojom::DisplayCaptureSurfaceType> surface =
                   std::nullopt,
               content::WebContents* contents = nullptr) {
    blink::mojom::StreamDevices devices;
    blink::MediaStreamDevice device(type, "device", "device");
    if (surface) {
      device.display_media_info = media::mojom::DisplayMediaInformation::New(
          *surface, true, media::mojom::CursorCaptureType::NEVER, nullptr, 100);
    }
    if (blink::IsAudioInputMediaType(type))
      devices.audio_device = device;
    else
      devices.video_device = device;
    auto stream = MediaCaptureDevicesDispatcher::GetInstance()
                      ->GetMediaStreamCaptureIndicator()
                      ->RegisterMediaStream(contents ? contents : web_contents(),
                                             devices);
    stream->OnStarted(base::RepeatingClosure(),
                       content::MediaStreamUI::SourceCallback(), "", {},
                       content::MediaStreamUI::StateChangeCallback());
    return stream;
  }
  void Drain() { base::RunLoop().RunUntilIdle(); }
  size_t Count(const char* event) const {
    size_t count = 0;
    for (const auto& entry : events_)
      if (entry.first == event)
        ++count;
    return count;
  }
  const base::DictValue& Last(const char* event) const {
    for (auto entry = events_.rbegin(); entry != events_.rend(); ++entry)
      if (entry->first == event)
        return entry->second;
    ADD_FAILURE() << "Missing " << event;
    return empty_;
  }
  std::unique_ptr<PageMediaEvents> observer_;
  std::vector<std::pair<std::string, base::DictValue>> events_;
  bool destroy_on_event_ = false;
  const base::DictValue empty_;
};

TEST_F(PageMediaEventsTest, ReplaysActualStateToANewLease) {
  auto camera = Start(blink::mojom::MediaStreamType::DEVICE_VIDEO_CAPTURE);
  Drain();
  events_.clear();
  observer_->Replay();
  EXPECT_EQ(Last("onMediaAccess").FindBool("camera"), true);
  EXPECT_EQ(Last("onMediaAccess").FindBool("microphone"), false);
  EXPECT_EQ(Last("onMediaAccess").FindBool("screen"), false);
  EXPECT_EQ(Last("onPictureInPicture").FindBool("active"), false);
  EXPECT_EQ(Count("onMediaAccess"), 1u);
}

TEST_F(PageMediaEventsTest, CameraAndMicrophoneFollowRealStreamsAndCoalesce) {
  observer_->Replay();
  events_.clear();
  auto camera = Start(blink::mojom::MediaStreamType::DEVICE_VIDEO_CAPTURE);
  auto microphone = Start(blink::mojom::MediaStreamType::DEVICE_AUDIO_CAPTURE);
  Drain();
  EXPECT_EQ(Count("onMediaAccess"), 1u);
  EXPECT_EQ(Last("onMediaAccess").FindBool("camera"), true);
  EXPECT_EQ(Last("onMediaAccess").FindBool("microphone"), true);
  camera.reset();
  Drain();
  EXPECT_EQ(Last("onMediaAccess").FindBool("camera"), false);
  EXPECT_EQ(Last("onMediaAccess").FindBool("microphone"), true);
  microphone.reset();
  Drain();
  EXPECT_EQ(Last("onMediaAccess").FindBool("microphone"), false);
}

TEST_F(PageMediaEventsTest, ScreenStateStaysActiveUntilAllCaptureKindsStop) {
  auto window = Start(blink::mojom::MediaStreamType::GUM_DESKTOP_VIDEO_CAPTURE,
                       media::mojom::DisplayCaptureSurfaceType::WINDOW);
  auto display = Start(blink::mojom::MediaStreamType::GUM_DESKTOP_VIDEO_CAPTURE,
                        media::mojom::DisplayCaptureSurfaceType::MONITOR);
  Drain();
  EXPECT_EQ(Last("onMediaAccess").FindBool("screen"), true);
  EXPECT_EQ(Last("onMediaAccess").FindBool("camera"), false);
  const auto count = Count("onMediaAccess");
  window.reset();
  Drain();
  EXPECT_EQ(Count("onMediaAccess"), count);
  display.reset();
  Drain();
  EXPECT_EQ(Last("onMediaAccess").FindBool("screen"), false);
}

TEST_F(PageMediaEventsTest, AnotherTabsCaptureCannotChangeThisPage) {
  auto other = content::WebContentsTester::CreateTestWebContents(profile(), nullptr);
  auto camera = Start(blink::mojom::MediaStreamType::DEVICE_VIDEO_CAPTURE,
                       std::nullopt, other.get());
  Drain();
  EXPECT_TRUE(events_.empty());
}

TEST_F(PageMediaEventsTest, DocumentPictureInPictureReplaysAndClosesCorrectKind) {
  content::WebContentsTester::For(web_contents())
      ->SetHasPictureInPictureDocument(true);
  EXPECT_EQ(Last("onPictureInPicture").FindBool("active"), true);
  EXPECT_EQ(*Last("onPictureInPicture").FindString("kind"), "document");
  events_.clear();
  observer_->Replay();
  EXPECT_EQ(Count("onPictureInPicture"), 1u);
  EXPECT_EQ(Last("onPictureInPicture").FindBool("active"), true);
  content::WebContentsTester::For(web_contents())
      ->SetHasPictureInPictureDocument(false);
  EXPECT_EQ(Last("onPictureInPicture").FindBool("active"), false);
  EXPECT_EQ(*Last("onPictureInPicture").FindString("kind"), "document");
}

TEST_F(PageMediaEventsTest, DestructionClearsStateAndCancelsPendingCaptureRead) {
  auto camera = Start(blink::mojom::MediaStreamType::DEVICE_VIDEO_CAPTURE);
  DeleteContents();
  Drain();
  EXPECT_EQ(Last("onMediaAccess").FindBool("camera"), false);
  EXPECT_EQ(Last("onPictureInPicture").FindBool("active"), false);
  EXPECT_EQ(Count("onMediaAccess"), 1u);
}

TEST_F(PageMediaEventsTest, ReplayToleratesItsOwnerClosingOnTheFirstEvent) {
  destroy_on_event_ = true;
  observer_->Replay();
  EXPECT_FALSE(observer_);
  EXPECT_EQ(events_.size(), 1u);
}
}  // namespace
}  // namespace bay
