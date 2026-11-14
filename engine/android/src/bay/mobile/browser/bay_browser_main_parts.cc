// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#include "bay/mobile/browser/bay_browser_main_parts.h"

#include "base/check.h"
#include "base/path_service.h"
#include "base/strings/string_number_conversions.h"
#include "bay/mobile/browser/bay_browser_context.h"
#include "bay/mobile/browser/bay_content_blocker.h"
#include "content/public/common/result_codes.h"

namespace bay {

namespace {
BayBrowserMainParts* g_main_parts = nullptr;
}  // namespace

BayBrowserMainParts::BayBrowserMainParts() {
  DCHECK(!g_main_parts);
  g_main_parts = this;
}

BayBrowserMainParts::~BayBrowserMainParts() {
  g_main_parts = nullptr;
}

// static
BayBrowserMainParts* BayBrowserMainParts::Get() {
  return g_main_parts;
}

// static
base::FilePath BayBrowserMainParts::ProfilesDirectory() {
  base::FilePath data;
  CHECK(base::PathService::Get(base::DIR_ANDROID_APP_DATA, &data));
  // DIR_ANDROID_APP_DATA is the app's app_bay_engine directory (BayEngineApplication sets the suffix).
  return data.Append(FILE_PATH_LITERAL("v1"));
}

BayBrowserContext* BayBrowserMainParts::NormalProfile() {
  if (!normal_profile_) {
    normal_profile_ =
        std::make_unique<BayBrowserContext>(ProfilesDirectory().Append(FILE_PATH_LITERAL("Default")), false);
  }
  return normal_profile_.get();
}

std::unique_ptr<BayBrowserContext> BayBrowserMainParts::CreatePrivateProfile() {
  // Off the record: nothing is written under this path, which only has to be distinct.
  const base::FilePath path =
      ProfilesDirectory().AppendASCII("Private-" + base::NumberToString(++private_profiles_));
  return std::make_unique<BayBrowserContext>(path, true);
}

int BayBrowserMainParts::PreMainMessageLoopRun() {
  BayContentBlocker::Install();
  return content::RESULT_CODE_NORMAL_EXIT;
}

void BayBrowserMainParts::PostMainMessageLoopRun() {
  normal_profile_.reset();
}

}  // namespace bay
