// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#ifndef BAY_MOBILE_BROWSER_BAY_TAB_H_
#define BAY_MOBILE_BROWSER_BAY_TAB_H_

#include <map>
#include <memory>
#include <set>
#include <string>

#include "base/android/scoped_java_ref.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "components/embedder_support/android/delegate/web_contents_delegate_android.h"
#include "content/public/browser/javascript_dialog_manager.h"
#include "content/public/browser/media_stream_request.h"
#include "content/public/browser/web_contents_observer.h"
#include "net/base/auth.h"
#include "url/gurl.h"
#include "url/origin.h"

class SkBitmap;

namespace content {
class FileSelectListener;
class WebContents;
}  // namespace content

namespace js_injection {
class JsCommunicationHost;
}  // namespace js_injection

namespace bay {

class BayBrowserContext;

// One page view: the WebContents behind a Java org.bay.engine.BayTab, and everything the page asks of the person
// (dialogs, permissions, files, new windows), which goes to Java and comes back as an answer with the same id. A
// request still open when its page goes away is answered as declined.
class BayTab : public web_contents_delegate_android::WebContentsDelegateAndroid,
               public content::WebContentsObserver,
               public content::JavaScriptDialogManager {
 public:
  // Values shared with BayTab.java.
  enum class PermissionKind { kLocation = 0, kCamera = 1, kMicrophone = 2, kCameraAndMicrophone = 3 };

  BayTab(JNIEnv* env, const base::android::JavaRef<jobject>& java_tab, BayBrowserContext* browser_context);
  BayTab(const BayTab&) = delete;
  BayTab& operator=(const BayTab&) = delete;
  ~BayTab() override;

  static BayTab* FromWebContents(content::WebContents* web_contents);

  // Called from Java.
  base::android::ScopedJavaLocalRef<jobject> GetJavaWebContents();
  bool EvaluateInPageTools(const std::u16string& script);
  void AnswerPermission(int request_id, bool granted);
  void AnswerDialog(int request_id, bool accepted, const std::u16string& text);
  void AnswerFileChooser(int request_id, const std::string& files_json);
  // The back/forward history with each page's state (scroll position, form text), as JSON, or "" with nothing to
  // keep. RestoreState puts one back before the tab's first load, and says whether it did.
  std::string SaveState();
  bool RestoreState(const std::string& state);
  // A picture of the page at most `max_width` pixels wide, to Java's onSnapshot with this id (null when there's none).
  void CaptureSnapshot(int request_id, int max_width);
  // Downloads `url` as the page would, with its cookies (BayDownloadManagerDelegate saves it).
  void Download(const GURL& url);

  // Location, asked by BayPermissionManager. An answer lasts for the current page.
  bool HasLocationGrant(const url::Origin& origin) const;
  void RequestLocationPermission(const url::Origin& origin, base::OnceCallback<void(bool)> callback);

  // A message a page tool posted from Bay's isolated world in the main frame.
  void OnPageToolsMessage(const std::u16string& message);

  // HTTP sign-in, asked by BayLoginDelegate. Returns the request's id; Cancel when the request goes away first.
  using AuthCallback = base::OnceCallback<void(const std::optional<net::AuthCredentials>&)>;
  int RequestHttpAuth(const std::string& host, const std::string& realm, AuthCallback callback);
  void AnswerHttpAuth(int request_id, bool accepted, const std::u16string& username, const std::u16string& password);
  void CancelHttpAuth(int request_id);

  // A link to another app (tel:, mailto:, intent:, an app's own scheme): Bay asks before leaving.
  void OpenExternalUrl(const GURL& url, bool has_user_gesture);

  base::WeakPtr<BayTab> GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

  // content::WebContentsDelegate (beyond what WebContentsDelegateAndroid forwards to Java):
  bool IsWebContentsCreationOverridden(content::RenderFrameHost* opener,
                                       content::SiteInstance* source_site_instance,
                                       content::mojom::WindowContainerType window_container_type,
                                       const GURL& opener_url,
                                       const std::string& frame_name,
                                       const GURL& target_url) override;
  content::JavaScriptDialogManager* GetJavaScriptDialogManager(content::WebContents* source) override;
  bool HandleContextMenu(content::RenderFrameHost& render_frame_host,
                         const content::ContextMenuParams& params) override;
  void RunFileChooser(content::RenderFrameHost* render_frame_host,
                      scoped_refptr<content::FileSelectListener> listener,
                      const blink::mojom::FileChooserParams& params) override;
  void RequestMediaAccessPermission(content::WebContents* web_contents,
                                    const content::MediaStreamRequest& request,
                                    content::MediaResponseCallback callback) override;
  bool CheckMediaAccessPermission(content::RenderFrameHost* render_frame_host,
                                  const url::Origin& security_origin,
                                  blink::mojom::MediaStreamType type) override;

  // content::WebContentsObserver:
  void PrimaryPageChanged(content::Page& page) override;

  // content::JavaScriptDialogManager:
  void RunJavaScriptDialog(content::WebContents* web_contents,
                           content::RenderFrameHost* render_frame_host,
                           content::JavaScriptDialogType dialog_type,
                           const std::u16string& message_text,
                           const std::u16string& default_prompt_text,
                           DialogClosedCallback callback,
                           bool* did_suppress_message) override;
  void RunBeforeUnloadDialog(content::WebContents* web_contents,
                             content::RenderFrameHost* render_frame_host,
                             bool is_reload,
                             DialogClosedCallback callback) override;
  void CancelDialogs(content::WebContents* web_contents, bool reset_state) override;

 private:
  int AskPermission(PermissionKind kind, const url::Origin& origin, base::OnceCallback<void(bool)> callback);
  void AnswerMediaRequest(const content::MediaStreamRequest& request,
                          content::MediaResponseCallback callback,
                          bool granted);
  void DeliverSnapshot(int request_id, const SkBitmap* bitmap);
  // Declines every open request: its page is gone. Java hears of it unless the tab itself is going.
  void CancelRequests(bool notify_java);

  std::unique_ptr<content::WebContents> web_contents_;
  std::unique_ptr<js_injection::JsCommunicationHost> js_communication_;
  bool page_committed_ = false;
  int next_request_id_ = 1;
  std::map<int, base::OnceCallback<void(bool)>> pending_permissions_;
  std::map<int, DialogClosedCallback> pending_dialogs_;
  std::map<int, scoped_refptr<content::FileSelectListener>> pending_file_choosers_;
  std::map<int, AuthCallback> pending_auth_;
  std::set<url::Origin> location_grants_;
  base::WeakPtrFactory<BayTab> weak_factory_{this};
};

}  // namespace bay

#endif  // BAY_MOBILE_BROWSER_BAY_TAB_H_
