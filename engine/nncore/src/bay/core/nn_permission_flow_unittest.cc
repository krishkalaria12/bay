// Copyright 2026 Bay. Apache-2.0.
#include "bay/core/nn_permission_flow.h"

#include <set>
#include <string>

#include "components/permissions/request_type.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace nncore {

// The JS PermissionKind names both hosts send the app.
TEST(PermissionFlowTest, KindsAreTheAppsNames) {
  using permissions::RequestType;
  EXPECT_STREQ(PermissionKindName(RequestType::kCameraStream), "camera");
  EXPECT_STREQ(PermissionKindName(RequestType::kGeolocation), "location");
  EXPECT_STREQ(PermissionKindName(RequestType::kLoopbackNetwork),
               "localNetwork");
}

// Two request types never reach the app under one name it can't tell apart
// (a camera and microphone group is two kinds, each named once).
TEST(PermissionFlowTest, NoTwoTypesShareAName) {
  using permissions::RequestType;
  std::set<std::string> names;
  for (RequestType type : {RequestType::kCameraStream, RequestType::kMicStream,
                           RequestType::kGeolocation,
                           RequestType::kNotifications}) {
    const char* name = PermissionKindName(type);
    ASSERT_TRUE(name);
    EXPECT_TRUE(names.insert(name).second) << name;
  }
}

}  // namespace nncore
