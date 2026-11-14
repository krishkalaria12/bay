// Copyright 2026 Bay authors. The media answer follows android_webview/browser/permission/
// media_access_permission_request.cc, Copyright 2014 The Chromium Authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#include "bay/mobile/browser/bay_tab.h"

#include <algorithm>
#include <utility>
#include <vector>

#include "base/android/jni_string.h"
#include "base/base64.h"
#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/supports_user_data.h"
#include "base/task/sequenced_task_runner.h"
#include "base/values.h"
#include "bay/mobile/browser/bay_browser_context.h"
#include "bay/mobile/browser/bay_content_blocker.h"
#include "bay/mobile/common/bay_isolated_world.h"
#include "components/android_autofill/browser/android_autofill_client.h"
#include "components/android_autofill/browser/autofill_provider.h"
#include "components/autofill/content/browser/content_autofill_client.h"
#include "components/download/public/common/download_url_parameters.h"
#include "components/embedder_support/user_agent_utils.h"
#include "components/js_injection/browser/js_communication_host.h"
#include "components/js_injection/browser/web_message.h"
#include "components/js_injection/browser/web_message_host.h"
#include "components/js_injection/browser/web_message_host_factory.h"
#include "components/js_injection/browser/web_message_reply_proxy.h"
#include "components/js_injection/common/interfaces.mojom.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/context_menu_params.h"
#include "content/public/browser/download_manager.h"
#include "content/public/browser/download_request_utils.h"
#include "content/public/browser/file_select_listener.h"
#include "content/public/browser/media_capture_devices.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/navigation_entry_restore_context.h"
#include "content/public/browser/page.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/restore_type.h"
#include "content/public/browser/web_contents.h"
#include "content/public/common/javascript_dialog_type.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "third_party/blink/public/common/messaging/string_message_codec.h"
#include "third_party/blink/public/common/page_state/page_state.h"
#include "third_party/blink/public/common/user_agent/user_agent_metadata.h"
#include "third_party/blink/public/mojom/choosers/file_chooser.mojom.h"
#include "third_party/blink/public/mojom/context_menu/context_menu.mojom.h"
#include "third_party/blink/public/mojom/mediastream/media_stream.mojom.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/gfx/android/java_bitmap.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"

// Must come after the headers above.
#include "bay/mobile/jni_headers/BayTab_jni.h"

using base::android::ConvertJavaStringToUTF16;
using base::android::ConvertJavaStringToUTF8;
using base::android::ConvertUTF16ToJavaString;
using base::android::ConvertUTF8ToJavaString;
using base::android::JavaRef;
using base::android::ScopedJavaLocalRef;

namespace bay {

namespace {

const void* const kTabKey = &kTabKey;

// Lets the permission manager and the page tools messenger find the tab that owns a WebContents.
class TabPointer : public base::SupportsUserData::Data {
 public:
  explicit TabPointer(BayTab* tab) : tab_(tab) {}
  BayTab* tab() const { return tab_; }

 private:
  const raw_ptr<BayTab> tab_;
};

// Collects the classes and ids a document uses and asks for the blocker's CSS for them: at DOMContentLoaded (with the
// site's own rules), then after load for any new ones. Runs in Bay's isolated world of every frame; a cross-origin
// frame (ads, embeds) only gets its site rules, since scanning its whole DOM runs on the page's main thread.
constexpr char16_t kCosmeticScript[] = uR"JS((() => {
  if (window.__bayCosmeticDone) return;
  window.__bayCosmeticDone = true;
  let scan = true;
  try { scan = window === window.top || !!window.top.location.href; } catch (e) { scan = false; }
  const seen = { classes: new Set(), ids: new Set() };
  let first = true;
  __bayPage.addEventListener("message", (event) => {
    let reply;
    try { reply = JSON.parse(event.data); } catch (e) { return; }
    if (!reply || reply.kind !== "cosmetic" || !reply.css) return;
    const style = document.createElement("style");
    style.textContent = reply.css;
    (document.head || document.documentElement).appendChild(style);
  });
  const ask = () => {
    const classes = [], ids = [];
    if (scan) for (const el of document.querySelectorAll("[class],[id]")) {
      for (const c of el.classList) if (!seen.classes.has(c)) { seen.classes.add(c); classes.push(c); }
      if (el.id && !seen.ids.has(el.id)) { seen.ids.add(el.id); ids.push(el.id); }
    }
    if (!first && !classes.length && !ids.length) return;
    __bayPage.postMessage(JSON.stringify({ kind: "cosmetic", url: location.href, classes, ids, first }));
    first = false;
  };
  ask();
  if (scan) window.addEventListener("load", ask, { once: true });
})();)JS";

