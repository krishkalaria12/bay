// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/display_media_picker.h"

#include <map>
#include <memory>
#include <utility>
#include <vector>

#include "base/barrier_closure.h"
#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "chrome/browser/bay/webui/host_context.h"
#include "chrome/browser/bay/webui/tab_broker.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "chrome/browser/media/webrtc/desktop_media_list.h"
#include "chrome/browser/media/webrtc/desktop_media_list_observer.h"
#include "chrome/browser/media/webrtc/desktop_media_picker.h"
#include "chrome/browser/media/webrtc/desktop_media_picker_factory_impl.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"

namespace bay {
namespace {
class Picker;
struct State {
  bool enabled = false;
  uint64_t last_id = 0;
  DisplayMediaPicker::Sink sink;
  std::map<std::string, base::WeakPtr<Picker>> pending;
};
State& GetState() {
  static base::NoDestructor<State> state;
  return *state;
}

// Source models keep themselves current after their initial enumeration.
class ListObserver : public DesktopMediaListObserver {
 public:
  void OnSourceAdded(int) override {}
  void OnSourceRemoved(int) override {}
  void OnSourceMoved(int, int) override {}
  void OnSourceNameChanged(int) override {}
  void OnSourceThumbnailChanged(int) override {}
  void OnSourcePreviewChanged(size_t) override {}
  void OnDelegatedSourceListSelection() override {}
  void OnDelegatedSourceListDismissed() override {}
};

class Picker : public ::DesktopMediaPicker,
               public content::WebContentsObserver {
 public:
  explicit Picker(const content::MediaStreamRequest& request)
      : fallback_(::DesktopMediaPicker::Create(&request)),
        origin_(request.url_origin.Serialize()) {}
  ~Picker() override {
    GetState().pending.erase(id_);
    // Chrome can dismiss a request itself, for example when its asking
    // subframe goes away. Retire the window's picker even without navigation.
    if (ready_ && done_ && web_contents() && GetState().sink)
      GetState().sink.Run(web_contents(), Dismissed());
  }

  void Show(const Params& params,
            std::vector<std::unique_ptr<DesktopMediaList>> lists,
            DoneCallback done) override {
    // PipeWire's delegated source list belongs to the desktop portal. Keep
    // Chrome's UI and lifecycle instead of opening a second picker over it.
    bool delegated = false;
    for (const auto& list : lists)
      delegated |= list->IsSourceListDelegated();
    if (delegated || lists.empty() ||
        params.request_source != Params::RequestSource::kGetDisplayMedia ||
        !params.web_contents || !TabBroker::Get().Tracks(params.web_contents)) {
      Fallback(params, std::move(lists), std::move(done));
      return;
    }
    params_ = params;
    Observe(params.web_contents);
    lists_ = std::move(lists);
    done_ = std::move(done);
    id_ = "display" + base::NumberToString(++GetState().last_id);
    GetState().pending.emplace(id_, weak_factory_.GetWeakPtr());
    auto ready = base::BarrierClosure(
        lists_.size(),
        base::BindOnce(&Picker::Ready, weak_factory_.GetWeakPtr()));
    // Update may finish synchronously. Defer Ready until this loop has ended.
    for (auto& list : lists_) {
      list->Update(base::BindOnce(
          [](base::RepeatingClosure ready) {
            base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
                FROM_HERE, std::move(ready));
          },
          ready));
    }
  }

  bool VisibleTo(const HostContext& context) const {
    if (!web_contents() || !context.window())
      return false;
    auto* browser = GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(
        web_contents());
    return browser &&
           WindowRegistry::Get().FrameOf(browser) == context.window();
  }

  base::ListValue Sources() const {
    base::ListValue sources;
    if (!ready_)
      return sources;
    for (const auto& list : lists_) {
      for (int i = 0; i < list->GetSourceCount(); ++i) {
        const auto& source = list->GetSource(i);
        const auto type = source.id.type;
        if (type != content::DesktopMediaID::TYPE_SCREEN &&
            type != content::DesktopMediaID::TYPE_WINDOW)
          continue;
        sources.Append(
            base::DictValue()
                .Set("id", source.id.ToString())
                .Set("kind", type == content::DesktopMediaID::TYPE_SCREEN
                                 ? "screen"
                                 : "window")
                .Set("name", base::UTF16ToUTF8(source.name))
                // Chrome's model does not expose pixel dimensions.
                .Set("width", 0)
                .Set("height", 0));
      }
    }
    return sources;
  }

  bool Resolve(content::WebContents* contents,
               const std::optional<std::string>& source_id) {
    if (contents != web_contents() || !done_ || (source_id && !ready_))
      return false;
    if (!source_id) {
      Cancel();
      return true;
    }
    // Never parse a renderer-supplied id into an unrestricted capture target.
    // The live model enforces enterprise policy, excluded surfaces and tabs.
    for (const auto& list : lists_) {
      for (int i = 0; i < list->GetSourceCount(); ++i) {
        auto id = list->GetSource(i).id;
        if (id.ToString() != *source_id)
          continue;
        // Bay has no system/window audio consent control. Tab audio matches
        // its existing picker and remains subject to Chrome's request policy.
        id.audio_share = params_.request_audio &&
                         id.type == content::DesktopMediaID::TYPE_WEB_CONTENTS;
        Finish(id);
        return true;
      }
    }
    // The UI has dismissed its request after answering. If a source vanished
    // since the last refresh, settle the site's promise instead of stranding
    // it.
    Cancel();
    return true;
  }

