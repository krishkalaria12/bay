// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/permission_prompts.h"

#include <map>
#include <memory>
#include <optional>
#include <variant>
#include <vector>

#include "base/functional/bind.h"
#include "base/location.h"
#include "base/memory/ptr_util.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "chrome/browser/file_system_access/file_system_access_permission_request_manager.h"
#include "chrome/browser/permissions/system/system_permission_settings.h"
#include "chrome/browser/ui/permission_bubble/permission_prompt.h"
#include "components/permissions/embedded_permission_prompt_flow_model.h"
#include "components/permissions/permission_prompt.h"
#include "components/permissions/permission_request.h"
#include "components/permissions/permission_uma_constants.h"
#include "components/permissions/permission_util.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "url/origin.h"

// Set here, defined in Chrome's restore bubble (engine/nncore/apply.sh).
extern bool (*g_bay_file_system_restore_prompt)(
    const FileSystemAccessPermissionRequestManager::RequestData& request,
    base::OnceCallback<void(permissions::PermissionAction)>& callback,
    content::WebContents* web_contents);

namespace bay {
namespace {

PermissionPrompts::Sink& EventSink() {
  static base::NoDestructor<PermissionPrompts::Sink> sink;
  return *sink;
}

void Tell(const char* event, base::DictValue payload) {
  if (EventSink())
    EventSink().Run(event, std::move(payload));
}

void TellDismissed(const std::string& id) {
  Tell("onPermissionDismissed", base::DictValue().Set("id", id));
}

base::DictValue RequestPayload(const std::string& id,
                               content::WebContents* contents,
                               const std::string& origin,
                               base::ListValue kinds) {
  return base::DictValue()
      .Set("id", id)
      .Set("browserId", sessions::SessionTabHelper::IdForTab(contents).id())
      .Set("origin", origin)
      .Set("permissions", std::move(kinds));
}

class Prompt;

std::map<std::string, base::WeakPtr<Prompt>>& Prompts() {
  static base::NoDestructor<std::map<std::string, base::WeakPtr<Prompt>>>
      prompts;
  return *prompts;
}

using Variant = permissions::EmbeddedPermissionPromptFlowModel::Variant;

// What a prompt asks for. A page's permission element runs Chrome's embedded
// flow: after the site is allowed, the manager keeps the same requests and shows
// the next step. Only the flow's first view can be a question: a later one holds
// requests already decided, and deciding one twice runs its spent callback.
enum class Step { kAsk, kAlreadyAllowed, kSystemPrompt, kAcknowledge };

Step StepOf(permissions::PermissionPrompt::Delegate* delegate) {
  permissions::EmbeddedPermissionPromptFlowModel* flow =
      delegate->GetEmbeddedPromptFlowModel();
  if (!flow)
    return Step::kAsk;
  // The manager marks its requests displayed once their first view is up; a
  // view made for the same requests after that is a later step.
  const bool later_step = delegate->WasCurrentRequestAlreadyDisplayed();
  switch (flow->prompt_variant()) {
    case Variant::kOsPrompt:
      return Step::kSystemPrompt;
    case Variant::kAsk:
    case Variant::kPreviouslyDenied:
      return later_step ? Step::kAcknowledge : Step::kAsk;
    case Variant::kPreviouslyGranted:
      return later_step ? Step::kAcknowledge : Step::kAlreadyAllowed;
    case Variant::kOsSystemSettings:
    case Variant::kAdministratorGranted:
    case Variant::kAdministratorDenied:
    case Variant::kUninitialized:
      return Step::kAcknowledge;
  }
  return Step::kAcknowledge;
}

// One request group Chrome's PermissionRequestManager is asking about. The
// manager owns it: it goes when the app answers, the page navigates or closes,
// or a request outranks it. A camera and microphone group is one prompt.
class Prompt : public permissions::PermissionPrompt {
 public:
  Prompt(content::WebContents* contents, Delegate* delegate)
      : delegate_(delegate), step_(StepOf(delegate)) {
    static int last_id = 0;
    id_ = "p" + base::NumberToString(++last_id);
    Prompts()[id_] = weak_factory_.GetWeakPtr();
    // Never from inside Chrome's ShowPrompt: an answer re-enters the manager.
    switch (step_) {
      case Step::kAsk:
      case Step::kAlreadyAllowed:
        Ask(contents);
        break;
      case Step::kSystemPrompt:
        PostToSelf(&Prompt::AskSystem);
        break;
      case Step::kAcknowledge:
        // Chrome's view only informs; closing it dismisses.
        PostToSelf(&Prompt::Acknowledge);
        break;
    }
  }

