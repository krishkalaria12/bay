// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/notifications_win.h"

#include "base/base64url.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay::notifications {
namespace {
base::DictValue Response() {
  return base::DictValue()
      .Set("id", "web:site#tag|unicode-\xe2\x98\x83")
      .Set("tabId", "tab-7")
      .Set("windowId", base::Value())
      .Set("data", base::DictValue().Set("engineId", "native-42"));
}
std::string UncheckedId(base::DictValue payload) {
  std::string encoded;
  base::Base64UrlEncode(*base::WriteJson(payload),
                        base::Base64UrlEncodePolicy::OMIT_PADDING, &encoded);
  return "bay-v1:" + encoded;
}
TEST(BayNotificationPayload, RoundTripPreservesTargetsAndDataAfterRestart) {
  auto encoded = EncodeResponse(Response(), true);
  ASSERT_TRUE(encoded);
  auto decoded = DecodeResponse(*encoded, "click");
  ASSERT_TRUE(decoded);
  auto expected = Response();
  expected.Set("action", "click");
  EXPECT_EQ(*decoded, expected);
}
TEST(BayNotificationPayload, CarriesOnlyContractResponseFields) {
  auto response = Response();
  response.Set("origin", "https://private.example/");
  response.Set("profilePath", "/private/profile/path");
  auto encoded = EncodeResponse(response, true);
  ASSERT_TRUE(encoded);
  std::string json;
  ASSERT_TRUE(base::Base64UrlDecode(
      encoded->substr(7), base::Base64UrlDecodePolicy::DISALLOW_PADDING,
      &json));
  EXPECT_EQ(json.find("private.example"), std::string::npos);
  EXPECT_EQ(json.find("/private/profile"), std::string::npos);
}
TEST(BayNotificationPayload, CloseEventsRequireDismissibleRequest) {
  auto normal = EncodeResponse(Response(), false);
  auto dismissible = EncodeResponse(Response(), true);
  ASSERT_TRUE(normal);
  ASSERT_TRUE(dismissible);
  EXPECT_FALSE(DecodeResponse(*normal, "close"));
  EXPECT_TRUE(DecodeResponse(*normal, "click"));
  EXPECT_TRUE(DecodeResponse(*dismissible, "close"));
}
TEST(BayNotificationPayload, RejectsMalformedAndOversizedPayloads) {
  EXPECT_FALSE(DecodeResponse("other-app:abc", "click"));
  EXPECT_FALSE(DecodeResponse("bay-v1:***", "click"));
  EXPECT_FALSE(DecodeResponse(std::string(5501, 'x'), "click"));
  auto response = Response();
  response.Set("data", base::DictValue().Set("large", std::string(4096, 'x')));
  EXPECT_FALSE(EncodeResponse(response, true));
  auto valid = EncodeResponse(Response(), true);
  ASSERT_TRUE(valid);
  EXPECT_FALSE(DecodeResponse(*valid, "openUrl"));
}
TEST(BayNotificationPayload, RejectsWrongFieldTypesOnEncodeAndDecode) {
  for (const char* field : {"id", "tabId", "windowId", "data"}) {
    auto response = Response();
    response.Set(field, 42);
    EXPECT_FALSE(EncodeResponse(response, true)) << field;
    response.Set("dismissible", true);
    EXPECT_FALSE(DecodeResponse(UncheckedId(std::move(response)), "click"))
        << field;
  }
  auto response = Response();
  response.Set("dismissible", "yes");
  EXPECT_FALSE(DecodeResponse(UncheckedId(std::move(response)), "click"));
}
TEST(BayNotificationPayload, RequiresCompleteFieldsAndBoundsIds) {
  auto response = Response();
  response.Remove("data");
  EXPECT_FALSE(EncodeResponse(response, true));
  response = Response();
  response.Set("id", "");
  EXPECT_FALSE(EncodeResponse(response, true));
  response.Set("id", std::string(513, 'x'));
  EXPECT_FALSE(EncodeResponse(response, true));
  response = Response();
  response.Set("tabId", std::string(257, 'x'));
  EXPECT_FALSE(EncodeResponse(response, true));
  response = Response();
  response.Set("id", "\xff");
  EXPECT_FALSE(EncodeResponse(response, true));
}
TEST(BayNotificationPayload, BuffersActivationUntilAnEventSinkIsReady) {
  auto& owner = NotificationsWin::Get();
  owner.SetEventSink({});
  auto encoded = EncodeResponse(Response(), true);
  ASSERT_TRUE(encoded);
  owner.Respond(*encoded, "click");
  owner.Respond("not-a-bay-notification", "click");
  std::vector<base::DictValue> received;
  owner.SetEventSink(base::BindRepeating(
      [](std::vector<base::DictValue>* received, base::DictValue payload) {
        received->push_back(std::move(payload));
      },
      &received));
  ASSERT_EQ(received.size(), 1u);
  EXPECT_EQ(*received[0].FindString("tabId"), "tab-7");
  EXPECT_EQ(*received[0].FindString("action"), "click");
  owner.Respond(*encoded, "close");
  ASSERT_EQ(received.size(), 2u);
  owner.SetEventSink({});
}
}  // namespace
}  // namespace bay::notifications
