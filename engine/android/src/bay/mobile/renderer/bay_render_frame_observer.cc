// Copyright 2026 Bay authors. Adapted from android_webview/renderer/aw_render_frame_ext.cc, Copyright 2012 The
// Chromium Authors. Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#include "bay/mobile/renderer/bay_render_frame_observer.h"

#include "components/autofill/content/renderer/autofill_agent.h"

namespace bay {

BayRenderFrameObserver::BayRenderFrameObserver(content::RenderFrame* render_frame)
    : content::RenderFrameObserver(render_frame) {
  // Owned by the frame, like this observer. Passwords go through Android Autofill too, so no password agents.
  new autofill::AutofillAgent(render_frame, /*password_autofill_agent=*/nullptr,
                              /*password_generation_agent=*/nullptr, &registry_);
}

BayRenderFrameObserver::~BayRenderFrameObserver() = default;

bool BayRenderFrameObserver::OnAssociatedInterfaceRequestForFrame(const std::string& interface_name,
                                                                  mojo::ScopedInterfaceEndpointHandle* handle) {
  return registry_.TryBindInterface(interface_name, handle);
}

void BayRenderFrameObserver::OnDestruct() {
  delete this;
}

}  // namespace bay
