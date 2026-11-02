#include "bay/core/renderer/nn_content_renderer_client.h"

#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/task/single_thread_task_runner.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "content/public/common/isolated_world_ids.h"
#include "content/public/renderer/render_frame.h"
#include "content/public/renderer/render_frame_observer.h"
#include "content/public/renderer/render_thread.h"
#include "content/public/renderer/render_thread_observer.h"
#include "gin/arguments.h"
#include "gin/converter.h"
#include "gin/function_template.h"
#include "mojo/public/cpp/bindings/associated_receiver.h"
#include "mojo/public/cpp/bindings/associated_receiver_set.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "bay/core/mojom/nncore.mojom.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_provider.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_registry.h"
#include "third_party/blink/public/platform/scheduler/web_agent_group_scheduler.h"
#include "third_party/blink/public/platform/task_type.h"
#include "third_party/blink/public/platform/web_isolated_world_info.h"
#include "third_party/blink/public/platform/web_string.h"
#include "third_party/blink/public/platform/web_url.h"
#include "third_party/blink/public/web/web_css_origin.h"
#include "third_party/blink/public/web/web_document.h"
#include "third_party/blink/public/web/web_element.h"
#include "third_party/blink/public/web/web_local_frame.h"
#include "third_party/blink/public/web/web_script_source.h"
#include "third_party/blink/public/mojom/frame/user_activation_notification_type.mojom.h"
#include "url/gurl.h"
#include "v8/include/v8-context.h"
#include "v8/include/v8-function.h"
#include "v8/include/v8-isolate.h"
#include "v8/include/v8-local-handle.h"
#include "v8/include/v8-persistent-handle.h"
#include "v8/include/v8-primitive.h"