// One per document that posts through __bayPage. Cosmetic requests are answered here, for any frame; everything else
// counts only from the main frame: a subframe's isolated world can post too, but none of Bay's page tools live there.
class PageToolsHost : public js_injection::WebMessageHost {
 public:
  PageToolsHost(BayTab* tab, bool is_main_frame, js_injection::WebMessageReplyProxy* proxy)
      : tab_(tab), is_main_frame_(is_main_frame), proxy_(proxy) {}

  void OnPostMessage(std::unique_ptr<js_injection::WebMessage> message) override {
    const auto* text = std::get_if<std::u16string>(&message->message);
    if (!text) {
      return;
    }
    if (AnswerCosmetic(*text)) {
      return;
    }
    if (is_main_frame_) {
      tab_->OnPageToolsMessage(*text);
    }
  }

 private:
  bool AnswerCosmetic(const std::u16string& text) {
    std::optional<base::Value> parsed = base::JSONReader::Read(base::UTF16ToUTF8(text));
    if (!parsed || !parsed->is_dict()) {
      return false;
    }
    const base::Value::Dict& request = parsed->GetDict();
    const std::string* kind = request.FindString("kind");
    if (!kind || *kind != "cosmetic") {
      return false;
    }
    const std::string* url = request.FindString("url");
    const base::Value::List* classes = request.FindList("classes");
    const base::Value::List* ids = request.FindList("ids");
    if (!url || !classes || !ids) {
      return true;
    }
    const std::string css = BayContentBlocker::CosmeticCss(
        *url, base::WriteJson(*classes).value_or("[]"), base::WriteJson(*ids).value_or("[]"),
        request.FindBool("first").value_or(false));
    if (!css.empty()) {
      base::Value::Dict reply;
      reply.Set("kind", "cosmetic");
      reply.Set("css", css);
      proxy_->PostWebMessage(base::UTF8ToUTF16(base::WriteJson(reply).value_or("{}")));
    }
    return true;
  }

  const raw_ptr<BayTab> tab_;
  const bool is_main_frame_;
  const raw_ptr<js_injection::WebMessageReplyProxy> proxy_;
};

class PageToolsHostFactory : public js_injection::WebMessageHostFactory {
 public:
  explicit PageToolsHostFactory(BayTab* tab) : tab_(tab) {}

  std::unique_ptr<js_injection::WebMessageHost> CreateHost(const std::string& top_level_origin_string,
                                                           const std::string& origin_string,
                                                           bool is_main_frame,
                                                           js_injection::WebMessageReplyProxy* proxy) override {
    return std::make_unique<PageToolsHost>(tab_, is_main_frame, proxy);
  }

 private:
  const raw_ptr<BayTab> tab_;
};

const blink::MediaStreamDevice* DeviceByIdOrFirst(const blink::MediaStreamDevices& devices,
                                                  const std::vector<std::string>& device_ids) {
  if (devices.empty()) {
    return nullptr;
  }
  if (!device_ids.empty()) {
    for (const auto& device : devices) {
      if (device.id == device_ids.front()) {
        return &device;
      }
    }
  }
  return &devices.front();
}

int DialogTypeForJava(content::JavaScriptDialogType type) {
  switch (type) {
    case content::JAVASCRIPT_DIALOG_TYPE_ALERT:
      return 0;
    case content::JAVASCRIPT_DIALOG_TYPE_CONFIRM:
      return 1;
    case content::JAVASCRIPT_DIALOG_TYPE_PROMPT:
      return 2;
  }
  return 0;
}

// Desktop site (B12): Chrome on macOS at this engine's version, which BayTab.java turns on per navigation. Mobile
// pages get the engine's own Android agent.
blink::UserAgentOverride DesktopUserAgent() {
  blink::UserAgentOverride desktop;
  desktop.ua_string_override = embedder_support::BuildUserAgentFromOSAndProduct(
      "Macintosh; Intel Mac OS X 10_15_7", embedder_support::GetProductAndVersion());
  blink::UserAgentMetadata metadata = embedder_support::GetUserAgentMetadata();
  metadata.platform = "macOS";
  metadata.platform_version = "10.15.7";
  metadata.architecture = "x86";
  metadata.bitness = "64";
  metadata.model = std::string();
  metadata.mobile = false;
  metadata.form_factors = {blink::kDesktopFormFactor};
  desktop.ua_metadata_override = std::move(metadata);
  return desktop;
}

// Saved tab states (BayTab.saveState): a version, the current entry, and each entry's address, title, page state and
// desktop-site flag. A state of another version, or one that doesn't parse, restores nothing.
constexpr int kStateVersion = 1;