 private:
  void Fallback(const Params& params,
                std::vector<std::unique_ptr<DesktopMediaList>> lists,
                DoneCallback done) {
    if (fallback_)
      fallback_->Show(params, std::move(lists), std::move(done));
    else
      std::move(done).Run(base::unexpected(
          blink::mojom::MediaStreamRequestResult::NOT_SUPPORTED));
  }
  void Ready() {
    if (!done_ || !web_contents())
      return;
    ready_ = true;
    auto& sink = GetState().sink;
    const auto alive = weak_factory_.GetWeakPtr();
    const bool delivered =
        sink &&
        sink.Run(web_contents(), base::DictValue()
                                     .Set("id", id_)
                                     .Set("origin", origin_)
                                     .Set("audio", params_.request_audio)
                                     .Set("sources", Sources()));
    if (!alive)
      return;
    if (!delivered) {
      GetState().pending.erase(id_);
      ready_ = false;
      Observe(nullptr);
      Fallback(params_, std::move(lists_), std::move(done_));
      return;
    }
    for (auto& list : lists_)
      list->StartUpdating(&observer_);
  }
  base::DictValue Dismissed() const {
    return base::DictValue()
        .Set("id", id_)
        .Set("origin", origin_)
        .Set("audio", params_.request_audio)
        .Set("sources", base::ListValue())
        .Set("cancelled", true);
  }
  void Finish(DoneCallbackArgumentType result) {
    GetState().pending.erase(id_);
    ready_ = false;
    auto done = std::move(done_);
    auto* contents = web_contents();
    auto dismissed = Dismissed();
    Observe(nullptr);
    params_.web_contents = nullptr;
    lists_.clear();
    // Native cancellation also retires an overlay in a window that survives.
    if (!result.has_value() && contents && GetState().sink)
      GetState().sink.Run(contents, std::move(dismissed));
    // Chrome may destroy this picker in its callback.
    std::move(done).Run(std::move(result));
  }
  void Cancel() {
    if (done_)
      Finish(base::unexpected(
          blink::mojom::MediaStreamRequestResult::PERMISSION_DENIED));
  }
  void WebContentsDestroyed() override { Cancel(); }
  void DidStartNavigation(content::NavigationHandle* navigation) override {
    if (navigation->IsInPrimaryMainFrame() && !navigation->IsSameDocument())
      Cancel();
  }

  std::unique_ptr<::DesktopMediaPicker> fallback_;
  std::string origin_;
  Params params_;
  std::string id_;
  std::vector<std::unique_ptr<DesktopMediaList>> lists_;
  ListObserver observer_;
  DoneCallback done_;
  bool ready_ = false;
  base::WeakPtrFactory<Picker> weak_factory_{this};
};

std::unique_ptr<::DesktopMediaPicker> CreatePicker(
    const content::MediaStreamRequest* request) {
  if (!GetState().enabled || !request ||
      (request->video_type !=
           blink::mojom::MediaStreamType::DISPLAY_VIDEO_CAPTURE &&
       request->video_type !=
           blink::mojom::MediaStreamType::DISPLAY_VIDEO_CAPTURE_THIS_TAB))
    return nullptr;
  auto* frame = content::RenderFrameHost::FromID(request->render_process_id,
                                                 request->render_frame_id);
  auto* contents =
      frame ? content::WebContents::FromRenderFrameHost(frame) : nullptr;
  if (!contents || !TabBroker::Get().Tracks(contents))
    return nullptr;
  return std::make_unique<Picker>(*request);
}
}  // namespace

void DisplayMediaPicker::Start(Sink sink) {
  GetState().sink = std::move(sink);
  DesktopMediaPickerFactoryImpl::SetBayPickerFactory(&CreatePicker);
}
void DisplayMediaPicker::SetEnabled(bool enabled) {
  GetState().enabled = enabled;
  if (!enabled) {
    // Resolve from a copy, since the completion may destroy its picker.
    const auto pending = GetState().pending;
    for (const auto& [id, picker] : pending) {
      if (picker)
        picker->Resolve(picker->web_contents(), std::nullopt);
    }
  }
}
base::ListValue DisplayMediaPicker::Sources(const HostContext& context) {
  base::ListValue sources;
  for (const auto& [id, picker] : GetState().pending) {
    if (!picker || !picker->VisibleTo(context))
      continue;
    for (auto& source : picker->Sources()) {
      bool duplicate = false;
      for (const auto& existing : sources)
        duplicate |= existing.GetDict().FindString("id") &&
                     *existing.GetDict().FindString("id") ==
                         *source.GetDict().FindString("id");
      if (!duplicate)
        sources.Append(std::move(source));
    }
  }
  return sources;
}
bool DisplayMediaPicker::Resolve(content::WebContents* contents,
                                 const std::string& request_id,
                                 const std::optional<std::string>& source_id) {
  const auto found = GetState().pending.find(request_id);
  return found != GetState().pending.end() && found->second &&
         found->second->Resolve(contents, source_id);
}
void DisplayMediaPicker::CancelForContents(content::WebContents* contents) {
  const auto pending = GetState().pending;
  for (const auto& [id, picker] : pending) {
    if (picker)
      picker->Resolve(contents, std::nullopt);
  }
}
std::string DisplayMediaPicker::CaptureId(content::WebContents* contents) {
  if (!contents || !contents->GetPrimaryMainFrame())
    return "";
  const auto frame = contents->GetPrimaryMainFrame()->GetGlobalId();
  return content::DesktopMediaID(
             content::DesktopMediaID::TYPE_WEB_CONTENTS,
             content::DesktopMediaID::kNullId,
             content::WebContentsMediaCaptureId(frame.child_id.value(),
                                                frame.frame_routing_id))
      .ToString();
}
}  // namespace bay
