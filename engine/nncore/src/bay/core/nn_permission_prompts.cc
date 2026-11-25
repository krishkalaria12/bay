// Copyright 2026 Bay. Apache-2.0.
#include "bay/core/nn_permission_prompts.h"

#include <map>
#include <memory>
#include <optional>
#include <utility>
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
#include "bay/core/nn_permission_flow.h"
#include "chrome/browser/file_system_access/file_system_access_permission_request_manager.h"
#include "chrome/browser/permissions/system/system_permission_settings.h"
#include "chrome/browser/ui/permission_bubble/permission_prompt.h"
#include "components/permissions/embedded_permission_prompt_flow_model.h"
#include "components/permissions/permission_prompt.h"
#include "components/permissions/permission_request.h"
#include "components/permissions/permission_uma_constants.h"
#include "components/permissions/permission_util.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "url/origin.h"

// Set here, defined in Chrome's restore bubble (engine/nncore/apply.sh).
extern bool (*g_bay_file_system_restore_prompt)(
    const FileSystemAccessPermissionRequestManager::RequestData& request,
    base::OnceCallback<void(permissions::PermissionAction)>& callback,
    content::WebContents* web_contents);

namespace nncore::permission_prompts {

Host::Host() = default;
Host::Host(Host&&) = default;
Host& Host::operator=(Host&&) = default;
Host::~Host() = default;

namespace {

Host& TheHost() {
  static base::NoDestructor<Host> host;
  return *host;
}

bool Holds(content::WebContents* contents) {
  return contents && TheHost().holds && TheHost().holds.Run(contents);
}

void Ask(content::WebContents* contents, base::DictValue request) {
  if (TheHost().ask) {
    TheHost().ask.Run(contents, std::move(request));
  }
}

void Gone(const std::string& id, bool answered) {
  if (TheHost().gone) {
    TheHost().gone.Run(id, answered);
  }
}

base::DictValue Request(const std::string& id,
                        const std::string& origin,
                        base::ListValue kinds) {
  return base::DictValue()
      .Set("id", id)
      .Set("origin", origin)
      .Set("permissions", std::move(kinds));
}

class Prompt;

std::map<std::string, base::WeakPtr<Prompt>>& Prompts() {
  static base::NoDestructor<std::map<std::string, base::WeakPtr<Prompt>>>
      prompts;
  return *prompts;
}

using Step = PermissionStep;

// One request group Chrome's PermissionRequestManager is asking about. The
// manager owns it: it goes when the app answers, the page navigates or closes,
// or a request outranks it. A camera and microphone group is one prompt, one
// answer.
class Prompt : public permissions::PermissionPrompt {
 public:
  Prompt(content::WebContents* contents, Delegate* delegate)
      : delegate_(delegate), step_(PermissionStepOf(delegate)) {
    static int last_id = 0;
    id_ = "p" + base::NumberToString(++last_id);
    Prompts()[id_] = weak_factory_.GetWeakPtr();
    // Never from inside Chrome's ShowPrompt: an answer re-enters the manager.
    switch (step_) {
      case Step::kAsk:
      case Step::kAlreadyAllowed:
        AskApp(contents);
        break;
      case Step::kSystemPrompt:
        PostToSelf(&Prompt::AskSystem);
        break;
      case Step::kAcknowledge:
        // Chrome's view only informs (the system's settings, a policy);
        // closing it dismisses.
        PostToSelf(&Prompt::Acknowledge);
        break;
    }
  }

  ~Prompt() override {
    Prompts().erase(id_);
    if (asked_) {
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(&Gone, id_, answered_));
    }
  }

  void Resolve(const std::string& result, bool remember) {
    if (!asked_ || answered_) {
      return;
    }
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
  void AskApp(content::WebContents* contents) {
    asked_ = true;
    base::ListValue kinds;
    for (const auto& request : delegate_->Requests()) {
      if (const char* kind = PermissionKindName(request->request_type())) {
        if (!kinds.contains(kind)) {
          kinds.Append(kind);
        }
      }
    }
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(
            [](base::WeakPtr<Prompt> prompt,
               base::WeakPtr<content::WebContents> contents,
               base::DictValue request) {
              if (prompt && contents) {
                Ask(contents.get(), std::move(request));
              }
            },
            weak_factory_.GetWeakPtr(), contents->GetWeakPtr(),
            Request(id_, delegate_->GetRequestingOrigin().spec(),
                    std::move(kinds))));
  }

  void PostToSelf(void (Prompt::*step)()) {
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(step, weak_factory_.GetWeakPtr()));
  }

  // Still the manager's prompt: a stale task (the prompt replaced in the
  // meantime) is a no-op.
  bool Current() const { return delegate_->GetCurrentPrompt() == this; }

