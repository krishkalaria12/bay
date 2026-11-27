// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/external_app_prompts.h"

#include <utility>

#include "bay/core/nn_external_app_requests.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/no_destructor.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/bay/nn_external_apps_platform.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "content/public/browser/weak_document_ptr.h"
#include "content/public/browser/web_contents.h"
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

namespace external_apps = nncore::external_apps;

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
  const bool can_remember =
      external_apps::CanRemember(contents.get(), origin, !app.empty());
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
    external_apps::Keep(request_id, std::move(url), contents.get(),
                        std::move(origin), initiator, can_remember);
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
  // The desktop's application database can block: AppForScheme says so.
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&AppForScheme, std::string(url.scheme())),
      base::BindOnce(&Asked, external_apps::NextRequestId(), url,
                     contents->GetWeakPtr(), initiating_origin,
                     initiator_document, program_name));
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
  return external_apps::Describe(request_id, url, scheme, origin, app,
                                 std::nullopt, icon, can_remember,
                                 "This computer");
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
  if (auto approval = external_apps::Resolve(request_id, open, remember))
    external_apps::Launch(*approval);
}

}  // namespace bay
