// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_PAGE_MESSAGE_EVENTS_H_
#define CHROME_BROWSER_BAY_WEBUI_PAGE_MESSAGE_EVENTS_H_

#include <map>
#include <string>
#include <string_view>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"

namespace content {
class RenderFrameHost;
}
namespace bay {

// The document-start script runs in the page's world. Its data is untrusted:
// only messages from a live frame in this tab's primary page are accepted.
class PageMessageEvents final
    : public content::WebContentsObserver,
      public content::WebContentsUserData<PageMessageEvents> {
 public:
  using Sink = base::RepeatingCallback<bool(content::WebContents*, const char*,
                                           base::DictValue)>;
  using ReplaySink = base::RepeatingCallback<void(const char*, base::DictValue)>;
  using Response = base::OnceCallback<void(const std::string&)>;
  ~PageMessageEvents() override;
  static void Start(Sink sink);
  // Consumes tabs.pageMessage, including malformed ones. Call before engine
  // events are broadcast: raw selection and notification data stays tab-local.
  static bool HandleEngineEvent(std::string_view topic,
                                const base::DictValue& payload);
  static void Replay(content::WebContents* contents, ReplaySink sink);
  static base::DictValue MediaState(content::WebContents* contents);
  static bool Dispatch(content::WebContents* contents,
                       const std::string& command,
                       const base::ListValue& params,
                       Response& response);
  // Same validated entry point used by engine delivery, exposed to tests.
  static void Handle(content::WebContents* contents,
                     content::RenderFrameHost* frame,
                     const std::string& kind,
                     const base::Value& value);

 private:
  friend class content::WebContentsUserData<PageMessageEvents>;
  explicit PageMessageEvents(content::WebContents* contents);
  struct Notification {
    std::string frame;
    std::string page_id;
    base::DictValue payload;
  };
  static PageMessageEvents* Get(content::WebContents* contents);
  void Message(content::RenderFrameHost* frame,
               const std::string& kind, const base::Value& value);
  void Emit(const char* event, base::DictValue payload);
  void EmitNowPlaying();
  void EmitMedia();
  void Reset();
  void RemoveFrame(const std::string& frame);
  void PrimaryPageChanged(content::Page& page) override;
  void RenderFrameDeleted(content::RenderFrameHost* frame) override;
  void DidFinishNavigation(content::NavigationHandle* navigation) override;
  void PrimaryMainFrameRenderProcessGone(base::TerminationStatus status) override;
  void WebContentsDestroyed() override;
  std::map<std::string, Notification> notifications_;
  std::map<std::string, base::DictValue> now_playing_;
  std::map<std::string, bool> playing_;
  bool script_media_seen_ = false;
  std::string selected_frame_;
  base::WeakPtrFactory<PageMessageEvents> weak_factory_{this};
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_PAGE_MESSAGE_EVENTS_H_