  ~Prompt() override {
    Prompts().erase(id_);
    // Answered too: every window was told, and only one answered. Not from
    // inside the manager's cleanup: the app may close the tab in response.
    if (asked_) {
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(&TellDismissed, id_));
    }
  }

  // The app's answer: taken once, applied from a task of its own.
  void Resolve(const std::string& result, bool remember) {
    if (!asked_ || answered_)
      return;
    answered_ = true;
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&Prompt::Apply, weak_factory_.GetWeakPtr(),
                                  result, remember));
  }

  // permissions::PermissionPrompt:
  bool UpdateAnchor() override { return true; }
  TabSwitchingBehavior GetTabSwitchingBehavior() override {
    return TabSwitchingBehavior::kKeepPromptAlive;
  }
  permissions::PermissionPromptDisposition GetPromptDisposition()
      const override {
    return permissions::PermissionPromptDisposition::CUSTOM_MODAL_DIALOG;
  }
  bool IsAskPrompt() const override { return step_ == Step::kAsk; }
  std::optional<gfx::Rect> GetViewBoundsInScreen() const override {
    return std::nullopt;
  }
  std::vector<permissions::ElementAnchoredBubbleVariant> GetPromptVariants()
      const override {
    return {};
  }
  std::optional<permissions::feature_params::PermissionElementPromptPosition>
  GetPromptPosition() const override {
    return std::nullopt;
  }

 private:
  void Ask(content::WebContents* contents) {
    asked_ = true;
    base::ListValue kinds;
    for (const auto& request : delegate_->Requests()) {
      if (const char* kind =
              PermissionPrompts::KindName(request->request_type())) {
        if (!kinds.contains(kind))
          kinds.Append(kind);
      }
    }
    auto payload = RequestPayload(
        id_, contents, delegate_->GetRequestingOrigin().spec(),
        std::move(kinds));
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(
                       [](base::WeakPtr<Prompt> prompt,
                          base::DictValue payload) {
                         if (prompt)
                           Tell("onPermission", std::move(payload));
                       },
                       weak_factory_.GetWeakPtr(), std::move(payload)));
  }

  void PostToSelf(void (Prompt::*step)()) {
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(step, weak_factory_.GetWeakPtr()));
  }

  // Still the manager's prompt: a stale task is a no-op.
  bool Current() const { return delegate_->GetCurrentPrompt() == this; }

  void Apply(const std::string& result, bool remember) {
    if (!Current())
      return;
    // The manager deletes this from inside the call: nothing after it.
    Delegate* delegate = delegate_;
    const PromptOptions options(std::monostate{});
    if (step_ == Step::kAlreadyAllowed) {
      // The element clicked on a site already allowed: "Continue allowing"
      // closes (the grant stays), "Stop allowing" blocks.
      if (result == "deny" && remember)
        delegate->Deny(options);
      else
        delegate->Dismiss(options);
      return;
    }
    if (result == "accept") {
      bool one_time = !remember;
      for (const auto& request : delegate->Requests()) {
        one_time &= permissions::PermissionUtil::DoesSupportTemporaryGrants(
            request->GetContentSettingsType());
      }
      if (one_time)
        delegate->AcceptThisTime(options);
      else
        delegate->Accept(options);
    } else if (result == "deny" && remember) {
      delegate->Deny(options);
    } else {
      // "dismiss", or a "deny" not to keep: refused, the site stays "ask".
      delegate->Dismiss(options);
    }
  }

  // The site is allowed and the system hasn't been asked: ask it, and move the
  // flow on once every type has an answer.
  void AskSystem() {
    if (!Current())
      return;
    std::vector<ContentSettingsType> types;
    for (const auto& request : delegate_->Requests())
      types.push_back(request->GetContentSettingsType());
    pending_system_answers_ = types.size();
    for (ContentSettingsType type : types) {
      system_permission_settings::Request(
          type, base::BindOnce(&Prompt::OnSystemAnswer,
                               weak_factory_.GetWeakPtr(), types));
    }
  }

  void OnSystemAnswer(std::vector<ContentSettingsType> types) {
    if (pending_system_answers_ == 0 || --pending_system_answers_ > 0 ||
        !Current()) {
      return;
    }
    for (ContentSettingsType type : types) {
      if (system_permission_settings::CanPrompt(type))
        return;
    }
    // The manager replaces or deletes this from inside the call.
    delegate_->AdvanceOrFinalizeEmbeddedPromptFlow();
  }

  void Acknowledge() {
    if (Current())
      delegate_->Dismiss(PromptOptions(std::monostate{}));
  }

  const raw_ptr<Delegate> delegate_;
  const Step step_;
  std::string id_;
  bool asked_ = false;
  bool answered_ = false;
  size_t pending_system_answers_ = 0;
  base::WeakPtrFactory<Prompt> weak_factory_{this};
};

