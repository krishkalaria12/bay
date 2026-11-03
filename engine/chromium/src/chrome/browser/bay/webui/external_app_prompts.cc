// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/external_app_prompts.h"

#include <map>
#include <utility>

#include "base/functional/bind.h"
#include "base/location.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/stringprintf.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/bay/nn_external_apps_platform.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "chrome/browser/external_protocol/external_protocol_handler.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/weak_document_ptr.h"
#include "content/public/browser/web_contents.h"
#include "services/network/public/cpp/is_potentially_trustworthy.h"
#include "url/gurl.h"
#include "url/origin.h"

// The hook in Chrome's external_protocol_handler.cc (engine/nncore/apply.sh).
extern bool (*g_bay_external_protocol_dialog)(
    const GURL& url,
    content::WebContents* web_contents,
    const std::optional<url::Origin>& initiating_origin,
    content::WeakDocumentPtr initiator_document,
    const std::u16string& program_name);

namespace bay {
namespace {

struct Pending {
  GURL url;
  base::WeakPtr<content::WebContents> contents;
  std::optional<url::Origin> origin;
  content::WeakDocumentPtr initiator;
  bool can_remember = false;
};

std::map<std::string, Pending>& PendingRequests() {
  static base::NoDestructor<std::map<std::string, Pending>> pending;
  return *pending;
}

ExternalAppPrompts::ViewSink& Sink() {
  static base::NoDestructor<ExternalAppPrompts::ViewSink> sink;
  return *sink;
}

// The desktop's handler is known, so the prompt can name it and offer to open.
void Asked(std::string request_id,
           GURL url,
           base::WeakPtr<content::WebContents> contents,
           std::optional<url::Origin> origin,
           content::WeakDocumentPtr initiator,
           std::u16string program_name,
           base::DictValue handler) {
  const std::string* found = handler.FindString("app");
  std::string app = found ? *found : base::UTF16ToUTF8(program_name);
  if (!contents)
    return;
  const bool has_origin = origin && !origin->opaque();
  Profile* profile = Profile::FromBrowserContext(contents->GetBrowserContext());
  // As Chrome's dialog: "always" only for a trustworthy origin, outside private.
  const bool can_remember = !app.empty() && has_origin &&
                            !profile->IsOffTheRecord() &&
                            network::IsOriginPotentiallyTrustworthy(*origin);
  const base::Value no_icon;
  const base::Value* icon = handler.Find("icon");
  auto request = ExternalAppPrompts::Describe(
      request_id, url.spec(), std::string(url.scheme()),
      has_origin ? std::make_optional(origin->Serialize()) : std::nullopt, app,
      icon ? *icon : no_icon, can_remember);
  if (!Sink() || !Sink().Run(contents.get(), "onExternalApp", std::move(request)))
    return;
  // With no handler the prompt only informs: there's nothing to answer.
  if (!app.empty()) {
    PendingRequests()[request_id] = {std::move(url), contents, std::move(origin),
                                     initiator, can_remember};
  }
}

bool AskApp(const GURL& url,
            content::WebContents* contents,
            const std::optional<url::Origin>& initiating_origin,
            content::WeakDocumentPtr initiator_document,
            const std::u16string& program_name) {
  // A window Chrome made itself keeps Chrome's dialog.
  if (!WindowRegistry::Get().HoldsTab(contents))
    return false;
  static int last_id = 0;
  const std::string request_id = "x" + base::NumberToString(++last_id);
  // The desktop's application database can block: AppForScheme says so.
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&AppForScheme, std::string(url.scheme())),
      base::BindOnce(&Asked, request_id, url, contents->GetWeakPtr(),
                     initiating_origin, initiator_document, program_name));
  return true;
}

}  // namespace

// static
base::DictValue ExternalAppPrompts::Describe(
    const std::string& request_id,
    const std::string& url,
    const std::string& scheme,
    const std::optional<std::string>& origin,
    const std::string& app,
    const base::Value& icon,
    bool can_remember) {
  const bool has_app = !app.empty();
  auto request =
      base::DictValue()
          .Set("id", request_id)
          .Set("url", url)
          .Set("scheme", scheme)
          .Set("origin", origin ? base::Value(*origin) : base::Value())
          .Set("app", has_app ? base::Value(app) : base::Value())
          .Set("appPath", base::Value())
          .Set("icon", icon.Clone())
          .Set("title", has_app ? base::StringPrintf("Open “%s”?", app.c_str())
                                : "No application is set to open this link");
  std::string message;
  if (!has_app) {
    message = base::StringPrintf(
        "This computer doesn’t have an app for “%s:” links.", scheme.c_str());
  } else if (origin) {
    message = *origin + " wants to open this application.";
  } else {
    message = "This page wants to open this application.";
  }
  request.Set("message", message);
  request.Set("remember",
              can_remember && origin
                  ? base::Value(base::StringPrintf(
                        "Always allow %s to open links of this type in %s",
                        origin->c_str(), app.c_str()))
                  : base::Value());
  return request;
}

// static
void ExternalAppPrompts::Start(ViewSink sink) {
  Sink() = std::move(sink);
  g_bay_external_protocol_dialog = &AskApp;
}

// static
void ExternalAppPrompts::Resolve(const std::string& request_id,
                                 bool open,
                                 bool remember) {
  auto it = PendingRequests().find(request_id);
  if (it == PendingRequests().end())
    return;
  Pending pending = std::move(it->second);
  PendingRequests().erase(it);
  content::WebContents* contents = pending.contents.get();
  // The page that asked must still be there (not navigated away from).
  if (!open || !contents || !pending.initiator.AsRenderFrameHostIfValid())
    return;
  if (remember && pending.can_remember && pending.origin) {
    // Chrome's own "always allow", as its dialog's checkbox.
    ExternalProtocolHandler::SetBlockState(
        std::string(pending.url.scheme()), *pending.origin,
        ExternalProtocolHandler::DONT_BLOCK,
        Profile::FromBrowserContext(contents->GetBrowserContext()));
  }
  ExternalProtocolHandler::LaunchUrlWithoutSecurityCheck(pending.url, contents,
                                                         pending.initiator);
}

}  // namespace bay
