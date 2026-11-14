// Copyright 2026 Bay authors. Adapted from content/shell/common/shell_content_client.h, Copyright 2012 The Chromium
// Authors. Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#ifndef BAY_MOBILE_COMMON_BAY_CONTENT_CLIENT_H_
#define BAY_MOBILE_COMMON_BAY_CONTENT_CLIENT_H_

#include <string>
#include <string_view>

#include "content/public/common/content_client.h"

namespace bay {

// Resources and schemes every process shares. Strings and images come from bay_engine.pak (en-US only: Bay draws its
// own UI; the pak holds what the engine itself shows, such as form controls).
class BayContentClient : public content::ContentClient {
 public:
  BayContentClient();
  BayContentClient(const BayContentClient&) = delete;
  BayContentClient& operator=(const BayContentClient&) = delete;
  ~BayContentClient() override;

  std::u16string GetLocalizedString(int message_id) override;
  std::string_view GetDataResource(int resource_id, ui::ResourceScaleFactor scale_factor) override;
  scoped_refptr<base::RefCountedMemory> GetDataResourceBytes(int resource_id) override;
  std::string GetDataResourceString(int resource_id) override;
  gfx::Image& GetNativeImageNamed(int resource_id) override;
  void AddAdditionalSchemes(Schemes* schemes) override;
};

}  // namespace bay

#endif  // BAY_MOBILE_COMMON_BAY_CONTENT_CLIENT_H_