constexpr net::NetworkTrafficAnnotationTag kSaveImageAnnotation = net::DefineNetworkTrafficAnnotation("bay_save_image",
                                                                                                      R"(
    semantics {
      sender: "Bay"
      description: "Saves an image from a page to the person's downloads."
      trigger: "The person chooses Save image in a page's menu."
      data: "The image's address, with the site's cookies, as the page would load it."
      destination: WEBSITE
    }
    policy {
      cookies_allowed: YES
      cookies_store: "The page's profile."
      setting: "None: it only runs when the person asks."
      policy_exception_justification: "Not a //chrome feature."
    })");

}  // namespace

BayTab::BayTab(JNIEnv* env, const JavaRef<jobject>& java_tab, BayBrowserContext* browser_context)
    : web_contents_delegate_android::WebContentsDelegateAndroid(env, java_tab) {
  content::WebContents::CreateParams params(browser_context);
  web_contents_ = content::WebContents::Create(params);
  web_contents_->SetUserData(kTabKey, std::make_unique<TabPointer>(this));
  web_contents_->SetDelegate(this);
  // Used only by navigations that ask for the desktop site (BayTab.java, NavigationController.setUseDesktopUserAgent).
  web_contents_->SetUserAgentOverride(DesktopUserAgent(), /*override_in_new_tabs=*/false);
  Observe(web_contents_.get());

  js_communication_ = std::make_unique<js_injection::JsCommunicationHost>(web_contents_.get());
  const std::u16string error = js_communication_->AddWebMessageHostFactory(
      std::make_unique<PageToolsHostFactory>(this), kPageToolsMessenger, {"*"}, kPageToolsWorldId);
  DCHECK(error.empty()) << error;
  js_communication_->AddPersistentJavaScript(kCosmeticScript, js_injection::mojom::DocumentInjectionTime::kDocumentEnd,
                                             {"*"}, kPageToolsWorldId);
}

BayTab::~BayTab() {
  CancelRequests(/*notify_java=*/false);
  Observe(nullptr);
  js_communication_.reset();
  web_contents_->SetDelegate(nullptr);
  web_contents_->RemoveUserData(kTabKey);
  web_contents_.reset();
}

// static
BayTab* BayTab::FromWebContents(content::WebContents* web_contents) {
  if (!web_contents) {
    return nullptr;
  }
  auto* pointer = static_cast<TabPointer*>(web_contents->GetUserData(kTabKey));
  return pointer ? pointer->tab() : nullptr;
}

ScopedJavaLocalRef<jobject> BayTab::GetJavaWebContents() {
  return web_contents_->GetJavaWebContents();
}

// Runs in Bay's isolated world of the main frame. The script posts its own result through __bayPage (BayTab.java
// wraps it), since a script's returned promise isn't awaited here. False when no page has committed yet.
bool BayTab::EvaluateInPageTools(const std::u16string& script) {
  content::RenderFrameHost* frame = web_contents_->GetPrimaryMainFrame();
  if (!page_committed_ || !frame || !frame->IsRenderFrameLive()) {
    return false;
  }
  frame->ExecuteJavaScriptInIsolatedWorld(script, content::RenderFrameHost::JavaScriptResultCallback(),
                                          kPageToolsWorldId);
  return true;
}

void BayTab::OnPageToolsMessage(const std::u16string& message) {
  JNIEnv* env = base::android::AttachCurrentThread();
  ScopedJavaLocalRef<jobject> java_tab = GetJavaDelegate(env);
  if (java_tab.is_null()) {
    return;
  }
  Java_BayTab_onPageToolsMessage(env, java_tab, ConvertUTF16ToJavaString(env, message));
}

std::string BayTab::SaveState() {
  content::NavigationController& controller = web_contents_->GetController();
  base::Value::List entries;
  int current = -1;
  for (int i = 0; i < controller.GetEntryCount(); ++i) {
    content::NavigationEntry* entry = controller.GetEntryAtIndex(i);
    // Bay's error and start pages aren't history worth keeping; the entries around them are.
    if (entry->IsInitialEntry() || !entry->GetURL().SchemeIsHTTPOrHTTPS()) {
      continue;
    }
    if (i <= controller.GetCurrentEntryIndex()) {
      current = static_cast<int>(entries.size());
    }
    base::Value::Dict saved;
    saved.Set("url", entry->GetURL().spec());
    saved.Set("title", entry->GetTitle());
    saved.Set("state", base::Base64Encode(entry->GetPageState().ToEncodedData()));
    saved.Set("desktop", entry->GetIsOverridingUserAgent());
    entries.Append(std::move(saved));
  }
  if (entries.empty() || current < 0) {
    return std::string();
  }
  base::Value::Dict state;
  state.Set("version", kStateVersion);
  state.Set("index", current);
  state.Set("entries", std::move(entries));
  return base::WriteJson(state).value_or(std::string());
}

