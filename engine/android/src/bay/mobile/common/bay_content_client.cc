// Copyright 2026 Bay authors. Adapted from content/shell/common/shell_content_client.cc, Copyright 2012 The Chromium
// Authors. Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#include "bay/mobile/common/bay_content_client.h"

#include "base/memory/ref_counted_memory.h"
#include "ui/base/l10n/l10n_util.h"
#include "ui/base/resource/resource_bundle.h"
#include "url/url_constants.h"

namespace bay {

BayContentClient::BayContentClient() = default;

BayContentClient::~BayContentClient() = default;

std::u16string BayContentClient::GetLocalizedString(int message_id) {
  return l10n_util::GetStringUTF16(message_id);
}

std::string_view BayContentClient::GetDataResource(int resource_id, ui::ResourceScaleFactor scale_factor) {
  return ui::ResourceBundle::GetSharedInstance().GetRawDataResourceForScale(resource_id, scale_factor);
}

scoped_refptr<base::RefCountedMemory> BayContentClient::GetDataResourceBytes(int resource_id) {
  return ui::ResourceBundle::GetSharedInstance().LoadDataResourceBytes(resource_id);
}

std::string BayContentClient::GetDataResourceString(int resource_id) {
  return ui::ResourceBundle::GetSharedInstance().LoadDataResourceString(resource_id);
}

gfx::Image& BayContentClient::GetNativeImageNamed(int resource_id) {
  return ui::ResourceBundle::GetSharedInstance().GetNativeImageNamed(resource_id);
}

void BayContentClient::AddAdditionalSchemes(Schemes* schemes) {
  // content:// documents (a page opened from another app's file) load as local files do.
  schemes->local_schemes.push_back(url::kContentScheme);
}

}  // namespace bay