namespace nncore {

namespace {

// The page script this process runs; set by the browser before any frame exists here.
std::string& PageScript() {
  static base::NoDestructor<std::string> script;
  return *script;
}

blink::WebScriptSource Source(const std::string& code, const char* url) {
  return blink::WebScriptSource(blink::WebString::FromUtf8(code),
                                blink::WebURL(GURL(url)));
}

// Boosts (mojom::NNBoost): every one that's on, from the browser; empty until it sends them.
std::vector<mojom::NNBoostPtr>& Boosts() {
  static base::NoDestructor<std::vector<mojom::NNBoostPtr>> boosts;
  return *boosts;
}

// The isolated world Boosts' JavaScript runs in: its own (the page's scripts can't see its
// variables, nor it theirs), far above the IDs extensions take from
// ISOLATED_WORLD_ID_EXTENSIONS upwards and below Blink's embedder limit (1 << 29).
constexpr int32_t kBoostWorldId = (1 << 28) + 1;

// As TypeScript's boostHost: lowercase, without a trailing dot or leading "www.".
std::string BoostHost(const GURL& url) {
  if (!url.SchemeIsHTTPOrHTTPS()) {
    return std::string();
  }
  std::string host = base::ToLowerASCII(url.host());
  if (base::EndsWith(host, ".")) {
    host.pop_back();
  }
  if (base::StartsWith(host, "www.")) {
    host = host.substr(4);
  }
  return host;
}

// The Boosts on for a document's site, in the order the app listed them (later ones win in
// the cascade).
std::vector<const mojom::NNBoost*> BoostsFor(const GURL& url) {
  std::vector<const mojom::NNBoost*> found;
  const std::string host = BoostHost(url);
  if (host.empty()) {
    return found;
  }
  for (const mojom::NNBoostPtr& boost : Boosts()) {
    if (boost->host == host) {
      found.push_back(boost.get());
    }
  }
  return found;
}

// Each independently parsed sheet has its own removal key. Custom CSS in one Boost may
// end in an unfinished block or comment without consuming the next Boost's source.
struct BoostSheet {
  blink::WebStyleSheetKey key;
  blink::WebCssOrigin origin;
  blink::WebStyleSheetInsertionOrder order;
};

class NNPageObserver;
// Every frame's observer, for Boosts that change while their pages show.
std::set<NNPageObserver*>& Observers() {
  static base::NoDestructor<std::set<NNPageObserver*>> observers;
  return *observers;
}

// One frame: runs the page script in its main world at document start, keeps the script's
// receive function, and carries messages both ways.
class NNPageObserver : public content::RenderFrameObserver,
                       public mojom::NNPage {
 public:
  explicit NNPageObserver(content::RenderFrame* frame)
      : content::RenderFrameObserver(frame) {
    frame->GetAssociatedInterfaceRegistry()->AddInterface<mojom::NNPage>(
        base::BindRepeating(&NNPageObserver::BindPage,
                            weak_factory_.GetWeakPtr()));
    Observers().insert(this);
  }

  ~NNPageObserver() override {
    Observers().erase(this);
    AnswerAll();
  }

  // content::RenderFrameObserver:
  void OnDestruct() override { delete this; }

  // Document start: the Boost's sheets go in before the page's first paint (as an extension's
  // content-script CSS), so a zapped element is never seen.
  void DidCreateDocumentElement() override { ApplyBoost(); }

  // The Boost's JavaScript, once per document, when its DOM is in (an extension content
  // script's document_end). Script can't run inside this notification (Blink forbids it
  // there): it runs in a task right after, if the frame still shows the same document.
  void DidDispatchDOMContentLoadedEvent() override {
    if (!render_frame()->IsMainFrame()) {
      return;
    }
    blink::WebDocument document = render_frame()->GetWebFrame()->GetDocument();
    render_frame()
        ->GetTaskRunner(blink::TaskType::kInternalDefault)
        ->PostTask(FROM_HERE, base::BindOnce(&NNPageObserver::RunBoostScripts,
                                             weak_factory_.GetWeakPtr(),
                                             document));
  }

  void RunBoostScripts(blink::WebDocument document) {
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    if (frame->GetDocument() != document) {
      return;
    }
    base::WeakPtr<NNPageObserver> alive = weak_factory_.GetWeakPtr();
    bool named = false;
    for (const mojom::NNBoost* boost : BoostsFor(GURL(document.Url()))) {
      if (boost->script.empty()) {
        continue;
      }
      if (!named) {
        // No origin or CSP of its own: it acts as the page's origin and keeps to the
        // page's CSP; the name is what DevTools' context picker shows.
        blink::WebIsolatedWorldInfo info;
        info.human_readable_name = blink::WebString::FromUtf8("Bay Boost");
        blink::SetIsolatedWorldInfo(kBoostWorldId, info);
        named = true;
      }
      const std::string url = "bay://boost/" + boost->host + ".js";
      // A copy: the script can remove the frame, and this observer with it.
      const std::string script = boost->script;
      frame->ExecuteScriptInIsolatedWorld(kBoostWorldId,
                                          Source(script, url.c_str()),
                                          blink::BackForwardCacheAware::kAllow);
      if (!alive || frame->GetDocument() != document) {
        return;
      }
    }
  }

  // The main frame's Boost sheets for the document it shows: the old ones out, the current
  // ones in (none when the document's site has no Boost on).
  void ApplyBoost() {
    if (!render_frame()->IsMainFrame()) {
      return;
    }
    blink::WebDocument document = render_frame()->GetWebFrame()->GetDocument();
    if (document.IsNull() || document.DocumentElement().IsNull()) {
      return;
    }
    for (const BoostSheet& sheet : boost_sheets_) {
      document.RemoveInsertedStyleSheet(sheet.key, sheet.origin, sheet.order);
    }
    boost_sheets_.clear();
    const std::vector<const mojom::NNBoost*> boosts =
        BoostsFor(GURL(document.Url()));
    if (boosts.empty()) {
      return;
    }
    AddBoostSheet(document, boost_palette_, blink::WebCssOrigin::kUser);
    const auto style = boost_site_styles_.find(BoostHost(GURL(document.Url())));
    if (style != boost_site_styles_.end()) {
      AddBoostSheet(document, style->second, blink::WebCssOrigin::kUser);
    }
    for (const mojom::NNBoost* boost : boosts) {
      AddBoostSheet(document, boost->user_css, blink::WebCssOrigin::kUser);
      AddBoostSheet(document, boost->css, blink::WebCssOrigin::kAuthor,
                    blink::WebStyleSheetInsertionOrder::kAfterDocument);
    }
  }

  void AddBoostSheet(blink::WebDocument document,
                     const std::string& css,
                     blink::WebCssOrigin origin,
                     blink::WebStyleSheetInsertionOrder order =
                         blink::WebStyleSheetInsertionOrder::kBeforeDocument) {
    if (css.empty()) {
      return;
    }
    boost_sheets_.push_back(
        {document.InsertStyleSheet(blink::WebString::FromUtf8(css), nullptr,
                                   origin, blink::BackForwardCacheAware::kAllow,
                                   order),
         origin, order});
  }

  void DidCreateScriptContext(v8::Local<v8::Context> context,
                              int32_t world_id) override {
    if (world_id != content::ISOLATED_WORLD_ID_GLOBAL || PageScript().empty()) {
      return;
    }
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
    v8::HandleScope handle_scope(isolate);
    v8::Context::Scope context_scope(context);
    receive_.Reset();
    // Script can remove this frame (and this observer) synchronously, e.g. a same-origin
    // parent removing the iframe: check after every call into it.
    base::WeakPtr<NNPageObserver> alive = weak_factory_.GetWeakPtr();
    // Before the page's own scripts: the document's first script context.
    v8::Local<v8::Value> install = frame->ExecuteScriptAndReturnValue(
        Source(PageScript(), "bay://page-script"));
    if (!alive || install.IsEmpty() || !install->IsFunction()) {
      return;
    }
    v8::Local<v8::Value> post = PostFunction(isolate, context, std::nullopt);
    v8::Local<v8::Value> receive;
    const bool ran = frame
                         ->CallFunctionEvenIfScriptDisabled(
                             install.As<v8::Function>(), v8::Undefined(isolate),
                             1, &post)
                         .ToLocal(&receive);
    if (!alive || !ran || !receive->IsFunction() ||
        frame->MainWorldScriptContext() != context) {
      return;
    }
    receive_.Reset(isolate, receive.As<v8::Function>());
    receive_context_.Reset(isolate, context);
  }

  void SetBoostStyle(const std::string& descriptor) override {
    if (boost_style_descriptor_ == descriptor) {
      return;
    }
    boost_style_descriptor_ = descriptor;
    boost_palette_.clear();
    boost_site_styles_.clear();
    // Serialized EngineBoostStyle: a space palette plus every host's winning tint.
    // Choose the host in ApplyBoost, including before the app hears of a navigation.
    if (auto style =
            base::JSONReader::ReadDict(descriptor, base::JSON_PARSE_RFC)) {
      if (const std::string* palette = style->FindString("palette")) {
        boost_palette_ = *palette;
      }
      if (const base::DictValue* sites = style->FindDict("sites")) {
        for (const auto item : *sites) {
          if (item.second.is_string()) {
            boost_site_styles_.emplace(item.first, item.second.GetString());
          }
        }
      }
    }
    ApplyBoost();
  }

  void WillReleaseScriptContext(v8::Local<v8::Context> context,
                                int32_t world_id) override {
    if (world_id != content::ISOLATED_WORLD_ID_GLOBAL) {
      return;
    }
    receive_.Reset();
    receive_context_.Reset();
    // A new document's evaluations start over; the old ones get no answer.
    AnswerAll();
  }

  // mojom::NNPage:
  void CallPage(const std::string& kind, const std::string& json) override {
    if (receive_.IsEmpty()) {
      return;
    }
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
    v8::HandleScope handle_scope(isolate);
    v8::Local<v8::Context> context = receive_context_.Get(isolate);
    v8::Context::Scope context_scope(context);
    v8::Local<v8::Value> args[] = {gin::StringToV8(isolate, kind),
                                   gin::StringToV8(isolate, json)};
    std::ignore = frame->CallFunctionEvenIfScriptDisabled(
        receive_.Get(isolate), v8::Undefined(isolate), 2, args);
  }

  void Execute(const std::string& code, bool user_gesture) override {
    if (user_gesture) {
      NotifyUserActivation();
    }
    render_frame()->GetWebFrame()->ExecuteScript(
        Source(code, "bay://execute"));
  }

  void Evaluate(const std::string& code,
                bool user_gesture,
                EvaluateCallback callback) override {
    if (user_gesture) {
      NotifyUserActivation();
    }
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
    v8::HandleScope handle_scope(isolate);
    v8::Local<v8::Context> context = frame->MainWorldScriptContext();
    if (context.IsEmpty()) {
      std::move(callback).Run(std::nullopt);
      return;
    }
    v8::Context::Scope context_scope(context);
    // Strict, so a page function it calls can't walk up to it (`arguments.callee.caller`
    // is null for a strict caller) and take `post` to answer for it.
    v8::Local<v8::Value> fn = frame->ExecuteScriptAndReturnValue(
        Source("(function(post){'use strict';\n" + code + "\n})",
               "bay://evaluate"));
    if (fn.IsEmpty() || !fn->IsFunction()) {
      std::move(callback).Run(std::nullopt);
      return;
    }
    const int id = ++last_evaluation_;
    evaluations_[id] = std::move(callback);
    v8::Local<v8::Value> post = PostFunction(isolate, context, id);
    v8::Local<v8::Value> result;
    base::WeakPtr<NNPageObserver> alive = weak_factory_.GetWeakPtr();
    const bool ran = frame
                         ->CallFunctionEvenIfScriptDisabled(
                             fn.As<v8::Function>(), v8::Undefined(isolate), 1,
                             &post)
                         .ToLocal(&result);
    if (alive && !ran) {
      // It threw (an answer posted before the throw still counts).
      Answer(id, std::nullopt);
    }
  }

 private:
  // As CEF's EvaluateWithGesture: a transient activation, as a click would give.
  void NotifyUserActivation() {
    render_frame()->GetWebFrame()->NotifyUserActivation(
        blink::mojom::UserActivationNotificationType::kInteraction);
  }

  void BindPage(mojo::PendingAssociatedReceiver<mojom::NNPage> receiver) {
    page_receivers_.Add(this, std::move(receiver));
  }

  v8::Local<v8::Value> PostFunction(v8::Isolate* isolate,
                                    v8::Local<v8::Context> context,
                                    std::optional<int> evaluation) {
    return gin::CreateFunctionTemplate(
               isolate, base::BindRepeating(&NNPageObserver::Post,
                                            weak_factory_.GetWeakPtr(),
                                            evaluation))
        ->GetFunction(context)
        .ToLocalChecked();
  }

  // post(kind, json): json is a string the script serialized ("null" otherwise).
  void Post(std::optional<int> evaluation, gin::Arguments* args) {
    std::string kind;
    if (!args->GetNext(&kind)) {
      return;
    }
    std::string json = "null";
    v8::Local<v8::Value> value;
    if (args->GetNext(&value) && value->IsString()) {
      json = gin::V8ToString(args->isolate(), value);
    }
    if (evaluation && kind == "result") {
      Answer(*evaluation, std::move(json));
      return;
    }
    if (!host_.is_bound()) {
      render_frame()->GetRemoteAssociatedInterfaces()->GetInterface(&host_);
    }
    host_->Post(kind, json);
  }

  void Answer(int id, std::optional<std::string> json) {
    auto it = evaluations_.find(id);
    if (it == evaluations_.end()) {
      return;
    }
    EvaluateCallback callback = std::move(it->second);
    evaluations_.erase(it);
    std::move(callback).Run(std::move(json));
  }

  // Mojo wants every response callback run, even with no answer.
  void AnswerAll() {
    std::map<int, EvaluateCallback> pending = std::move(evaluations_);
    evaluations_.clear();
    for (auto& [id, callback] : pending) {
      std::move(callback).Run(std::nullopt);
    }
  }

  mojo::AssociatedReceiverSet<mojom::NNPage> page_receivers_;
  mojo::AssociatedRemote<mojom::NNPageHost> host_;
  v8::Global<v8::Function> receive_;
  v8::Global<v8::Context> receive_context_;
  std::map<int, EvaluateCallback> evaluations_;
  int last_evaluation_ = 0;
  // Cached serialized EngineBoostStyle and its parsed palette / host tints. The browser
  // sends it before commit; a new document selects its own host without a JS round trip.
  std::string boost_style_descriptor_;
  std::string boost_palette_;
  std::map<std::string, std::string> boost_site_styles_;
  std::vector<BoostSheet> boost_sheets_;
  base::WeakPtrFactory<NNPageObserver> weak_factory_{this};
};

}  // namespace

// The process's NNRendererConfig: the browser sends the page script on the IPC channel
// right after launch, ahead of any frame creation.
class NNRenderThreadObserver : public content::RenderThreadObserver,
                               public mojom::NNRendererConfig {
 public:
  // content::RenderThreadObserver:
  void RegisterMojoInterfaces(
      blink::AssociatedInterfaceRegistry* associated_interfaces) override {
    associated_interfaces->AddInterface<mojom::NNRendererConfig>(
        base::BindRepeating(&NNRenderThreadObserver::Bind,
                            base::Unretained(this)));
  }
  void UnregisterMojoInterfaces(
      blink::AssociatedInterfaceRegistry* associated_interfaces) override {
    associated_interfaces->RemoveInterface(mojom::NNRendererConfig::Name_);
  }

  // mojom::NNRendererConfig:
  void SetPageScript(const std::string& script) override {
    PageScript() = script;
  }

  void SetBoosts(std::vector<mojom::NNBoostPtr> boosts) override {
    Boosts() = std::move(boosts);
    // A copy: restyling runs no script, but stay safe if a frame goes meanwhile.
    const std::vector<NNPageObserver*> observers(Observers().begin(),
                                                 Observers().end());
    for (NNPageObserver* observer : observers) {
      if (Observers().contains(observer)) {
        observer->ApplyBoost();
      }
    }
  }

 private:
  void Bind(mojo::PendingAssociatedReceiver<mojom::NNRendererConfig> receiver) {
    receivers_.Add(this, std::move(receiver));
  }

  mojo::AssociatedReceiverSet<mojom::NNRendererConfig> receivers_;
};

NNContentRendererClient::NNContentRendererClient() = default;
NNContentRendererClient::~NNContentRendererClient() = default;

void NNContentRendererClient::RenderThreadStarted() {
  ChromeContentRendererClient::RenderThreadStarted();
  observer_ = std::make_unique<NNRenderThreadObserver>();
  content::RenderThread::Get()->AddObserver(observer_.get());
}

void NNContentRendererClient::RenderFrameCreated(
    content::RenderFrame* render_frame) {
  ChromeContentRendererClient::RenderFrameCreated(render_frame);
  new NNPageObserver(render_frame);  // Owns itself (OnDestruct).
}

}  // namespace nncore