bool BayTab::RestoreState(const std::string& state) {
  content::NavigationController& controller = web_contents_->GetController();
  std::optional<base::Value> parsed = base::JSONReader::Read(state);
  const base::Value::Dict* saved = parsed ? parsed->GetIfDict() : nullptr;
  if (!saved || saved->FindInt("version") != kStateVersion || !controller.IsInitialBlankNavigation()) {
    return false;
  }
  const base::Value::List* list = saved->FindList("entries");
  const int index = saved->FindInt("index").value_or(-1);
  if (!list || index < 0 || index >= static_cast<int>(list->size())) {
    return false;
  }
  std::unique_ptr<content::NavigationEntryRestoreContext> context = content::NavigationEntryRestoreContext::Create();
  std::vector<std::unique_ptr<content::NavigationEntry>> entries;
  for (const base::Value& item : *list) {
    const base::Value::Dict* fields = item.GetIfDict();
    const std::string* url = fields ? fields->FindString("url") : nullptr;
    const std::string* encoded = fields ? fields->FindString("state") : nullptr;
    std::string page_state;
    if (!url || !encoded || !GURL(*url).SchemeIsHTTPOrHTTPS() || !base::Base64Decode(*encoded, &page_state)) {
      return false;
    }
    std::unique_ptr<content::NavigationEntry> entry = content::NavigationEntry::Create();
    entry->SetURL(GURL(*url));
    if (const std::string* title = fields->FindString("title")) {
      entry->SetTitle(base::UTF8ToUTF16(*title));
    }
    entry->SetPageState(blink::PageState::CreateFromEncodedData(page_state), context.get());
    entry->SetIsOverridingUserAgent(fields->FindBool("desktop").value_or(false));
    entries.push_back(std::move(entry));
  }
  controller.Restore(index, content::RestoreType::kRestored, &entries);
  controller.LoadIfNecessary();
  return true;
}

void BayTab::CaptureSnapshot(int request_id, int max_width) {
  content::RenderWidgetHostView* view = web_contents_->GetRenderWidgetHostView();
  const gfx::Size size = view ? view->GetViewBounds().size() : gfx::Size();
  if (!view || !view->IsSurfaceAvailableForCopy() || size.IsEmpty() || max_width <= 0) {
    DeliverSnapshot(request_id, nullptr);
    return;
  }
  const float scale = std::min(1.0f, static_cast<float>(max_width) / size.width());
  const gfx::Size output(std::max(1, static_cast<int>(size.width() * scale)),
                         std::max(1, static_cast<int>(size.height() * scale)));
  view->CopyFromSurface(gfx::Rect(), output, base::TimeDelta(),
                        base::BindOnce(
                            [](base::WeakPtr<BayTab> tab, int request_id,
                               const content::CopyFromSurfaceResult& result) {
                              if (tab) {
                                tab->DeliverSnapshot(request_id, result.has_value() ? &result->bitmap : nullptr);
                              }
                            },
                            GetWeakPtr(), request_id));
}

void BayTab::DeliverSnapshot(int request_id, const SkBitmap* bitmap) {
  JNIEnv* env = base::android::AttachCurrentThread();
  ScopedJavaLocalRef<jobject> java_tab = GetJavaDelegate(env);
  if (java_tab.is_null()) {
    return;
  }
  Java_BayTab_onSnapshot(env, java_tab, request_id,
                         bitmap && !bitmap->drawsNothing()
                             ? gfx::ConvertToJavaBitmap(*bitmap, gfx::OomBehavior::kReturnNullOnOom)
                             : ScopedJavaLocalRef<jobject>());
}

void BayTab::Download(const GURL& url) {
  if (!url.is_valid()) {
    return;
  }
  std::unique_ptr<download::DownloadUrlParameters> params =
      content::DownloadRequestUtils::CreateDownloadForWebContentsMainFrame(web_contents_.get(), url,
                                                                           kSaveImageAnnotation);
  params->set_download_source(download::DownloadSource::CONTEXT_MENU);
  web_contents_->GetBrowserContext()->GetDownloadManager()->DownloadUrl(std::move(params));
}

// As WebView does (AwContents::InitializeAndroidAutofill): the Java AutofillProvider has made the native provider, and
// the client makes a driver per frame, which the renderer's AutofillAgent talks to (BayContentRendererClient).
void BayTab::InitializeAutofill() {
  autofill::AutofillProvider* provider = autofill::AutofillProvider::FromWebContents(web_contents_.get());
  if (!provider || autofill::ContentAutofillClient::FromWebContents(web_contents_.get())) {
    return;
  }
  android_autofill::AndroidAutofillClient::CreateForWebContents(web_contents_.get());
  // After the client and before any AutofillManager, as WebView orders it.
  provider->MaybeInitKeyboardSuppressor();
}

