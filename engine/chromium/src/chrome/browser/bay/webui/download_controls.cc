// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/download_controls.h"

#include <algorithm>
#include <memory>
#include <string_view>
#include <utility>

#include "base/barrier_callback.h"
#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/location.h"
#include "base/path_service.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/bay/nn_dispatch.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/common/chrome_paths.h"

namespace bay {
namespace {

using Listing = std::pair<std::string, std::string>;  // profile, envelope

std::string JSON(const base::DictValue& value) {
  return base::WriteJson(value).value_or("{}");
}
std::string Success(base::Value value = base::Value()) {
  return JSON(base::DictValue().Set("value", std::move(value)));
}
std::string Failure(std::string_view code, std::string_view message) {
  return JSON(base::DictValue().Set(
      "error", base::DictValue().Set("code", code).Set("message", message)));
}

// The engine's own failure message in a host envelope, or "".
std::string EngineError(const std::string& envelope) {
  const auto parsed =
      base::JSONReader::ReadDict(envelope, base::JSON_PARSE_RFC);
  const auto* error = parsed ? parsed->FindDict("error") : nullptr;
  const auto* message = error ? error->FindString("message") : nullptr;
  return message ? *message : (error ? "error" : "");
}

bool ValidProfileId(std::string_view id) {
  return id.size() <= 128 &&
         id.find_first_not_of(
             "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
             "0123456789-_") == std::string_view::npos;
}

double StartTime(const base::DictValue& download) {
  return download.FindDouble("startTime").value_or(0);
}

// BayCEF.listDownloads' reply: every profile's list, newest first. A profile
// that closed in between lists nothing.
void ReplyWithDownloads(DownloadControls::Response response,
                        std::vector<Listing> listings) {
  std::vector<base::DictValue> all;
  for (const auto& [profile, envelope] : listings) {
    const auto parsed = base::JSONReader::Read(envelope, base::JSON_PARSE_RFC);
    const auto* value =
        parsed && parsed->is_dict() ? parsed->GetDict().Find("value") : nullptr;
    if (!value)
      continue;
    for (auto& download : DownloadControls::Get().Downloads(*value, profile))
      all.push_back(std::move(download));
  }
  std::stable_sort(all.begin(), all.end(),
                   [](const base::DictValue& a, const base::DictValue& b) {
                     return StartTime(a) > StartTime(b);
                   });
  base::ListValue list;
  for (auto& download : all)
    list.Append(std::move(download));
  std::move(response).Run(Success(base::Value(std::move(list))));
}

void OnListed(void* context, const char* json) {
  std::unique_ptr<std::string> profile(static_cast<std::string*>(context));
  DownloadControls::Get().Listed(*profile, json ? json : "{}");
}

}  // namespace

DownloadControls& DownloadControls::Get() {
  static base::NoDestructor<DownloadControls> controls;
  return *controls;
}

DownloadControls::DownloadControls() = default;
DownloadControls::~DownloadControls() = default;

void DownloadControls::Start(Sink sink) {
  sink_ = std::move(sink);
  auto* manager =
      g_browser_process ? g_browser_process->profile_manager() : nullptr;
  if (started_ || !manager)
    return;
  started_ = true;
  observation_.Observe(manager);
  for (const auto& profile : LoadedProfiles())
    Watch(profile);
}

base::DictValue DownloadControls::Adopt(const base::DictValue& download,
                                        const std::string& profile) {
  auto adopted = download.Clone();
  adopted.Set("profile", profile);
  if (const auto* id = download.FindString("id"); id && !id->empty())
    profiles_[*id] = profile;
  return adopted;
}

void DownloadControls::Forget(const std::string& id) {
  profiles_.erase(id);
}

std::vector<base::DictValue> DownloadControls::Downloads(
    const base::Value& result,
    const std::string& profile) {
  std::vector<base::DictValue> downloads;
  const auto* dict = result.GetIfDict();
  const auto* list = dict ? dict->FindList("downloads") : nullptr;
  if (!list)
    return downloads;
  for (const auto& entry : *list) {
    if (const auto* download = entry.GetIfDict())
      downloads.push_back(Adopt(*download, profile));
  }
  return downloads;
}

void DownloadControls::List(const EngineInvoker& engine, Response response) {
  const auto profiles = LoadedProfiles();
  if (profiles.empty()) {
    std::move(response).Run(Success(base::Value(base::ListValue())));
    return;
  }
  auto done = base::BarrierCallback<Listing>(
      profiles.size(), base::BindOnce(&ReplyWithDownloads, std::move(response)));
  for (const auto& profile : profiles) {
    engine.Run("nn_downloads_list", profile, base::DictValue(),
               base::BindOnce(
                   [](base::RepeatingCallback<void(Listing)> done,
                      std::string profile, const std::string& envelope) {
                     done.Run({std::move(profile), envelope});
                   },
                   done, profile));
  }
}

void DownloadControls::Command(const EngineInvoker& engine,
                               const std::string& command,
                               const std::string& id,
                               Response response) {
  if ((command != "pause" && command != "resume" && command != "cancel") ||
      id.empty() || id.size() > 128) {
    std::move(response).Run(
        Failure("invalid_args", "A download command and id required"));
    return;
  }
  // The profile that reported it first, then every other loaded one.
  std::vector<std::string> profiles;
  if (auto known = profiles_.find(id); known != profiles_.end())
    profiles.push_back(known->second);
  for (auto& profile : LoadedProfiles()) {
    if (std::find(profiles.begin(), profiles.end(), profile) == profiles.end())
      profiles.push_back(std::move(profile));
  }
  Try(engine, "nn_downloads_" + command, id, std::move(profiles), 0,
      std::move(response));
}

void DownloadControls::Try(EngineInvoker engine,
                           std::string name,
                           std::string id,
                           std::vector<std::string> profiles,
                           size_t index,
                           Response response) {
  // No profile holds it: gone already, as macOS treats it.
  if (index >= profiles.size()) {
    std::move(response).Run(Success());
    return;
  }
  const std::string profile = profiles[index];
  engine.Run(name, profile, base::DictValue().Set("id", id),
             base::BindOnce(&DownloadControls::Tried, base::Unretained(this),
                            engine, name, id, std::move(profiles), index,
                            std::move(response)));
}

void DownloadControls::Tried(EngineInvoker engine,
                             std::string name,
                             std::string id,
                             std::vector<std::string> profiles,
                             size_t index,
                             Response response,
                             const std::string& envelope) {
  if (EngineError(envelope) == "no such download") {
    Try(std::move(engine), std::move(name), std::move(id), std::move(profiles),
        index + 1, std::move(response));
    return;
  }
  // Found. "can't resume" and the like resolve too, as on macOS: the
  // download's next event says what state it is in.
  profiles_[id] = profiles[index];
  std::move(response).Run(Success());
}

std::optional<std::string> DownloadControls::ProfileId(Profile* profile) {
  if (!profile || profile->IsOffTheRecord() || profile->IsSystemProfile() ||
      profile->IsGuestSession())
    return std::nullopt;
  base::FilePath root;
  if (!base::PathService::Get(chrome::DIR_USER_DATA, &root) ||
      profile->GetPath().DirName() != root)
    return std::nullopt;
  const std::string name = profile->GetPath().BaseName().AsUTF8Unsafe();
  if (name == "Default")
    return "";
  if (name.empty() || !ValidProfileId(name))
    return std::nullopt;
  return name;
}

std::vector<std::string> DownloadControls::LoadedProfiles() {
  std::vector<std::string> ids;
  auto* manager =
      g_browser_process ? g_browser_process->profile_manager() : nullptr;
  if (!manager)
    return ids;
  for (Profile* profile : manager->GetLoadedProfiles()) {
    auto id = ProfileId(profile);
    if (id && std::find(ids.begin(), ids.end(), *id) == ids.end())
      ids.push_back(std::move(*id));
  }
  std::stable_sort(ids.begin(), ids.end(),
                   [](const std::string& a, const std::string& b) {
                     return a.empty() && !b.empty();
                   });
  return ids;
}

void DownloadControls::OnProfileAdded(Profile* profile) {
  auto id = ProfileId(profile);
  if (!id)
    return;
  // After the manager has finished adding it, so the engine finds it loaded.
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](std::string profile) {
                       DownloadControls::Get().Watch(profile);
                     },
                     std::move(*id)));
}

void DownloadControls::OnProfileManagerDestroying() {
  observation_.Reset();
  started_ = false;
  profiles_.clear();
}

void DownloadControls::Watch(const std::string& profile) {
  base::FilePath root;
  if (!base::PathService::Get(chrome::DIR_USER_DATA, &root))
    return;
  const std::string path =
      root.AppendASCII(profile.empty() ? "Default" : profile).AsUTF8Unsafe();
  // The engine replies exactly once (an unsent reply says "no reply"), maybe
  // before DispatchEngineCall returns: OnListed owns the context.
  auto* context = new std::string(profile);
  if (!DispatchEngineCall("nn_downloads_list", path.c_str(), "{}", &OnListed,
                          context)) {
    delete context;
  }
}

void DownloadControls::Listed(const std::string& profile,
                              const std::string& json) {
  const auto result = base::JSONReader::Read(json, base::JSON_PARSE_RFC);
  if (!result)
    return;
  // As NNCoreServices watchDownloads: what a profile holds when it loads,
  // earlier sessions' history included (the app keeps what it already has).
  for (auto& download : Downloads(*result, profile)) {
    if (sink_)
      sink_.Run(std::move(download));
  }
}

}  // namespace bay
