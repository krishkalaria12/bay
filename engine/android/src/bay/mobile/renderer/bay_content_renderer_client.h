// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#ifndef BAY_MOBILE_RENDERER_BAY_CONTENT_RENDERER_CLIENT_H_
#define BAY_MOBILE_RENDERER_BAY_CONTENT_RENDERER_CLIENT_H_

#include "content/public/renderer/content_renderer_client.h"

namespace bay {

// Each sandboxed renderer's side of Bay: the messenger page tools post through (only in Bay's isolated world) and
// the scripts the browser asks to run as documents start and finish.
class BayContentRendererClient : public content::ContentRendererClient {
 public:
  BayContentRendererClient();
  BayContentRendererClient(const BayContentRendererClient&) = delete;
  BayContentRendererClient& operator=(const BayContentRendererClient&) = delete;
  ~BayContentRendererClient() override;

  // content::ContentRendererClient:
  void RenderFrameCreated(content::RenderFrame* render_frame) override;
  void RunScriptsAtDocumentStart(content::RenderFrame* render_frame) override;
  void RunScriptsAtDocumentEnd(content::RenderFrame* render_frame) override;
};

}  // namespace bay

#endif  // BAY_MOBILE_RENDERER_BAY_CONTENT_RENDERER_CLIENT_H_