// A long press on a link or an image: the app shows its own menu where the finger is. Anything else (text) keeps
// Chromium's own selection.
bool BayTab::HandleContextMenu(content::RenderFrameHost& render_frame_host, const content::ContextMenuParams& params) {
  const bool image = params.media_type == blink::mojom::ContextMenuDataMediaType::kImage;
  const bool link = params.link_url.SchemeIsHTTPOrHTTPS();
  if (!image && !link) {
    return false;
  }
  JNIEnv* env = base::android::AttachCurrentThread();
  ScopedJavaLocalRef<jobject> java_tab = GetJavaDelegate(env);
  if (java_tab.is_null()) {
    return false;
  }
  Java_BayTab_onContextMenu(env, java_tab, ConvertUTF8ToJavaString(env, link ? params.link_url.spec() : std::string()),
                            ConvertUTF16ToJavaString(env, params.link_text),
                            ConvertUTF8ToJavaString(env, image ? params.src_url.spec() : std::string()), params.x,
                            params.y);
  return true;
}

int BayTab::AskPermission(PermissionKind kind, const url::Origin& origin, base::OnceCallback<void(bool)> callback) {
  JNIEnv* env = base::android::AttachCurrentThread();
  ScopedJavaLocalRef<jobject> java_tab = GetJavaDelegate(env);
  if (java_tab.is_null()) {
    std::move(callback).Run(false);
    return 0;
  }
  const int id = next_request_id_++;
  pending_permissions_[id] = std::move(callback);
  Java_BayTab_requestPermission(env, java_tab, id, static_cast<int>(kind),
                                ConvertUTF8ToJavaString(env, origin.Serialize()));
  return id;
}

void BayTab::AnswerPermission(int request_id, bool granted) {
  auto it = pending_permissions_.find(request_id);
  if (it == pending_permissions_.end()) {
    return;
  }
  base::OnceCallback<void(bool)> callback = std::move(it->second);
  pending_permissions_.erase(it);
  std::move(callback).Run(granted);
}

bool BayTab::HasLocationGrant(const url::Origin& origin) const {
  return location_grants_.contains(origin);
}

void BayTab::RequestLocationPermission(const url::Origin& origin, base::OnceCallback<void(bool)> callback) {
  AskPermission(PermissionKind::kLocation, origin,
                base::BindOnce(
                    [](base::WeakPtr<content::WebContents> web_contents, url::Origin origin,
                       base::OnceCallback<void(bool)> callback, bool granted) {
                      BayTab* tab = BayTab::FromWebContents(web_contents.get());
                      if (granted && tab) {
                        tab->location_grants_.insert(origin);
                      }
                      std::move(callback).Run(granted);
                    },
                    web_contents_->GetWeakPtr(), origin, std::move(callback)));
}

void BayTab::RequestMediaAccessPermission(content::WebContents* web_contents,
                                          const content::MediaStreamRequest& request,
                                          content::MediaResponseCallback callback) {
  const bool audio = request.audio_type == blink::mojom::MediaStreamType::DEVICE_AUDIO_CAPTURE;
  const bool video = request.video_type == blink::mojom::MediaStreamType::DEVICE_VIDEO_CAPTURE;
  if (!audio && !video) {
    // Screen and tab capture aren't offered.
    std::move(callback).Run(blink::mojom::StreamDevicesSet(), blink::mojom::MediaStreamRequestResult::NOT_SUPPORTED,
                            nullptr);
    return;
  }
  PermissionKind kind = PermissionKind::kMicrophone;
  if (audio && video) {
    kind = PermissionKind::kCameraAndMicrophone;
  } else if (video) {
    kind = PermissionKind::kCamera;
  }
  AskPermission(kind, request.url_origin,
                base::BindOnce(&BayTab::AnswerMediaRequest, base::Unretained(this), request, std::move(callback)));
}

void BayTab::AnswerMediaRequest(const content::MediaStreamRequest& request,
                                content::MediaResponseCallback callback,
                                bool granted) {
  if (!granted) {
    std::move(callback).Run(blink::mojom::StreamDevicesSet(),
                            blink::mojom::MediaStreamRequestResult::PERMISSION_DENIED, nullptr);
    return;
  }
  blink::mojom::StreamDevicesSet stream_devices_set;
  stream_devices_set.stream_devices.emplace_back(blink::mojom::StreamDevices::New());
  blink::mojom::StreamDevices& devices = *stream_devices_set.stream_devices[0];
  if (request.audio_type == blink::mojom::MediaStreamType::DEVICE_AUDIO_CAPTURE) {
    if (const blink::MediaStreamDevice* device = DeviceByIdOrFirst(
            content::MediaCaptureDevices::GetInstance()->GetAudioCaptureDevices(),
            request.requested_audio_device_ids)) {
      devices.audio_device = *device;
    }
  }
  if (request.video_type == blink::mojom::MediaStreamType::DEVICE_VIDEO_CAPTURE) {
    if (const blink::MediaStreamDevice* device = DeviceByIdOrFirst(
            content::MediaCaptureDevices::GetInstance()->GetVideoCaptureDevices(),
            request.requested_video_device_ids)) {
      devices.video_device = *device;
    }
  }
  const bool no_hardware = !devices.audio_device.has_value() && !devices.video_device.has_value();
  if (no_hardware) {
    stream_devices_set.stream_devices.clear();
  }
  std::move(callback).Run(
      stream_devices_set,
      no_hardware ? blink::mojom::MediaStreamRequestResult::NO_HARDWARE : blink::mojom::MediaStreamRequestResult::OK,
      nullptr);
}

