// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/profile_data.h"

#include <iterator>
#include <optional>
#include <string_view>
#include <utility>
#include <vector>

#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/location.h"
#include "base/memory/ref_counted.h"
#include "base/path_service.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/delete_profile_helper.h"
#include "chrome/browser/profiles/nuke_profile_directory_utils.h"
#include "chrome/browser/profiles/profile_attributes_storage.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/profiles/profile_metrics.h"
#include "chrome/common/chrome_paths.h"

namespace bay {
namespace {

using Response = ProfileData::Response;
using EngineInvoker = ProfileData::EngineInvoker;
using Result = std::optional<base::Value>;
using Done = base::OnceCallback<void(bool)>;

// Zoom levels go asynchronously: how often, and how long, they're listed again.
constexpr base::TimeDelta kZoomRecheck = base::Milliseconds(100);
constexpr int kZoomRechecks = 20;

std::string Remaining(const std::vector<std::string>& labels) {
  base::ListValue remaining;
  for (const auto& label : labels)
    remaining.Append(label);
  return base::WriteJson(
             base::DictValue().Set(
                 "value", base::DictValue().Set("remaining",
                                                std::move(remaining))))
      .value_or("{}");
}

// The engine's result in a host envelope, or nullopt when the call failed.
Result Unwrap(const std::string& envelope) {
  auto parsed = base::JSONReader::Read(envelope, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_dict())
    return std::nullopt;
  auto* value = parsed->GetDict().Find("value");
  return value ? Result(std::move(*value)) : std::nullopt;
}

const base::ListValue* ListIn(const Result& result, const std::string& key) {
  const auto* dict = result ? result->GetIfDict() : nullptr;
  return dict ? dict->FindList(key) : nullptr;
}

bool ValidProfileId(std::string_view id) {
  return id.size() <= 128 &&
         id.find_first_not_of(
             "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
             "0123456789-_") == std::string_view::npos;
}

// What an item of a store's list becomes: the arguments of the call that
// clears it, or nullopt to leave it.
using Pick =
    base::RepeatingCallback<std::optional<base::DictValue>(const base::Value&)>;

std::optional<base::DictValue> PickPassword(const base::Value& item) {
  const auto* dict = item.GetIfDict();
  const auto* origin = dict ? dict->FindString("origin") : nullptr;
  const auto* username = dict ? dict->FindString("username") : nullptr;
  if (!origin || !username)
    return std::nullopt;
  return base::DictValue().Set("origin", *origin).Set("username", *username);
}
std::optional<base::DictValue> PickById(const base::Value& item) {
  const auto* dict = item.GetIfDict();
  const auto* id = dict ? dict->FindString("id") : nullptr;
  if (!id)
    return std::nullopt;
  return base::DictValue().Set("id", *id);
}
// A running extension the user may turn off.
std::optional<base::DictValue> PickRunningExtension(const base::Value& item) {
  const auto* dict = item.GetIfDict();
  const auto* id = dict ? dict->FindString("id") : nullptr;
  if (!id || dict->FindBool("enabled") != true ||
      dict->FindBool("mayModify") == false)
    return std::nullopt;
  return base::DictValue().Set("id", *id).Set("enabled", false);
}
// A store whose list is of strings (origins): one argument named |name|.
Pick PickString(std::string name) {
  return base::BindRepeating(
      [](const std::string& name,
         const base::Value& item) -> std::optional<base::DictValue> {
        if (!item.is_string())
          return std::nullopt;
        return base::DictValue().Set(name, item.GetString());
      },
      std::move(name));
}

// NNCoreProfileData.deleteDefault: every store of the Default profile in turn,
// each checked afterwards; the labels of those that kept something.
class DefaultClear : public base::RefCounted<DefaultClear> {
 public:
  DefaultClear(EngineInvoker engine, Response response)
      : engine_(std::move(engine)), response_(std::move(response)) {}

