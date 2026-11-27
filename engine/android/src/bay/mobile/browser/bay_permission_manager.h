// Copyright 2026 Bay authors. Adapted from content/shell/browser/shell_permission_manager.h, Copyright 2015 The
// Chromium Authors. Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#ifndef BAY_MOBILE_BROWSER_BAY_PERMISSION_MANAGER_H_
#define BAY_MOBILE_BROWSER_BAY_PERMISSION_MANAGER_H_

#include <vector>

#include "content/public/browser/permission_controller_delegate.h"

namespace bay {

// Site permissions, as the system WebView gave them: location is asked of the person on Bay's sheet each time (and
// then of Android), granted to that page only; camera and microphone are asked the same way through
// BayTab::RequestMediaAccessPermission. Notifications, MIDI, protected media, clipboard reading and the rest are
// declined; motion sensors, screen wake lock and persistent storage are allowed, as WebView does.
class BayPermissionManager : public content::PermissionControllerDelegate {
 public:
  BayPermissionManager();
  BayPermissionManager(const BayPermissionManager&) = delete;
  BayPermissionManager& operator=(const BayPermissionManager&) = delete;
  ~BayPermissionManager() override;

  // content::PermissionControllerDelegate:
  void RequestPermissionsFromCurrentDocument(
      content::RenderFrameHost* render_frame_host,
      const content::PermissionRequestDescription& request_description,
      base::OnceCallback<void(const std::vector<content::PermissionResult>&)> callback) override;
  blink::mojom::PermissionStatus GetPermissionStatus(const blink::mojom::PermissionDescriptorPtr& permission,
                                                     const GURL& requesting_origin,
                                                     const GURL& embedding_origin) override;
  content::PermissionResult GetPermissionResultForOriginWithoutContext(
      const blink::mojom::PermissionDescriptorPtr& permission_descriptor,
      const url::Origin& requesting_origin,
      const url::Origin& embedding_origin) override;
  content::PermissionResult GetPermissionResultForCurrentDocument(
      const blink::mojom::PermissionDescriptorPtr& permission_descriptor,
      content::RenderFrameHost* render_frame_host,
      bool should_include_device_status) override;
  content::PermissionResult GetPermissionResultForWorker(
      const blink::mojom::PermissionDescriptorPtr& permission_descriptor,
      content::RenderProcessHost* render_process_host,
      const GURL& worker_origin) override;
  content::PermissionResult GetPermissionResultForEmbeddedRequester(
      const blink::mojom::PermissionDescriptorPtr& permission_descriptor,
      content::RenderFrameHost* render_frame_host,
      const url::Origin& requesting_origin) override;
  void ResetPermission(blink::PermissionType permission,
                       const GURL& requesting_origin,
                       const GURL& embedding_origin) override;
};

}  // namespace bay

#endif  // BAY_MOBILE_BROWSER_BAY_PERMISSION_MANAGER_H_