bool BayTab::CheckMediaAccessPermission(content::RenderFrameHost* render_frame_host,
                                        const url::Origin& security_origin,
                                        blink::mojom::MediaStreamType type) {
  // Device labels stay hidden from enumerateDevices(); getUserMedia() still asks.
  return false;
}

// A new window becomes a new tab in the app, in the opener's own session (BayTab.java knows whether it's private).
// The opener's page stays as it is, and the window itself is never created here.
bool BayTab::IsWebContentsCreationOverridden(content::RenderFrameHost* opener,
                                             content::SiteInstance* source_site_instance,
                                             content::mojom::WindowContainerType window_container_type,
                                             const GURL& opener_url,
                                             const std::string& frame_name,
                                             const GURL& target_url) {
  JNIEnv* env = base::android::AttachCurrentThread();
  ScopedJavaLocalRef<jobject> java_tab = GetJavaDelegate(env);
  if (!java_tab.is_null() && target_url.SchemeIsHTTPOrHTTPS()) {
    const bool user_gesture = opener && opener->HasTransientUserActivation();
    Java_BayTab_onNewWindow(env, java_tab, ConvertUTF8ToJavaString(env, target_url.spec()), user_gesture);
  }
  return true;
}

content::JavaScriptDialogManager* BayTab::GetJavaScriptDialogManager(content::WebContents* source) {
  return this;
}

void BayTab::RunJavaScriptDialog(content::WebContents* web_contents,
                                 content::RenderFrameHost* render_frame_host,
                                 content::JavaScriptDialogType dialog_type,
                                 const std::u16string& message_text,
                                 const std::u16string& default_prompt_text,
                                 DialogClosedCallback callback,
                                 bool* did_suppress_message) {
  JNIEnv* env = base::android::AttachCurrentThread();
  ScopedJavaLocalRef<jobject> java_tab = GetJavaDelegate(env);
  if (java_tab.is_null() || !render_frame_host || !render_frame_host->IsActive()) {
    *did_suppress_message = true;
    return;
  }
  const int id = next_request_id_++;
  pending_dialogs_[id] = std::move(callback);
  Java_BayTab_showJavaScriptDialog(env, java_tab, id, DialogTypeForJava(dialog_type),
                                   ConvertUTF16ToJavaString(env, message_text),
                                   ConvertUTF16ToJavaString(env, default_prompt_text),
                                   ConvertUTF8ToJavaString(env, render_frame_host->GetLastCommittedURL().spec()));
}

void BayTab::RunBeforeUnloadDialog(content::WebContents* web_contents,
                                   content::RenderFrameHost* render_frame_host,
                                   bool is_reload,
                                   DialogClosedCallback callback) {
  // Leaving a page is never held up by the page: the system WebView didn't ask either.
  std::move(callback).Run(true, std::u16string());
}

void BayTab::CancelDialogs(content::WebContents* web_contents, bool reset_state) {
  auto dialogs = std::move(pending_dialogs_);
  pending_dialogs_.clear();
  for (auto& [id, callback] : dialogs) {
    std::move(callback).Run(false, std::u16string());
  }
}

void BayTab::AnswerDialog(int request_id, bool accepted, const std::u16string& text) {
  auto it = pending_dialogs_.find(request_id);
  if (it == pending_dialogs_.end()) {
    return;
  }
  DialogClosedCallback callback = std::move(it->second);
  pending_dialogs_.erase(it);
  std::move(callback).Run(accepted, text);
}

