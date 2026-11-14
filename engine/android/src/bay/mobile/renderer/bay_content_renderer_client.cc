// Copyright 2026 Bay authors. The js_injection wiring follows android_webview/renderer/aw_content_renderer_client.cc,
// Copyright 2012 The Chromium Authors. Use of this source code is governed by a BSD-style license that can be found in
// the LICENSE file.

#include "bay/mobile/renderer/bay_content_renderer_client.h"

#include <string>

#include "base/no_destructor.h"
#include "bay/mobile/renderer/bay_render_frame_observer.h"
#include "bay/core/mojom/nncore.mojom.h"
#include "components/js_injection/common/interfaces.mojom.h"
#include "components/js_injection/renderer/js_communication.h"
#include "content/public/renderer/render_frame.h"
#include "content/public/renderer/render_thread.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "third_party/blink/public/platform/web_string.h"
#include "third_party/blink/public/platform/web_url.h"
#include "third_party/blink/public/web/web_document.h"
#include "third_party/blink/public/web/web_local_frame.h"
#include "third_party/blink/public/web/web_script_source.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace bay {

namespace {

// The content blocker's scriptlets for the document starting in `frame`, run in its main world before any of its own
// scripts, as an extension's document_start script would be: a sync call to the browser (mojom::NNScriptlets), since
// the page's first inline script can run as soon as this returns. As desktop's NNContentRendererClient does.
void RunScriptlets(blink::WebLocalFrame* frame) {
  blink::WebDocument document = frame->GetDocument();
  GURL url(document.Url());
  // An about:blank or srcdoc frame has no URL of its own, and a sandboxed frame has an opaque origin: both are known
  // ways around a blocker's scriptlets. They run for the page whose base URL they inherit.
  if (url.IsAboutBlank() || url.IsAboutSrcdoc() || url::Origin::Create(url).opaque()) {
    url = GURL(document.BaseURL());
  }
  if (!url.SchemeIsHTTPOrHTTPS()) {
    return;
  }
  static base::NoDestructor<mojo::Remote<nncore::mojom::NNScriptlets>> scriptlets;
  if (!scriptlets->is_bound()) {
    content::RenderThread::Get()->BindHostReceiver(scriptlets->BindNewPipeAndPassReceiver());
  }
  const url::Origin top = frame->Top()->GetSecurityOrigin();
  std::string script;
  if (!(*scriptlets)->Get(url.spec(), top.opaque() ? std::string() : top.GetURL().spec(), &script) ||
      script.empty()) {
    return;
  }
  frame->ExecuteScript(
      blink::WebScriptSource(blink::WebString::FromUtf8(script), blink::WebURL(GURL("bay://scriptlets"))));
}

}  // namespace

BayContentRendererClient::BayContentRendererClient() = default;

BayContentRendererClient::~BayContentRendererClient() = default;

void BayContentRendererClient::RenderFrameCreated(content::RenderFrame* render_frame) {
  // Both owned by the frame (RenderFrameObservers): deleted with it.
  new js_injection::JsCommunication(render_frame);
  new BayRenderFrameObserver(render_frame);
}

void BayContentRendererClient::RunScriptsAtDocumentStart(content::RenderFrame* render_frame) {
  RunScriptlets(render_frame->GetWebFrame());
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