std::unique_ptr<permissions::PermissionPrompt> CreatePrompt(
    content::WebContents* contents,
    permissions::PermissionPrompt::Delegate* delegate,
    bool* default_handling) {
  // A window Chrome made itself keeps Chrome's prompt.
  if (!WindowRegistry::Get().HoldsTab(contents)) {
    *default_handling = true;
    return nullptr;
  }
  *default_handling = false;
  return std::make_unique<Prompt>(contents, delegate);
}

using RestoreCallback = base::OnceCallback<void(permissions::PermissionAction)>;

// A site asking again for files it kept handles to: Chrome's restore prompt is
// a bubble anchored to a toolbar this window doesn't have, so it's asked as a
// "fileSystem" request. It answers once: the app, or the page going to another
// origin or the tab closing, which dismiss it as Chrome's bubble does.
class FileRestorePrompt : public content::WebContentsObserver {
 public:
  static std::map<std::string, std::unique_ptr<FileRestorePrompt>>& All() {
    static base::NoDestructor<
        std::map<std::string, std::unique_ptr<FileRestorePrompt>>>
        prompts;
    return *prompts;
  }

  static void Start(content::WebContents* contents,
                    const url::Origin& origin,
                    RestoreCallback callback) {
    static int last_id = 0;
    const std::string id = "r" + base::NumberToString(++last_id);
    All()[id] = base::WrapUnique(
        new FileRestorePrompt(contents, id, std::move(callback)));
    auto payload =
        RequestPayload(id, contents, origin.GetURL().spec(),
                       base::ListValue().Append("fileSystem"));
    // Never from inside Chrome's request manager: the answer re-enters it.
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(
                       [](std::string id, base::DictValue payload) {
                         auto it = All().find(id);
                         if (it != All().end() && it->second->web_contents())
                           Tell("onPermission", std::move(payload));
                       },
                       id, std::move(payload)));
  }

  // Its one "Allow" is Chrome's "Allow this time"; a remembered "deny" is
  // "Don't allow"; anything else dismisses.
  static bool Resolve(const std::string& id,
                      const std::string& result,
                      bool remember) {
    if (!All().contains(id))
      return false;
    permissions::PermissionAction action =
        permissions::PermissionAction::DISMISSED;
    if (result == "accept")
      action = permissions::PermissionAction::GRANTED_ONCE;
    else if (result == "deny" && remember)
      action = permissions::PermissionAction::DENIED;
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&FileRestorePrompt::Finish, id, action));
    return true;
  }

  // content::WebContentsObserver: as Chrome closes its bubble.
  void DidFinishNavigation(content::NavigationHandle* navigation) override {
    if (navigation->IsInPrimaryMainFrame() && navigation->HasCommitted() &&
        !url::IsSameOriginWith(navigation->GetPreviousPrimaryMainFrameURL(),
                               navigation->GetURL())) {
      Dismiss();
    }
  }
  void WebContentsDestroyed() override { Dismiss(); }

 private:
  FileRestorePrompt(content::WebContents* contents,
                    std::string id,
                    RestoreCallback callback)
      : content::WebContentsObserver(contents),
        id_(std::move(id)),
        callback_(std::move(callback)) {}

  void Dismiss() {
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(&FileRestorePrompt::Finish, id_,
                       permissions::PermissionAction::DISMISSED));
    Observe(nullptr);
  }

  // Once: a second answer finds nothing. Every window hears it has gone.
  static void Finish(std::string id, permissions::PermissionAction action) {
    auto it = All().find(id);
    if (it == All().end())
      return;
    RestoreCallback callback = std::move(it->second->callback_);
    All().erase(it);
    TellDismissed(id);
    // Chrome's request manager (bound weakly: a closed tab's runs nothing).
    std::move(callback).Run(action);
  }

  const std::string id_;
  RestoreCallback callback_;
};