  void Next() {
    if (step_ >= std::size(ProfileData::kDefaultStores)) {
      std::move(response_).Run(Remaining(remaining_));
      return;
    }
    Done done = base::BindOnce(&DefaultClear::Cleared, base::WrapRefCounted(this),
                               step_);
    switch (step_) {
      case 0:
        // History, cookies, cache and the download list: Chrome's own clear,
        // which reports nothing it kept.
        Call("nn_browsing_data_clear",
             base::DictValue()
                 .Set("types", base::ListValue()
                                   .Append("history")
                                   .Append("siteData")
                                   .Append("cache")
                                   .Append("downloads"))
                 .Set("since", 0),
             base::BindOnce([](Done done, Result) { std::move(done).Run(true); },
                            std::move(done)));
        return;
      case 1:
        // As Chrome's Delete Browsing Data dialog: form data is autofill plus
        // autocomplete entries.
        Call("nn_browsing_data_clear",
             base::DictValue().Set(
                 "types",
                 base::ListValue().Append("formData").Append("siteSettings")),
             base::BindOnce(
                 [](Done done, Result result) {
                   const auto* dict = result ? result->GetIfDict() : nullptr;
                   std::move(done).Run(dict && dict->FindBool("ok") == true);
                 },
                 std::move(done)));
        return;
      case 2:
        ClearList("nn_passwords_list", "passwords", "nn_passwords_remove",
                  base::BindRepeating(&PickPassword),
                  base::BindOnce(&DefaultClear::ClearedPasswords,
                                 base::WrapRefCounted(this), std::move(done)));
        return;
      case 3:
        ClearList("nn_autofill_addresses", "addresses", "nn_autofill_remove",
                  base::BindRepeating(&PickById), std::move(done));
        return;
      case 4:
        ClearList("nn_autofill_cards", "cards", "nn_autofill_remove",
                  base::BindRepeating(&PickById), std::move(done));
        return;
      case 5:
        ClearList("nn_extensions_list", "extensions",
                  "nn_extensions_set_enabled",
                  base::BindRepeating(&PickRunningExtension), std::move(done));
        return;
      case 6:
        ClearList("nn_site_settings_origins", "origins",
                  "nn_site_settings_reset", PickString("origin"),
                  std::move(done));
        return;
      case 7:
        Call("nn_zoom_list", base::DictValue(),
             base::BindOnce(&DefaultClear::ResetZoom,
                            base::WrapRefCounted(this), std::move(done)));
        return;
    }
  }

 private:
  friend class base::RefCounted<DefaultClear>;
  ~DefaultClear() = default;

  void Cleared(size_t step, bool ok) {
    if (!ok)
      remaining_.push_back(ProfileData::kDefaultStores[step]);
    ++step_;
    Next();
  }

  // An engine call on the Default profile.
  void Call(const std::string& name,
            base::DictValue args,
            base::OnceCallback<void(Result)> then) {
    engine_.Run(name, "", std::move(args),
                base::BindOnce(
                    [](base::OnceCallback<void(Result)> then,
                       const std::string& envelope) {
                      std::move(then).Run(Unwrap(envelope));
                    },
                    std::move(then)));
  }

  // Runs |name| with each argument set, one after another, then |done|.
  void Each(const std::string& name,
            std::vector<base::DictValue> calls,
            base::OnceClosure done) {
    if (calls.empty()) {
      std::move(done).Run();
      return;
    }
    base::DictValue args = std::move(calls.back());
    calls.pop_back();
    Call(name, std::move(args),
         base::BindOnce(
             [](scoped_refptr<DefaultClear> self, std::string name,
                std::vector<base::DictValue> calls, base::OnceClosure done,
                Result) {
               self->Each(name, std::move(calls), std::move(done));
             },
             base::WrapRefCounted(this), name, std::move(calls),
             std::move(done)));
  }

  // Lists |key| with |list|, clears every item |pick| takes with |clear|, then
  // lists again: done(true) once |pick| takes none.
  void ClearList(const std::string& list,
                 const std::string& key,
                 const std::string& clear,
                 Pick pick,
                 Done done) {
    Call(list, base::DictValue(),
         base::BindOnce(&DefaultClear::Listed, base::WrapRefCounted(this),
                        list, key, clear, std::move(pick), std::move(done)));
  }
  void Listed(std::string list,
              std::string key,
              std::string clear,
              Pick pick,
              Done done,
              Result result) {
    const auto* items = ListIn(result, key);
    if (!items) {
      std::move(done).Run(false);
      return;
    }
    std::vector<base::DictValue> calls;
    for (const auto& item : *items) {
      if (auto args = pick.Run(item))
        calls.push_back(std::move(*args));
    }
    Each(clear, std::move(calls),
         base::BindOnce(&DefaultClear::Call, base::WrapRefCounted(this), list,
                        base::DictValue(),
                        base::BindOnce(
                            [](std::string key, Pick pick, Done done,
                               Result again) {
                              const auto* left = ListIn(again, key);
                              if (!left) {
                                std::move(done).Run(false);
                                return;
                              }
                              for (const auto& item : *left) {
                                if (pick.Run(item)) {
                                  std::move(done).Run(false);
                                  return;
                                }
                              }
                              std::move(done).Run(true);
                            },
                            key, pick, std::move(done))));
  }

