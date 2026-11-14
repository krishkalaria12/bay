// Copyright 2026 Bay authors. Adapted from content/shell/app/shell_main_delegate.h, Copyright 2012 The Chromium
// Authors. Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#ifndef BAY_MOBILE_APP_BAY_MAIN_DELEGATE_H_
#define BAY_MOBILE_APP_BAY_MAIN_DELEGATE_H_

#include <memory>
#include <optional>
#include <string>
#include <variant>

#include "content/public/app/content_main_delegate.h"

namespace bay {

class BayContentBrowserClient;
class BayContentClient;
class BayContentRendererClient;

// Starts every process of Bay's engine: the browser process (inside the app) and its sandboxed renderers, GPU and
// utility processes.
class BayMainDelegate : public content::ContentMainDelegate {
 public:
  BayMainDelegate();
  BayMainDelegate(const BayMainDelegate&) = delete;
  BayMainDelegate& operator=(const BayMainDelegate&) = delete;
  ~BayMainDelegate() override;

  std::optional<int> BasicStartupComplete() override;
  void PreSandboxStartup() override;
  std::variant<int, content::MainFunctionParams> RunProcess(
      const std::string& process_type,
      content::MainFunctionParams main_function_params) override;

  content::ContentClient* CreateContentClient() override;
  content::ContentBrowserClient* CreateContentBrowserClient() override;
  content::ContentRendererClient* CreateContentRendererClient() override;

 private:
  static void InitializeResourceBundle();

  std::unique_ptr<BayContentClient> content_client_;
  std::unique_ptr<BayContentBrowserClient> browser_client_;
  std::unique_ptr<BayContentRendererClient> renderer_client_;
};

}  // namespace bay

#endif  // BAY_MOBILE_APP_BAY_MAIN_DELEGATE_H_
