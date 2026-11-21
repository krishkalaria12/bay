// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/display_media_picker.h"

#include <memory>
#include <utility>

#include "base/test/bind.h"
#include "base/test/test_future.h"
#include "chrome/browser/bay/webui/tab_broker.h"
#include "chrome/browser/media/webrtc/desktop_media_picker.h"
#include "chrome/browser/media/webrtc/desktop_media_picker_factory_impl.h"
#include "chrome/browser/media/webrtc/fake_desktop_media_list.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/web_contents.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "url/origin.h"

namespace bay {
class DisplayMediaPickerTest : public ChromeRenderViewHostTestHarness {
 protected:
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    NavigateAndCommit(GURL("https://asking.test/"));
    auto offer = TabBroker::Get().Offer(web_contents(), false);
    offer_ = offer.adopt_id;
    DisplayMediaPicker::Start(base::BindLambdaForTesting(
        [this](content::WebContents* contents, base::DictValue request) {
          EXPECT_EQ(contents, web_contents());
          request_ = std::move(request);
          return true;
        }));
    DisplayMediaPicker::SetEnabled(true);
  }
  void TearDown() override {
    picker_.reset();
    DisplayMediaPicker::SetEnabled(false);
    DisplayMediaPicker::Start(DisplayMediaPicker::Sink());
    TabBroker::Get().ReleaseOffer(offer_);
    ChromeRenderViewHostTestHarness::TearDown();
  }
  FakeDesktopMediaList* Show() {
    auto* frame = web_contents()->GetPrimaryMainFrame();
    content::MediaStreamRequest request(
        frame->GetProcess()->GetDeprecatedID(), frame->GetRoutingID(), 1,
        url::Origin::Create(GURL("https://asking.test/")), true,
        blink::MEDIA_GENERATE_STREAM, {}, {},
        blink::mojom::MediaStreamType::DISPLAY_AUDIO_CAPTURE,
        blink::mojom::MediaStreamType::DISPLAY_VIDEO_CAPTURE, false, false,
        false);
    picker_ =
        DesktopMediaPickerFactoryImpl::GetInstance()->CreatePicker(&request);
    auto list =
        std::make_unique<FakeDesktopMediaList>(DesktopMediaList::Type::kScreen);
    auto* model = list.get();
    std::vector<std::unique_ptr<DesktopMediaList>> lists;
    lists.push_back(std::move(list));
    ::DesktopMediaPicker::Params params(
        ::DesktopMediaPicker::Params::RequestSource::kGetDisplayMedia);
    params.web_contents = web_contents();
    params.request_audio = true;
    picker_->Show(params, std::move(lists), answer_.GetCallback());
    task_environment()->RunUntilIdle();
    model->AddSourceByFullMediaID(
        content::DesktopMediaID(content::DesktopMediaID::TYPE_SCREEN, 17));
    model->SetSourceName(0, u"Display 1");
    return model;
  }
  std::string Id() const { return *request_.FindString("id"); }
  std::unique_ptr<::DesktopMediaPicker> picker_;
  base::test::TestFuture<::DesktopMediaPicker::DoneCallbackArgumentType>
      answer_;
  base::DictValue request_;
  std::string offer_;
};

TEST_F(DisplayMediaPickerTest, SelectsOnlyListedSourcesForTheAskingPage) {
  auto* model = Show();
  ASSERT_FALSE(request_.empty());
  EXPECT_EQ(*request_.FindString("origin"), "https://asking.test");
  const auto* sources = request_.FindList("sources");
  ASSERT_TRUE(sources);
  // The fake discovers its first source after initial enumeration.
  EXPECT_TRUE(sources->empty());
  const auto source = model->GetSource(0).id.ToString();
  EXPECT_FALSE(DisplayMediaPicker::Resolve(nullptr, Id(), source));
  EXPECT_FALSE(DisplayMediaPicker::Resolve(web_contents(), "stale", source));
  EXPECT_FALSE(answer_.IsReady());
  EXPECT_TRUE(DisplayMediaPicker::Resolve(web_contents(), Id(), source));
  ASSERT_TRUE(answer_.Get().has_value());
  EXPECT_EQ(answer_.Get()->id, 17);
  EXPECT_FALSE(answer_.Get()->audio_share);
  EXPECT_FALSE(DisplayMediaPicker::Resolve(web_contents(), Id(), source));
}

TEST_F(DisplayMediaPickerTest,
       RemovedSourcesCannotBeSelectedAndCancellationSettlesOnce) {
  auto* list = Show();
  const auto source = list->GetSource(0).id.ToString();
  list->RemoveSource(0);
  EXPECT_TRUE(DisplayMediaPicker::Resolve(web_contents(), Id(), source));
  EXPECT_FALSE(answer_.Get().has_value());
  EXPECT_FALSE(DisplayMediaPicker::Resolve(web_contents(), Id(), std::nullopt));
}

TEST_F(DisplayMediaPickerTest, DisablingCancelsOutstandingRequests) {
  Show();
  DisplayMediaPicker::SetEnabled(false);
  EXPECT_FALSE(answer_.Get().has_value());
  EXPECT_FALSE(DisplayMediaPicker::Resolve(web_contents(), Id(), std::nullopt));
}

TEST_F(DisplayMediaPickerTest, DetachingTheAskingPageCancelsConsent) {
  Show();
  DisplayMediaPicker::CancelForContents(nullptr);
  EXPECT_FALSE(answer_.IsReady());
  DisplayMediaPicker::CancelForContents(web_contents());
  EXPECT_EQ(request_.FindBool("cancelled"), true);
  EXPECT_FALSE(answer_.Get().has_value());
  EXPECT_FALSE(DisplayMediaPicker::Resolve(web_contents(), Id(), std::nullopt));
}

TEST_F(DisplayMediaPickerTest, NavigationCancelsAnOutstandingRequest) {
  Show();
  NavigateAndCommit(GURL("https://elsewhere.test/"));
  EXPECT_FALSE(answer_.Get().has_value());
  EXPECT_FALSE(DisplayMediaPicker::Resolve(web_contents(), Id(), std::nullopt));
}
}  // namespace bay
