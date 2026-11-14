// Copyright 2026 Bay authors. Adapted from content/shell/app/shell_main_delegate.cc, Copyright 2012 The Chromium
// Authors. Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#include "bay/mobile/app/bay_main_delegate.h"

#include <tuple>
#include <utility>

#include "base/android/apk_assets.h"
#include "base/check_op.h"
#include "base/files/file.h"
#include "base/files/memory_mapped_file.h"
#include "base/posix/global_descriptors.h"
#include "base/process/current_process.h"
#include "bay/mobile/browser/bay_content_browser_client.h"
#include "bay/mobile/common/bay_content_client.h"
#include "bay/mobile/common/bay_descriptors.h"
#include "bay/mobile/renderer/bay_content_renderer_client.h"
#include "content/public/browser/android/compositor.h"
#include "content/public/browser/browser_main_runner.h"
#include "content/public/common/main_function_params.h"
#include "ui/base/resource/resource_bundle.h"
#include "ui/base/resource/resource_scale_factor.h"

namespace bay {

namespace {
constexpr char kPakAsset[] = "assets/bay_engine.pak";
}  // namespace

BayMainDelegate::BayMainDelegate() = default;

BayMainDelegate::~BayMainDelegate() = default;

std::optional<int> BayMainDelegate::BasicStartupComplete() {
  content::Compositor::Initialize();
  return std::nullopt;
}

void BayMainDelegate::PreSandboxStartup() {
  InitializeResourceBundle();
}

std::variant<int, content::MainFunctionParams> BayMainDelegate::RunProcess(
    const std::string& process_type,
    content::MainFunctionParams main_function_params) {
  // Child processes run their own main loop once this returns.
  if (!process_type.empty()) {
    return std::move(main_function_params);
  }
  base::CurrentProcess::GetInstance().SetProcessType(base::CurrentProcessType::PROCESS_BROWSER);

  // Android runs the browser on the app's own message loop: create the runner, initialize it, and leave it alive for
  // the life of the process (Chrome for Android never shuts it down either).
  std::unique_ptr<content::BrowserMainRunner> main_runner = content::BrowserMainRunner::Create();
  int exit_code = main_runner->Initialize(std::move(main_function_params));
  DCHECK_LT(exit_code, 0) << "BrowserMainRunner::Initialize failed";
  std::ignore = main_runner.release();
  return 0;
}

// The browser process opens the pak from the APK and shares its descriptor with every child process, which can't
// read the APK from inside its sandbox (BayContentBrowserClient::GetAdditionalMappedFilesForChildProcess).
void BayMainDelegate::InitializeResourceBundle() {
  auto* global_descriptors = base::GlobalDescriptors::GetInstance();
  int pak_fd = global_descriptors->MaybeGet(kBayEnginePakDescriptor);
  base::MemoryMappedFile::Region pak_region;
  if (pak_fd >= 0) {
    pak_region = global_descriptors->GetRegion(kBayEnginePakDescriptor);
  } else {
    pak_fd = base::android::OpenApkAsset(kPakAsset, &pak_region);
    CHECK_GE(pak_fd, 0) << "bay_engine.pak is missing from the APK's assets";
    global_descriptors->Set(kBayEnginePakDescriptor, pak_fd, pak_region);
  }
  base::File pak_file(pak_fd);
  ui::ResourceBundle::InitSharedInstanceWithPakFileRegion(pak_file.Duplicate(), pak_region);
  ui::ResourceBundle::GetSharedInstance().AddDataPackFromFileRegion(std::move(pak_file), pak_region,
                                                                     ui::k100Percent);
}

content::ContentClient* BayMainDelegate::CreateContentClient() {
  content_client_ = std::make_unique<BayContentClient>();
  return content_client_.get();
}

content::ContentBrowserClient* BayMainDelegate::CreateContentBrowserClient() {
  browser_client_ = std::make_unique<BayContentBrowserClient>();
  return browser_client_.get();
}

content::ContentRendererClient* BayMainDelegate::CreateContentRendererClient() {
  renderer_client_ = std::make_unique<BayContentRendererClient>();
  return renderer_client_.get();
}

}  // namespace bay
