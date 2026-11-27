// Copyright 2026 Bay. Apache-2.0.

#include "chrome/browser/bay/nn_cli_agents.h"

#include <algorithm>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "base/base64url.h"
#include "base/files/file.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/rand_util.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/synchronization/lock.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "build/build_config.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/common/chrome_paths.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/browser_thread.h"
#include "crypto/secure_util.h"
#include "third_party/re2/src/re2/re2.h"

#if BUILDFLAG(IS_WIN)
#include <windows.h>

#include "base/win/access_token.h"
#include "base/win/security_descriptor.h"
#endif

namespace bay {

std::string WriteOwnerOnlyFile(const base::FilePath& path,
                               const std::string& contents,
                               std::string_view what,
                               base::Lock* lock,
                               bool (*still_wanted)(uint64_t),
                               uint64_t generation) {
  if (path.empty()) {
    return "Bay has no data folder.";
  }
  const base::FilePath temp = path.DirName().AppendASCII(
      base::StrCat({".", path.BaseName().MaybeAsASCII(), ".",
                    base::HexEncode(base::RandBytesAsVector(8))}));
#if BUILDFLAG(IS_WIN)
  auto token = base::win::AccessToken::FromCurrentProcess();
  auto descriptor = base::win::SecurityDescriptor::CreateWithEmptyDacl();
  descriptor.set_dacl_protected(true);
  if (!token ||
      !descriptor.SetDaclEntry(*token, base::win::SecurityAccessMode::kGrant,
                               GENERIC_ALL, 0)) {
    return base::StrCat({"Couldn't protect ", what, "."});
  }
  descriptor.set_owner(token->User());
  auto absolute = descriptor.ToAbsolute();
  SECURITY_ATTRIBUTES security = {sizeof(SECURITY_ATTRIBUTES), &absolute,
                                  FALSE};
  // Supply the private DACL when creating the file. A handle opened only with
  // GENERIC_WRITE cannot later change a DACL through SetSecurityInfo.
  base::File file(CreateFileW(temp.value().c_str(), GENERIC_WRITE,
                              FILE_SHARE_READ, &security, CREATE_NEW,
                              FILE_ATTRIBUTE_NORMAL, nullptr));
  const bool protected_file = file.IsValid();
#else
  base::File file(temp, base::File::FLAG_CREATE | base::File::FLAG_WRITE);
  const bool protected_file =
      file.IsValid() && base::SetPosixFilePermissions(temp, 0600);
#endif
  const bool written =
      protected_file &&
      file.WriteAtCurrentPosAndCheck(base::as_byte_span(contents)) &&
      file.Flush();
  file.Close();
  if (!written) {
    base::DeleteFile(temp);
    return base::StrCat({"Couldn't protect and write ", what, "."});
  }
  std::optional<base::AutoLock> hold;
  if (lock) {
    hold.emplace(*lock);
  }
  if (still_wanted && !still_wanted(generation)) {
    base::DeleteFile(temp);
    return "The control server stopped.";
  }
#if BUILDFLAG(IS_WIN)
  // ReplaceFileW deliberately carries the old destination's DACL onto the new
  // file. MoveFileExW keeps our protected DACL, even if an old file had
  // inherited broader permissions.
  const bool published =
      MoveFileExW(temp.value().c_str(), path.value().c_str(),
                  MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
#else
  const bool published = base::ReplaceFile(temp, path, nullptr);
#endif
  if (!published) {
    base::DeleteFile(temp);
    return base::StrCat({"Couldn't publish ", what, "."});
  }
  return {};
}

namespace cli_agents {
namespace {

constexpr char kFileName[] = "BayAgents.json";
constexpr char kTopic[] = "cliAgents";
constexpr size_t kMaxAgents = 32;
constexpr size_t kMaxRequests = 8;
constexpr size_t kMaxName = 80;

struct Grant {
  std::string id;
  std::string name;
  std::string token;
  // Profile directory names ("Default", "Profile 2"…); none: every space.
  std::optional<std::set<std::string>> profiles;
  double created = 0;
};

struct Request {
  std::string name;
  double at = 0;
};

bool ValidAgent(const std::string& id) {
  static const base::NoDestructor<re2::RE2> pattern("[a-z0-9][a-z0-9-]{0,39}");
  return re2::RE2::FullMatch(id, *pattern);
}

// An app engine profile id ("" for the default) as its directory's name.
std::optional<std::string> ProfileName(const std::string& id) {
  if (id.empty()) {
    return "Default";
  }
  static const base::NoDestructor<re2::RE2> pattern("[A-Za-z0-9_-]{1,128}");
  if (!re2::RE2::FullMatch(id, *pattern)) {
    return std::nullopt;
  }
  return id;
}

base::FilePath GrantsPath() {
  base::FilePath dir;
  if (!base::PathService::Get(chrome::DIR_USER_DATA, &dir)) {
    return base::FilePath();
  }
  return dir.AppendASCII(kFileName);
}

std::string NewToken() {
  std::string token;
  base::Base64UrlEncode(base::RandBytesAsVector(32),
                        base::Base64UrlEncodePolicy::OMIT_PADDING, &token);
  return token;
}

std::optional<std::string> ReadGrants(const base::FilePath& path) {
  std::string contents;
  if (path.empty() ||
      !base::ReadFileToStringWithMaxSize(path, &contents, 1 << 20)) {
    return std::nullopt;
  }
  return contents;
}

class Agents {
 public:
  static Agents& Get() {
    static base::NoDestructor<Agents> agents;
    return *agents;
  }

  void Load() {
    DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
    if (loaded_ || loading_) {
      return;
    }
    loading_ = true;
    Files()->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce(&ReadGrants, path_),
        base::BindOnce(&Agents::Loaded, base::Unretained(this)));
  }

  const Grant* Find(const std::string& id) const {
    auto it = std::ranges::find(grants_, id, &Grant::id);
    return it == grants_.end() ? nullptr : &*it;
  }

  std::optional<std::string> ForToken(std::string_view token) const {
    for (const Grant& grant : grants_) {
      if (grant.token.size() == token.size() &&
          crypto::SecureMemEqual(base::as_byte_span(grant.token),
                                 base::as_byte_span(token))) {
        return grant.id;
      }
    }
    return std::nullopt;
  }

  base::DictValue RequestAccess(const base::DictValue& params,
                                std::string* error) {
    const std::string* agent = params.FindString("agent");
    if (!agent || !ValidAgent(*agent)) {
      *error = "agent must be a short lowercase name, like claude-code";
      return {};
    }
    const std::string* given = params.FindString("name");
    const std::string name =
        given && !given->empty() ? given->substr(0, kMaxName) : *agent;
    Load();
    if (!loaded_) {
      return base::DictValue().Set("state", "pending");
    }
    if (const Grant* grant = Find(*agent)) {
      return base::DictValue()
          .Set("state", "granted")
          .Set("token", grant->token);
    }
    if (denied_.erase(*agent)) {
      return base::DictValue().Set("state", "denied");
    }
    if (!requests_.contains(*agent)) {
      if (requests_.size() >= kMaxRequests) {
        *error = "too many agents are waiting for an answer in Bay";
        return {};
      }
      requests_[*agent] = {name,
                           base::Time::Now().InMillisecondsFSinceUnixEpoch()};
      Announce();
    }
    return base::DictValue().Set("state", "pending");
  }

  std::string Answer(const base::DictValue& args) {
    const std::string* agent = args.FindString("agent");
    std::optional<bool> allow = args.FindBool("allow");
    if (!agent || !ValidAgent(*agent) || !allow) {
      return "agent and allow required";
    }
    std::optional<std::set<std::string>> profiles;
    if (const base::ListValue* list = args.FindList("profiles")) {
      profiles.emplace();
      for (const base::Value& id : *list) {
        std::optional<std::string> name =
            id.is_string() ? ProfileName(id.GetString()) : std::nullopt;
        if (!name) {
          return "profiles must be engine profile ids";
        }
        profiles->insert(*name);
      }
    }
    auto request = requests_.find(*agent);
    Grant* grant = nullptr;
    for (Grant& existing : grants_) {
      if (existing.id == *agent) {
        grant = &existing;
      }
    }
    if (!*allow) {
      requests_.erase(*agent);
      denied_.insert(*agent);
      Announce();
      return {};
    }
    if (!grant) {
      if (request == requests_.end()) {
        return "no agent asked for that";
      }
      if (grants_.size() >= kMaxAgents) {
        return "too many agents have access; take one's away first";
      }
      grants_.push_back({*agent,
                         request->second.name,
                         NewToken(),
                         {},
                         base::Time::Now().InMillisecondsFSinceUnixEpoch()});
      grant = &grants_.back();
    }
    grant->profiles = std::move(profiles);
    requests_.erase(*agent);
    Save();
    Announce();
    return {};
  }

  void Revoke(const std::string& agent) {
    std::erase_if(grants_, [&](const Grant& g) { return g.id == agent; });
    requests_.erase(agent);
    Save();
    Announce();
  }

  base::DictValue Snapshot() const {
    base::ListValue agents;
    for (const Grant& grant : grants_) {
      base::DictValue item;
      item.Set("id", grant.id);
      item.Set("name", grant.name);
      item.Set("created", grant.created);
      if (grant.profiles) {
        base::ListValue profiles;
        for (const std::string& profile : *grant.profiles) {
          profiles.Append(profile);
        }
        item.Set("profiles", std::move(profiles));
      } else {
        item.Set("profiles", base::Value());
      }
      agents.Append(std::move(item));
    }
    base::ListValue requests;
    for (const auto& [id, request] : requests_) {
      requests.Append(base::DictValue()
                          .Set("agent", id)
                          .Set("name", request.name)
                          .Set("at", request.at));
    }
    return base::DictValue()
        .Set("agents", std::move(agents))
        .Set("requests", std::move(requests))
        .Set("loaded", loaded_);
  }

 private:
  void Loaded(std::optional<std::string> contents) {
    loading_ = false;
    loaded_ = true;
    std::optional<base::Value> parsed =
        contents ? base::JSONReader::Read(*contents, base::JSON_PARSE_RFC)
                 : std::nullopt;
    const base::ListValue* list = parsed && parsed->is_dict()
                                      ? parsed->GetDict().FindList("agents")
                                      : nullptr;
    if (list) {
      for (const base::Value& item : *list) {
        const base::DictValue* dict = item.GetIfDict();
        const std::string* id = dict ? dict->FindString("id") : nullptr;
        const std::string* token = dict ? dict->FindString("token") : nullptr;
        if (!id || !ValidAgent(*id) || !token || token->size() < 40 ||
            Find(*id) || grants_.size() >= kMaxAgents) {
          continue;
        }
        Grant grant{
            *id, *id, *token, {}, dict->FindDouble("created").value_or(0)};
        if (const std::string* name = dict->FindString("name")) {
          grant.name = name->substr(0, kMaxName);
        }
        if (const base::ListValue* profiles = dict->FindList("profiles")) {
          grant.profiles.emplace();
          for (const base::Value& profile : *profiles) {
            if (profile.is_string() && ProfileName(profile.GetString())) {
              grant.profiles->insert(profile.GetString());
            }
          }
        }
        grants_.push_back(std::move(grant));
      }
    }
    Announce();
  }

  void Save() {
    base::ListValue agents;
    for (const Grant& grant : grants_) {
      base::DictValue item;
      item.Set("id", grant.id);
      item.Set("name", grant.name);
      item.Set("token", grant.token);
      item.Set("created", grant.created);
      if (grant.profiles) {
        base::ListValue profiles;
        for (const std::string& profile : *grant.profiles) {
          profiles.Append(profile);
        }
        item.Set("profiles", std::move(profiles));
      }
      agents.Append(std::move(item));
    }
    std::string contents =
        base::WriteJson(base::DictValue().Set("agents", std::move(agents)))
            .value_or("{}");
    Files()->PostTask(FROM_HERE,
                      base::BindOnce(
                          [](base::FilePath path, std::string contents) {
                            std::string error = WriteOwnerOnlyFile(
                                path, contents, "the coding agents file");
                            if (!error.empty()) {
                              LOG(WARNING) << "[bay] " << error;
                            }
                          },
                          path_, std::move(contents)));
  }

  void Announce() { Emit(kTopic, nullptr, Snapshot()); }

  scoped_refptr<base::SequencedTaskRunner> Files() {
    if (!files_) {
      files_ = base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
           base::TaskShutdownBehavior::BLOCK_SHUTDOWN});
    }
    return files_;
  }

  const base::FilePath path_ = GrantsPath();
  std::vector<Grant> grants_;
  std::map<std::string, Request> requests_;
  std::set<std::string> denied_;
  bool loaded_ = false;
  bool loading_ = false;
  scoped_refptr<base::SequencedTaskRunner> files_;
};

}  // namespace

