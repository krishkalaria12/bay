// Copyright 2026 Bay authors. Adapted from android_webview/renderer/aw_render_frame_ext.h, Copyright 2012 The
// Chromium Authors. Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#ifndef BAY_MOBILE_RENDERER_BAY_RENDER_FRAME_OBSERVER_H_
#define BAY_MOBILE_RENDERER_BAY_RENDER_FRAME_OBSERVER_H_

#include <string>

#include "content/public/renderer/render_frame_observer.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_registry.h"

namespace bay {

// Bay's per-frame renderer parts that talk to the browser over the frame's associated interfaces: the AutofillAgent,
// which reports the frame's forms to Android Autofill (BayTab::InitializeAutofill) and fills them. Owned by the frame.
class BayRenderFrameObserver : public content::RenderFrameObserver {
 public:
  explicit BayRenderFrameObserver(content::RenderFrame* render_frame);
  BayRenderFrameObserver(const BayRenderFrameObserver&) = delete;
  BayRenderFrameObserver& operator=(const BayRenderFrameObserver&) = delete;

  // content::RenderFrameObserver:
  bool OnAssociatedInterfaceRequestForFrame(const std::string& interface_name,
                                            mojo::ScopedInterfaceEndpointHandle* handle) override;
  void OnDestruct() override;

 private:
  ~BayRenderFrameObserver() override;

  blink::AssociatedInterfaceRegistry registry_;
};

}  // namespace bay

#endif  // BAY_MOBILE_RENDERER_BAY_RENDER_FRAME_OBSERVER_H_