bool AskToRestoreFiles(
    const FileSystemAccessPermissionRequestManager::RequestData& request,
    RestoreCallback& callback,
    content::WebContents* contents) {
  if (!WindowRegistry::Get().HoldsTab(contents))
    return false;
  FileRestorePrompt::Start(contents, request.origin, std::move(callback));
  return true;
}

}  // namespace

// static
const char* PermissionPrompts::KindName(permissions::RequestType type) {
  using permissions::RequestType;
  switch (type) {
    case RequestType::kCameraStream:
      return "camera";
    case RequestType::kMicStream:
      return "microphone";
    case RequestType::kCameraPanTiltZoom:
      return "cameraPanTiltZoom";
    case RequestType::kGeolocation:
      return "location";
    case RequestType::kNotifications:
      return "notifications";
    case RequestType::kClipboard:
      return "clipboard";
    case RequestType::kMidiSysex:
      return "midi";
    case RequestType::kMultipleDownloads:
      return "multipleDownloads";
    case RequestType::kLocalFonts:
      return "localFonts";
    case RequestType::kIdleDetection:
      return "idleDetection";
    case RequestType::kStorageAccess:
    case RequestType::kTopLevelStorageAccess:
      return "storageAccess";
    case RequestType::kWindowManagement:
      return "windowManagement";
    case RequestType::kFileSystemAccess:
      return "fileSystem";
    case RequestType::kKeyboardLock:
      return "keyboardLock";
    case RequestType::kPointerLock:
      return "pointerLock";
    case RequestType::kRegisterProtocolHandler:
      return "protocolHandler";
    case RequestType::kSensors:
      return "sensors";
    case RequestType::kLocalNetwork:
    case RequestType::kLoopbackNetwork:
      return "localNetwork";
    case RequestType::kVrSession:
      return "vr";
    case RequestType::kArSession:
      return "ar";
    case RequestType::kHandTracking:
      return "handTracking";
    case RequestType::kIdentityProvider:
      return "identityProvider";
    case RequestType::kWebAppInstallation:
      return "webAppInstallation";
    case RequestType::kCapturedSurfaceControl:
      return "capturedSurfaceControl";
    case RequestType::kDiskQuota:
      return "diskQuota";
    default:
      return nullptr;
  }
}

// static
void PermissionPrompts::Start(Sink sink) {
  EventSink() = std::move(sink);
  SetCreatePermissionPromptFunction(&CreatePrompt);
  g_bay_file_system_restore_prompt = &AskToRestoreFiles;
}

// static
void PermissionPrompts::Resolve(const std::string& request_id,
                                const std::string& result,
                                bool remember) {
  if (FileRestorePrompt::Resolve(request_id, result, remember))
    return;
  auto it = Prompts().find(request_id);
  if (it != Prompts().end() && it->second)
    it->second->Resolve(result, remember);
}

}  // namespace bay