void Load() {
  Agents::Get().Load();
}

std::optional<std::string> AgentForToken(std::string_view token) {
  return Agents::Get().ForToken(token);
}

bool HasAccess(const std::string& agent) {
  return Agents::Get().Find(agent) != nullptr;
}

bool Allows(const std::string& agent, content::BrowserContext* context) {
  const Grant* grant = Agents::Get().Find(agent);
  Profile* profile = context ? Profile::FromBrowserContext(context) : nullptr;
  if (!grant || !profile || profile->IsOffTheRecord()) {
    return false;
  }
  return !grant->profiles || grant->profiles->contains(
                                 profile->GetPath().BaseName().AsUTF8Unsafe());
}

base::DictValue Request(const base::DictValue& params, std::string* error) {
  return Agents::Get().RequestAccess(params, error);
}

}  // namespace cli_agents
}  // namespace bay

namespace {

std::optional<base::DictValue> Arguments(const char* args_json) {
  if (!args_json || !*args_json) {
    return base::DictValue();
  }
  std::optional<base::Value> parsed =
      base::JSONReader::Read(args_json, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_dict()) {
    return std::nullopt;
  }
  return std::move(*parsed).TakeDict();
}

}  // namespace

NN_ENGINE_CALL(nn_cli_agents) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  bay::cli_agents::Agents::Get().Load();
  bay::Reply(reply, context).Send(bay::cli_agents::Agents::Get().Snapshot());
}

NN_ENGINE_CALL(nn_cli_agent_answer) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  bay::Reply out(reply, context);
  std::optional<base::DictValue> args = Arguments(args_json);
  if (!args) {
    return out.Error("arguments are not a JSON object");
  }
  std::string error = bay::cli_agents::Agents::Get().Answer(*args);
  if (!error.empty()) {
    return out.Error(error);
  }
  out.Ok();
}

NN_ENGINE_CALL(nn_cli_agent_revoke) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  bay::Reply out(reply, context);
  std::optional<base::DictValue> args = Arguments(args_json);
  const std::string* agent = args ? args->FindString("agent") : nullptr;
  if (!agent) {
    return out.Error("agent required");
  }
  bay::cli_agents::Agents::Get().Revoke(*agent);
  out.Ok();
}
