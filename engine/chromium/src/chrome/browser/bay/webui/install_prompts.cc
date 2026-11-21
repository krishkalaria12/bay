// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/install_prompts.h"

#include <utility>
#include <vector>

#include "base/base64.h"
#include "base/containers/span.h"
#include "base/memory/ref_counted_memory.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/bay/webui/download_controls.h"
#include "chrome/browser/profiles/profile.h"
#include "components/sessions/content/session_tab_helper.h"
#include "extensions/browser/install_prompt_data.h"
#include "extensions/common/extension.h"
#include "ui/gfx/image/image.h"

namespace bay {
namespace {

using Prompt = extensions::InstallPromptData;

// nncore's InstallPromptTypeName: the JS ExtensionInstallPrompt's type.
const char* TypeName(Prompt::PromptType type) {
  switch (type) {
    case Prompt::INSTALL_PROMPT:
      return "install";
    case Prompt::RE_ENABLE_PROMPT:
      return "re-enable";
    case Prompt::PERMISSIONS_PROMPT:
      return "permissions";
    case Prompt::EXTERNAL_INSTALL_PROMPT:
      return "external";
    case Prompt::REMOTE_INSTALL_PROMPT:
      return "remote";
    case Prompt::REPAIR_PROMPT:
      return "repair";
    default:
      return "other";
  }
}

}  // namespace

InstallPrompts::Pending::Pending() = default;
InstallPrompts::Pending::Pending(Pending&&) = default;
InstallPrompts::Pending& InstallPrompts::Pending::operator=(Pending&&) =
    default;
InstallPrompts::Pending::~Pending() = default;

InstallPrompts& InstallPrompts::Get() {
  static base::NoDestructor<InstallPrompts> prompts;
  return *prompts;
}

InstallPrompts::InstallPrompts() = default;
InstallPrompts::~InstallPrompts() = default;

void InstallPrompts::Start(Sink sink) {
  sink_ = std::move(sink);
  ExtensionInstallPrompt::SetBayPromptHandler(&InstallPrompts::Handle);
}

base::DictValue InstallPrompts::Describe(const std::string& request_id,
                                         Profile* profile,
                                         int browser_id,
                                         const Prompt& prompt) {
  const extensions::Extension* extension = prompt.extension();
  base::ListValue permissions;
  for (size_t i = 0; i < prompt.GetPermissionCount(); ++i)
    permissions.Append(base::UTF16ToUTF8(prompt.GetPermission(i)));
  std::string icon;
  if (!prompt.icon().IsEmpty()) {
    if (auto png = prompt.icon().As1xPNGBytes(); png && png->size()) {
      icon = "data:image/png;base64," +
             base::Base64Encode(base::span<const uint8_t>(*png));
    }
  }
  return base::DictValue()
      .Set("requestId", request_id)
      .Set("profile", DownloadControls::ProfileId(profile->GetOriginalProfile())
                          .value_or(""))
      .Set("id", extension ? extension->id() : std::string())
      .Set("name", extension ? extension->name() : std::string())
      .Set("version", extension ? extension->VersionString() : std::string())
      .Set("type", TypeName(prompt.type()))
      .Set("icon", icon)
      .Set("permissions", std::move(permissions))
      .Set("browserId", browser_id);
}

// static
bool InstallPrompts::Handle(Profile* profile,
                            content::WebContents* parent,
                            const Prompt& prompt,
                            ExtensionInstallPrompt::DoneCallback* done) {
  auto& self = Get();
  if (!profile || !prompt.extension() || !done || done->is_null() ||
      !self.sink_) {
    return false;
  }
  const std::string request_id =
      "install" + base::NumberToString(++self.last_id_);
  const int browser_id =
      parent ? sessions::SessionTabHelper::IdForTab(parent).id() : 0;
  // The event reaches the window asynchronously: the prompt is held before its
  // answer can come.
  auto host =
      self.sink_.Run(parent, Describe(request_id, profile, browser_id, prompt));
  if (!host)
    return false;
  Pending pending;
  pending.done = std::move(*done);
  pending.profile = profile->GetWeakPtr();
  pending.host = std::move(host);
  self.pending_[request_id] = std::move(pending);
  return true;
}

void InstallPrompts::Resolve(const std::string& request_id, bool accepted) {
  Finish(request_id, accepted);
}

void InstallPrompts::HostGone(const NativeHost* host) {
  std::vector<std::string> cancelled;
  for (const auto& [id, pending] : pending_) {
    if (!pending.host || pending.host.get() == host)
      cancelled.push_back(id);
  }
  for (const auto& id : cancelled)
    Finish(id, false);
}

void InstallPrompts::Finish(const std::string& request_id, bool accepted) {
  auto it = pending_.find(request_id);
  if (it == pending_.end())
    return;
  Pending pending = std::move(it->second);
  pending_.erase(it);
  // The profile went (shutdown, deletion): Chrome's dialog would have gone
  // with it.
  if (!pending.profile)
    return;
  using Payload = ExtensionInstallPrompt::DoneCallbackPayload;
  using Result = extensions::ExtensionInstallPromptClient::Result;
  std::move(pending.done)
      .Run(Payload(accepted ? Result::ACCEPTED : Result::USER_CANCELED));
}

}  // namespace bay
