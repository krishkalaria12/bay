// Copyright 2026 Bay authors. The js_injection wiring follows android_webview/renderer/aw_content_renderer_client.cc,
// Copyright 2012 The Chromium Authors. Use of this source code is governed by a BSD-style license that can be found in
// the LICENSE file.

#include "bay/mobile/renderer/bay_content_renderer_client.h"

#include "components/js_injection/common/interfaces.mojom.h"
#include "components/js_injection/renderer/js_communication.h"

namespace bay {

BayContentRendererClient::BayContentRendererClient() = default;

BayContentRendererClient::~BayContentRendererClient() = default;

void BayContentRendererClient::RenderFrameCreated(content::RenderFrame* render_frame) {
  // Owned by the frame (a RenderFrameObserver): deleted with it.
  new js_injection::JsCommunication(render_frame);
}

void BayContentRendererClient::RunScriptsAtDocumentStart(content::RenderFrame* render_frame) {
  if (auto* communication = js_injection::JsCommunication::Get(render_frame)) {
    communication->RunScripts(js_injection::mojom::DocumentInjectionTime::kDocumentStart);
  }
}

void BayContentRendererClient::RunScriptsAtDocumentEnd(content::RenderFrame* render_frame) {
  if (auto* communication = js_injection::JsCommunication::Get(render_frame)) {
    communication->RunScripts(js_injection::mojom::DocumentInjectionTime::kDocumentEnd);
  }
}

}  // namespace bay