void BayTab::RunFileChooser(content::RenderFrameHost* render_frame_host,
                            scoped_refptr<content::FileSelectListener> listener,
                            const blink::mojom::FileChooserParams& params) {
  using Mode = blink::mojom::FileChooserParams::Mode;
  JNIEnv* env = base::android::AttachCurrentThread();
  ScopedJavaLocalRef<jobject> java_tab = GetJavaDelegate(env);
  if (java_tab.is_null() || (params.mode != Mode::kOpen && params.mode != Mode::kOpenMultiple)) {
    // Folders and "save as" aren't offered on a phone.
    listener->FileSelectionCanceled();
    return;
  }
  const int id = next_request_id_++;
  pending_file_choosers_[id] = std::move(listener);
  Java_BayTab_showFileChooser(env, java_tab, id,
                              ConvertUTF16ToJavaString(env, base::JoinString(params.accept_types, u",")),
                              params.mode == Mode::kOpenMultiple, params.use_media_capture);
}

// `files_json`: [{"uri": "content://…", "name": "photo.jpg"}, …]; an empty list cancels.
void BayTab::AnswerFileChooser(int request_id, const std::string& files_json) {
  auto it = pending_file_choosers_.find(request_id);
  if (it == pending_file_choosers_.end()) {
    return;
  }
  scoped_refptr<content::FileSelectListener> listener = std::move(it->second);
  pending_file_choosers_.erase(it);

  std::vector<blink::mojom::FileChooserFileInfoPtr> files;
  std::optional<base::Value> parsed = base::JSONReader::Read(files_json);
  if (parsed && parsed->is_list()) {
    for (const base::Value& item : parsed->GetList()) {
      const base::Value::Dict* file = item.GetIfDict();
      const std::string* uri = file ? file->FindString("uri") : nullptr;
      if (!uri) {
        continue;
      }
      const std::string* name = file->FindString("name");
      files.push_back(blink::mojom::FileChooserFileInfo::NewNativeFile(blink::mojom::NativeFileInfo::New(
          base::FilePath(*uri), name ? base::UTF8ToUTF16(*name) : std::u16string(),
          std::vector<std::u16string>())));
    }
  }
  if (files.empty()) {
    listener->FileSelectionCanceled();
    return;
  }
  const blink::mojom::FileChooserParams::Mode mode = files.size() > 1
                                                         ? blink::mojom::FileChooserParams::Mode::kOpenMultiple
                                                         : blink::mojom::FileChooserParams::Mode::kOpen;
  listener->FileSelected(std::move(files), base::FilePath(), mode);
}

int BayTab::RequestHttpAuth(const std::string& host, const std::string& realm, AuthCallback callback) {
  JNIEnv* env = base::android::AttachCurrentThread();
  ScopedJavaLocalRef<jobject> java_tab = GetJavaDelegate(env);
  if (java_tab.is_null()) {
    // Answered later, never from inside CreateLoginDelegate.
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(std::move(callback), std::optional<net::AuthCredentials>()));
    return 0;
  }
  const int id = next_request_id_++;
  pending_auth_[id] = std::move(callback);
  Java_BayTab_showHttpAuth(env, java_tab, id, ConvertUTF8ToJavaString(env, host),
                           ConvertUTF8ToJavaString(env, realm));
  return id;
}

void BayTab::AnswerHttpAuth(int request_id,
                            bool accepted,
                            const std::u16string& username,
                            const std::u16string& password) {
  auto it = pending_auth_.find(request_id);
  if (it == pending_auth_.end()) {
    return;
  }
  AuthCallback callback = std::move(it->second);
  pending_auth_.erase(it);
  if (accepted) {
    std::move(callback).Run(net::AuthCredentials(username, password));
  } else {
    std::move(callback).Run(std::nullopt);
  }
}

void BayTab::CancelHttpAuth(int request_id) {
  pending_auth_.erase(request_id);
}

void BayTab::OpenExternalUrl(const GURL& url, bool has_user_gesture) {
  JNIEnv* env = base::android::AttachCurrentThread();
  ScopedJavaLocalRef<jobject> java_tab = GetJavaDelegate(env);
  if (java_tab.is_null()) {
    return;
  }
  Java_BayTab_onExternalUrl(env, java_tab, ConvertUTF8ToJavaString(env, url.spec()), has_user_gesture);
}

void BayTab::PrimaryPageChanged(content::Page& page) {
  page_committed_ = true;
  // Answers belong to the page that asked.
  location_grants_.clear();
  CancelRequests(/*notify_java=*/true);
}

void BayTab::CancelRequests(bool notify_java) {
  auto permissions = std::move(pending_permissions_);
  pending_permissions_.clear();
  for (auto& [id, callback] : permissions) {
    std::move(callback).Run(false);
  }
  CancelDialogs(web_contents_.get(), false);
  auto choosers = std::move(pending_file_choosers_);
  pending_file_choosers_.clear();
  for (auto& [id, listener] : choosers) {
    listener->FileSelectionCanceled();
  }
  // A sign-in belongs to its request rather than the page: the network stack cancels it when the request goes. Only
  // a tab going away answers it here.
  if (!notify_java) {
    auto auth = std::move(pending_auth_);
    pending_auth_.clear();
    for (auto& [id, callback] : auth) {
      std::move(callback).Run(std::nullopt);
    }
  }
  if (!notify_java) {
    return;
  }
  JNIEnv* env = base::android::AttachCurrentThread();
  ScopedJavaLocalRef<jobject> java_tab = GetJavaDelegate(env);
  if (!java_tab.is_null()) {
    Java_BayTab_onRequestsCancelled(env, java_tab);
  }
}

