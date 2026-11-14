// Copyright 2026 Bay authors. Adapted from content/shell/browser/shell_permission_manager.cc, Copyright 2015 The
// Chromium Authors. Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#include "bay/mobile/browser/bay_permission_manager.h"

#include <memory>
#include <utility>

#include "base/functional/bind.h"
#include "base/notreached.h"
#include "bay/mobile/browser/bay_tab.h"
#include "content/public/browser/permission_result.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "third_party/blink/public/common/permissions/permission_utils.h"
#include "third_party/blink/public/mojom/permissions/permission_status.mojom.h"

namespace bay {

namespace {

using blink::PermissionType;
using blink::mojom::PermissionStatus;

enum class Policy { kAllow, kAsk, kDeny };

Policy PolicyFor(PermissionType type) {
  switch (type) {
    case PermissionType::GEOLOCATION:
    case PermissionType::GEOLOCATION_APPROXIMATE:
      return Policy::kAsk;
    case PermissionType::SENSORS:
    case PermissionType::WAKE_LOCK_SCREEN:
    case PermissionType::PERSISTENT_STORAGE:
      return Policy::kAllow;
    default:
      return Policy::kDeny;
  }
}

content::PermissionResult ResultFor(PermissionStatus status) {
  return content::PermissionResult(status);
}

// What the current document already holds: a location answer lasts for the page that asked (BayTab forgets it when
// the page changes), so a second getCurrentPosition() doesn't ask again.
PermissionStatus StatusForFrame(PermissionType type, content::RenderFrameHost* frame) {
  switch (PolicyFor(type)) {
    case Policy::kAllow:
      return PermissionStatus::GRANTED;
    case Policy::kDeny:
      return PermissionStatus::DENIED;
    case Policy::kAsk:
      break;
  }
  if (!frame || frame->IsNestedWithinFencedFrame()) {
    return PermissionStatus::DENIED;
  }
  BayTab* tab = BayTab::FromWebContents(content::WebContents::FromRenderFrameHost(frame));
  if (!tab) {
    return PermissionStatus::DENIED;
  }
  return tab->HasLocationGrant(frame->GetLastCommittedOrigin()) ? PermissionStatus::GRANTED : PermissionStatus::ASK;
}

}  // namespace

BayPermissionManager::BayPermissionManager() = default;

BayPermissionManager::~BayPermissionManager() = default;

void BayPermissionManager::RequestPermissionsFromCurrentDocument(
    content::RenderFrameHost* render_frame_host,
    const content::PermissionRequestDescription& request_description,
    base::OnceCallback<void(const std::vector<content::PermissionResult>&)> callback) {
  const size_t count = request_description.permissions.size();
  BayTab* tab = render_frame_host && !render_frame_host->IsNestedWithinFencedFrame()
                    ? BayTab::FromWebContents(content::WebContents::FromRenderFrameHost(render_frame_host))
                    : nullptr;

  // Results keep the order of the request; an asked permission answers when the person (and Android) has.
  std::vector<content::PermissionResult> results(count, ResultFor(PermissionStatus::DENIED));
  std::vector<size_t> asked;
  for (size_t i = 0; i < count; ++i) {
    const PermissionType type = blink::PermissionDescriptorToPermissionType(request_description.permissions[i]);
    const PermissionStatus status = StatusForFrame(type, render_frame_host);
    if (status == PermissionStatus::ASK && tab) {
      asked.push_back(i);
    } else {
      results[i] = ResultFor(status == PermissionStatus::ASK ? PermissionStatus::DENIED : status);
    }
  }
  if (asked.empty()) {
    std::move(callback).Run(results);
    return;
  }
  // Only location is ever asked, so one question answers every asked entry.
  tab->RequestLocationPermission(
      render_frame_host->GetLastCommittedOrigin(),
      base::BindOnce(
          [](std::vector<content::PermissionResult> results, std::vector<size_t> asked,
             base::OnceCallback<void(const std::vector<content::PermissionResult>&)> callback, bool granted) {
            for (size_t i : asked) {
              results[i] = ResultFor(granted ? PermissionStatus::GRANTED : PermissionStatus::DENIED);
            }
            std::move(callback).Run(results);
          },
          std::move(results), std::move(asked), std::move(callback)));
}

PermissionStatus BayPermissionManager::GetPermissionStatus(const blink::mojom::PermissionDescriptorPtr& permission,
                                                           const GURL& requesting_origin,
                                                           const GURL& embedding_origin) {
  switch (PolicyFor(blink::PermissionDescriptorToPermissionType(permission))) {
    case Policy::kAllow:
      return PermissionStatus::GRANTED;
    case Policy::kAsk:
      return PermissionStatus::ASK;
    case Policy::kDeny:
      return PermissionStatus::DENIED;
  }
  NOTREACHED();
}

content::PermissionResult BayPermissionManager::GetPermissionResultForOriginWithoutContext(
    const blink::mojom::PermissionDescriptorPtr& permission_descriptor,
    const url::Origin& requesting_origin,
    const url::Origin& embedding_origin) {
  return ResultFor(
      GetPermissionStatus(permission_descriptor, requesting_origin.GetURL(), embedding_origin.GetURL()));
}

content::PermissionResult BayPermissionManager::GetPermissionResultForCurrentDocument(
    const blink::mojom::PermissionDescriptorPtr& permission_descriptor,
    content::RenderFrameHost* render_frame_host,
    bool should_include_device_status) {
  return ResultFor(
      StatusForFrame(blink::PermissionDescriptorToPermissionType(permission_descriptor), render_frame_host));
}

content::PermissionResult BayPermissionManager::GetPermissionResultForWorker(
    const blink::mojom::PermissionDescriptorPtr& permission_descriptor,
    content::RenderProcessHost* render_process_host,
    const GURL& worker_origin) {
  // Workers never prompt; an asked permission reads as denied there.
  const PermissionStatus status = GetPermissionStatus(permission_descriptor, worker_origin, worker_origin);
  return ResultFor(status == PermissionStatus::ASK ? PermissionStatus::DENIED : status);
}

content::PermissionResult BayPermissionManager::GetPermissionResultForEmbeddedRequester(
    const blink::mojom::PermissionDescriptorPtr& permission_descriptor,
    content::RenderFrameHost* render_frame_host,
    const url::Origin& requesting_origin) {
  return GetPermissionResultForCurrentDocument(permission_descriptor, render_frame_host, false);
}

void BayPermissionManager::ResetPermission(blink::PermissionType permission,
                                           const GURL& requesting_origin,
                                           const GURL& embedding_origin) {}

}  // namespace bay