  void Apply(const std::string& result, bool remember) {
    if (!Current()) {
      return;
    }
    // The manager deletes this from inside the call: nothing after it.
    Delegate* delegate = delegate_;
    const PromptOptions options(std::monostate{});
    if (step_ == Step::kAlreadyAllowed) {
      // The element clicked on a site already allowed: Chrome's "Continue
      // allowing" closes (the grant stays as it is), "Stop allowing" blocks.
      if (result == "deny" && remember) {
        delegate->Deny(options);
      } else {
        delegate->Dismiss(options);
      }
      return;
    }
    if (result == "accept") {
      bool one_time = !remember;
      for (const auto& request : delegate->Requests()) {
        one_time &= permissions::PermissionUtil::DoesSupportTemporaryGrants(
            request->GetContentSettingsType());
      }
      if (one_time) {
        delegate->AcceptThisTime(options);
      } else {
        delegate->Accept(options);
      }
    } else if (result == "deny" && remember) {
      delegate->Deny(options);
    } else {
      // "dismiss", or a "deny" not to keep: the page is refused, the site
      // stays "ask".
      delegate->Dismiss(options);
    }
  }

  // The site is allowed and the system hasn't been asked: ask it, as Chrome's
  // view does, and move the flow on once every type has an answer (the
  // system's prompt can stay unanswered).
  void AskSystem() {
    if (!Current()) {
      return;
    }
    std::vector<ContentSettingsType> types;
    for (const auto& request : delegate_->Requests()) {
      types.push_back(request->GetContentSettingsType());
    }
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
      if (system_permission_settings::CanPrompt(type)) {
        return;
      }
    }
    // The manager replaces or deletes this from inside the call: nothing
    // after it.
    delegate_->AdvanceOrFinalizeEmbeddedPromptFlow();
  }

  void Acknowledge() {
    if (Current()) {
      delegate_->Dismiss(PromptOptions(std::monostate{}));
    }
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
  if (!Holds(contents)) {
    *default_handling = true;
    return nullptr;
  }
  *default_handling = false;
  return std::make_unique<Prompt>(contents, delegate);
}

using RestoreCallback = base::OnceCallback<void(permissions::PermissionAction)>;

// A site asking again for files it kept handles to (in IndexedDB, from an
// earlier visit): Chrome's restore prompt is a bubble anchored to the toolbar's
// page info icon, so it's asked as a "fileSystem" request. It answers once: the
// app, or the page going to another origin or the tab closing, which dismiss
// it as Chrome's bubble does (a dismissal forgets the saved grants).
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
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(
            [](std::string id, base::DictValue request) {
              auto it = All().find(id);
              if (it != All().end() && it->second->web_contents()) {
                Ask(it->second->web_contents(), std::move(request));
              }
            },
            id,
            Request(id, origin.GetURL().spec(),
                    base::ListValue().Append("fileSystem"))));
  }

  // Its one "Allow" is Chrome's "Allow this time": the files stay the site's
  // for this visit and it asks again on the next. A remembered "deny" is
  // "Don't allow"; anything else dismisses.
  static bool Resolve(const std::string& id,
                      const std::string& result,
                      bool remember) {
    if (!All().contains(id)) {
      return false;
    }
    permissions::PermissionAction action =
        permissions::PermissionAction::DISMISSED;
    if (result == "accept") {
      action = permissions::PermissionAction::GRANTED_ONCE;
    } else if (result == "deny" && remember) {
      action = permissions::PermissionAction::DENIED;
    }
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&FileRestorePrompt::Finish, id, action,
                                  /*answered=*/true));
    return true;
  }

  // content::WebContentsObserver: as LocationBarBubbleDelegateView closes
  // Chrome's bubble.
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
    // Not from inside the observer call: the app may close the tab in
    // response.
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&FileRestorePrompt::Finish, id_,
                                  permissions::PermissionAction::DISMISSED,
                                  /*answered=*/false));
    Observe(nullptr);
  }

  // Once: a second answer (the page went after the app answered) finds
  // nothing.
  static void Finish(std::string id,
                     permissions::PermissionAction action,
                     bool answered) {
    auto it = All().find(id);
    if (it == All().end()) {
      return;
    }
    RestoreCallback callback = std::move(it->second->callback_);
    All().erase(it);
    Gone(id, answered);
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
  if (!Holds(contents)) {
    return false;
  }
  FileRestorePrompt::Start(contents, request.origin, std::move(callback));
  return true;
}

}  // namespace

void Install(Host host) {
  TheHost() = std::move(host);
  SetCreatePermissionPromptFunction(&CreatePrompt);
  g_bay_file_system_restore_prompt = &AskToRestoreFiles;
}

void Resolve(const std::string& request_id,
             const std::string& result,
             bool remember) {
  if (FileRestorePrompt::Resolve(request_id, result, remember)) {
    return;
  }
  auto it = Prompts().find(request_id);
  if (it != Prompts().end() && it->second) {
    it->second->Resolve(result, remember);
  }
}

}  // namespace nncore::permission_prompts