  // The saved passwords went: now the sites they're never saved for.
  void ClearedPasswords(Done done, bool deleted) {
    ClearList("nn_passwords_exceptions", "origins", "nn_passwords_allow",
              PickString("origin"),
              base::BindOnce(
                  [](bool deleted, Done done, bool allowed) {
                    std::move(done).Run(deleted && allowed);
                  },
                  deleted, std::move(done)));
  }

  void ResetZoom(Done done, Result levels) {
    const auto* dict = levels ? levels->GetIfDict() : nullptr;
    const auto* hosts = dict ? dict->FindDict("levels") : nullptr;
    if (!hosts) {
      std::move(done).Run(false);
      return;
    }
    std::vector<base::DictValue> calls;
    for (const auto [host, level] : *hosts)
      calls.push_back(base::DictValue().Set("host", host).Set("level", 0));
    Each("nn_zoom_set", std::move(calls),
         base::BindOnce(&DefaultClear::CheckZoom, base::WrapRefCounted(this),
                        std::move(done), 0));
  }
  // Chrome applies zoom changes asynchronously: listed again until none are
  // left, or given up.
  void CheckZoom(Done done, int attempt) {
    Call("nn_zoom_list", base::DictValue(),
         base::BindOnce(&DefaultClear::ZoomChecked, base::WrapRefCounted(this),
                        std::move(done), attempt));
  }
  void ZoomChecked(Done done, int attempt, Result levels) {
    const auto* dict = levels ? levels->GetIfDict() : nullptr;
    const auto* hosts = dict ? dict->FindDict("levels") : nullptr;
    const bool empty = hosts && hosts->empty();
    if (empty || attempt >= kZoomRechecks) {
      std::move(done).Run(empty);
      return;
    }
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(&DefaultClear::CheckZoom, base::WrapRefCounted(this),
                       std::move(done), attempt + 1),
        kZoomRecheck);
  }

  EngineInvoker engine_;
  Response response_;
  size_t step_ = 0;
  std::vector<std::string> remaining_;
};

}  // namespace

const char* const ProfileData::kDefaultStores[8] = {
    "history, cookies and cache",
    "autocomplete entries",
    "passwords",
    "addresses",
    "cards",
    "extensions",
    "site settings",
    "zoom levels",
};

void ProfileData::Delete(const EngineInvoker& engine,
                         const std::string& profile,
                         Response response) {
  // A private window's profile goes with its window (WindowRegistry).
  if (profile.starts_with("incognito:")) {
    std::move(response).Run(Remaining({}));
    return;
  }
  if (profile.empty()) {
    base::MakeRefCounted<DefaultClear>(engine, std::move(response))->Next();
    return;
  }
  base::FilePath root;
  auto* manager =
      g_browser_process ? g_browser_process->profile_manager() : nullptr;
  if (!ValidProfileId(profile) || !manager ||
      !base::PathService::Get(chrome::DIR_USER_DATA, &root)) {
    std::move(response).Run(Remaining({"data"}));
    return;
  }
  const base::FilePath path = root.AppendASCII(profile);
  // Already on its way.
  if (IsProfileDirectoryMarkedForDeletion(path)) {
    std::move(response).Run(Remaining({}));
    return;
  }
  if (manager->GetProfileByPath(path) ||
      manager->GetProfileAttributesStorage().GetProfileAttributesWithPath(
          path)) {
    // Chrome closes the profile's browsers and deletes its folder once it has
    // unloaded; a deletion it couldn't finish completes at the next launch.
    manager->GetDeleteProfileHelper().MaybeScheduleProfileForDeletion(
        path, base::DoNothing(), ProfileMetrics::DELETE_PROFILE_SETTINGS);
    std::move(response).Run(Remaining({}));
    return;
  }
  // Chrome never knew it (or has forgotten it): its folder alone. Loading it
  // to delete it would make it anew.
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE,
      {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
       base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN},
      base::BindOnce(
          [](const base::FilePath& path) {
            base::DeletePathRecursively(path);
            return !base::PathExists(path);
          },
          path),
      base::BindOnce(
          [](Response response, bool deleted) {
            std::move(response).Run(
                Remaining(deleted ? std::vector<std::string>()
                                  : std::vector<std::string>{"files"}));
          },
          std::move(response)));
}

}  // namespace bay