// JNI ---------------------------------------------------------------------------------------------------------------

static int64_t JNI_BayTab_Create(JNIEnv* env, const JavaRef<jobject>& java_tab, int64_t profile_ptr) {
  return reinterpret_cast<intptr_t>(
      new BayTab(env, java_tab, reinterpret_cast<BayBrowserContext*>(profile_ptr)));
}

static ScopedJavaLocalRef<jobject> JNI_BayTab_GetWebContents(JNIEnv* env, int64_t tab_ptr) {
  return reinterpret_cast<BayTab*>(tab_ptr)->GetJavaWebContents();
}

static void JNI_BayTab_Destroy(JNIEnv* env, int64_t tab_ptr) {
  delete reinterpret_cast<BayTab*>(tab_ptr);
}

static bool JNI_BayTab_EvaluateInPageTools(JNIEnv* env, int64_t tab_ptr, const JavaRef<jstring>& script) {
  return reinterpret_cast<BayTab*>(tab_ptr)->EvaluateInPageTools(ConvertJavaStringToUTF16(env, script));
}

static void JNI_BayTab_AnswerPermission(JNIEnv* env, int64_t tab_ptr, int32_t request_id, bool granted) {
  reinterpret_cast<BayTab*>(tab_ptr)->AnswerPermission(request_id, granted);
}

static void JNI_BayTab_AnswerDialog(JNIEnv* env,
                                    int64_t tab_ptr,
                                    int32_t request_id,
                                    bool accepted,
                                    const JavaRef<jstring>& text) {
  reinterpret_cast<BayTab*>(tab_ptr)->AnswerDialog(request_id, accepted,
                                                   text.is_null() ? std::u16string()
                                                                  : ConvertJavaStringToUTF16(env, text));
}

static void JNI_BayTab_AnswerHttpAuth(JNIEnv* env,
                                      int64_t tab_ptr,
                                      int32_t request_id,
                                      bool accepted,
                                      const JavaRef<jstring>& username,
                                      const JavaRef<jstring>& password) {
  reinterpret_cast<BayTab*>(tab_ptr)->AnswerHttpAuth(
      request_id, accepted, username.is_null() ? std::u16string() : ConvertJavaStringToUTF16(env, username),
      password.is_null() ? std::u16string() : ConvertJavaStringToUTF16(env, password));
}

static void JNI_BayTab_AnswerFileChooser(JNIEnv* env,
                                         int64_t tab_ptr,
                                         int32_t request_id,
                                         const JavaRef<jstring>& files_json) {
  reinterpret_cast<BayTab*>(tab_ptr)->AnswerFileChooser(request_id, ConvertJavaStringToUTF8(env, files_json));
}

static ScopedJavaLocalRef<jstring> JNI_BayTab_SaveState(JNIEnv* env, int64_t tab_ptr) {
  const std::string state = reinterpret_cast<BayTab*>(tab_ptr)->SaveState();
  return state.empty() ? ScopedJavaLocalRef<jstring>() : ConvertUTF8ToJavaString(env, state);
}

static bool JNI_BayTab_RestoreState(JNIEnv* env, int64_t tab_ptr, const JavaRef<jstring>& state) {
  return reinterpret_cast<BayTab*>(tab_ptr)->RestoreState(ConvertJavaStringToUTF8(env, state));
}

static void JNI_BayTab_CaptureSnapshot(JNIEnv* env, int64_t tab_ptr, int32_t request_id, int32_t max_width) {
  reinterpret_cast<BayTab*>(tab_ptr)->CaptureSnapshot(request_id, max_width);
}

static void JNI_BayTab_SetDesktopMode(JNIEnv* env, int64_t tab_ptr, bool desktop) {
  reinterpret_cast<BayTab*>(tab_ptr)->set_desktop_mode(desktop);
}

static void JNI_BayTab_InitializeAutofill(JNIEnv* env, int64_t tab_ptr) {
  reinterpret_cast<BayTab*>(tab_ptr)->InitializeAutofill();
}

static void JNI_BayTab_Download(JNIEnv* env, int64_t tab_ptr, const JavaRef<jstring>& url) {
  reinterpret_cast<BayTab*>(tab_ptr)->Download(GURL(ConvertJavaStringToUTF8(env, url)));
}

}  // namespace bay

DEFINE_JNI(BayTab)
