// Copyright 2026 Bay. Apache-2.0.
#include "bay/core/nn_external_app_requests.h"

#include <map>
#include <utility>

#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/stringprintf.h"
#include "chrome/browser/external_protocol/external_protocol_handler.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "services/network/public/cpp/is_potentially_trustworthy.h"

namespace nncore::external_apps {
namespace {

struct Pending {
  Approval approval;
  bool can_remember = false;
};

std::map<std::string, Pending>& PendingRequests() {
  static base::NoDestructor<std::map<std::string, Pending>> pending;
  return *pending;
}

}  // namespace

std::string NextRequestId() {
  static int last_id = 0;
  return "x" + base::NumberToString(++last_id);
}

bool CanRemember(content::WebContents* contents,
                 const std::optional<url::Origin>& origin,
                 bool has_app) {
  return has_app && contents && origin && !origin->opaque() &&
         !Profile::FromBrowserContext(contents->GetBrowserContext())
              ->IsOffTheRecord() &&
         network::IsOriginPotentiallyTrustworthy(*origin);
}

base::DictValue Describe(const std::string& request_id,
                         const std::string& url,
                         const std::string& scheme,
                         const std::optional<std::string>& origin,
                         const std::string& app,
                         const std::optional<std::string>& app_path,
                         const base::Value& icon,
                         bool can_remember,
                         const std::string& computer) {
  const bool has_app = !app.empty();
  auto request =
      base::DictValue()
          .Set("id", request_id)
          .Set("url", url)
          .Set("scheme", scheme)
          .Set("origin", origin ? base::Value(*origin) : base::Value())
          .Set("app", has_app ? base::Value(app) : base::Value())
          .Set("appPath", has_app && app_path ? base::Value(*app_path)
                                              : base::Value())
          .Set("icon", icon.Clone())
          .Set("title", has_app ? base::StringPrintf("Open “%s”?", app.c_str())
                                : "No application is set to open this link");
  std::string message;
  if (!has_app) {
    message = base::StringPrintf("%s doesn’t have an app for “%s:” links.",
                                 computer.c_str(), scheme.c_str());
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

void Keep(const std::string& request_id,
          GURL url,
          content::WebContents* contents,
          std::optional<url::Origin> origin,
          content::WeakDocumentPtr initiator,
          bool can_remember) {
  PendingRequests()[request_id] = {
      {std::move(url), contents->GetWeakPtr(), std::move(origin), initiator},
      can_remember};
}

std::optional<Approval> Resolve(const std::string& request_id,
                                bool open,
                                bool remember) {
  auto it = PendingRequests().find(request_id);
  if (it == PendingRequests().end()) {
    return std::nullopt;
  }
  Pending pending = std::move(it->second);
  PendingRequests().erase(it);
  content::WebContents* contents = pending.approval.contents.get();
  // The page that asked must still be there (not navigated away from).
  if (!open || !contents ||
      !pending.approval.initiator.AsRenderFrameHostIfValid()) {
    return std::nullopt;
  }
  if (remember && pending.can_remember && pending.approval.origin) {
    ExternalProtocolHandler::SetBlockState(
        std::string(pending.approval.url.scheme()), *pending.approval.origin,
        ExternalProtocolHandler::DONT_BLOCK,
        Profile::FromBrowserContext(contents->GetBrowserContext()));
  }
  return std::move(pending.approval);
}

void Launch(const Approval& approval) {
  if (approval.contents) {
    ExternalProtocolHandler::LaunchUrlWithoutSecurityCheck(
        approval.url, approval.contents.get(), approval.initiator);
  }
}

}  // namespace nncore::external_apps
