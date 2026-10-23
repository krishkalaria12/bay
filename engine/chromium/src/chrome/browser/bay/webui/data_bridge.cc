// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/data_bridge.h"

#include <map>
#include <string>
#include <utility>

#include "base/check.h"
#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/memory/ref_counted.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/scoped_multi_source_observation.h"
#include "base/synchronization/lock.h"
#include "base/synchronization/waitable_event.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "build/build_config.h"
#include "chrome/browser/bay/data/data_services.h"
#include "chrome/browser/bay/nn_dispatch.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_observer.h"
#include "chrome/common/chrome_paths.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"

namespace bay {
namespace {
// FilePath's POSIX value is already the native byte sequence. UTF-8 helpers
// may apply locale conversions and change which filesystem object is opened.
std::string NativePath(const base::FilePath& path) {
#if BUILDFLAG(IS_WIN)
  return path.AsUTF8Unsafe();
#else
  return path.value();
#endif
}
constexpr auto kImportTimeout = base::Seconds(30);
constexpr char kUnavailable[] = "{\"error\":\"Browser engine is unavailable\"}";
struct ProfileSnapshot {
  base::Lock lock;
  std::map<std::string, data::ProfilePaths> paths GUARDED_BY(lock);
};
ProfileSnapshot& Profiles() {
  static base::NoDestructor<ProfileSnapshot> profiles;
  return *profiles;
}
class ProfileTracker : public ProfileObserver {
 public:
  void Observe(Profile* profile) {
    if (!observations_.IsObservingSource(profile))
      observations_.AddObservation(profile);
  }
  void OnProfileWillBeDestroyed(Profile* profile) override {
    const auto path = NativePath(profile->GetPath());
    base::AutoLock lock(Profiles().lock);
    std::erase_if(Profiles().paths, [&](const auto& entry) {
      return entry.second.profile_directory == path;
    });
    observations_.RemoveObservation(profile);
  }

 private:
  base::ScopedMultiSourceObservation<Profile, ProfileObserver> observations_{
      this};
};
class EngineReply : public base::RefCountedThreadSafe<EngineReply> {
 public:
  base::WaitableEvent done;
  std::string result = kUnavailable;

 private:
  friend class base::RefCountedThreadSafe<EngineReply>;
  ~EngineReply() = default;
};
// UI-only tokens keep late engine callbacks harmless after the worker times
// out.
std::map<uintptr_t, scoped_refptr<EngineReply>>& Pending() {
  static base::NoDestructor<std::map<uintptr_t, scoped_refptr<EngineReply>>>
      pending;
  return *pending;
}
void Complete(uintptr_t token, const char* json) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  auto found = Pending().find(token);
  if (found == Pending().end())
    return;
  auto reply = std::move(found->second);
  Pending().erase(found);
  reply->result = json ? json : kUnavailable;
  reply->done.Signal();
}
void Dispatch(scoped_refptr<EngineReply> reply,
              std::string name,
              std::string profile,
              std::string arguments) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  {
    base::AutoLock lock(Profiles().lock);
    const auto loaded = Profiles().paths.find(profile);
    if (loaded == Profiles().paths.end()) {
      reply->result = "{\"error\":\"Browser profile is no longer loaded\"}";
      reply->done.Signal();
      volatile char* bytes = arguments.data();
      for (size_t i = 0; i < arguments.size(); ++i)
        bytes[i] = 0;
      return;
    }
    profile = loaded->second.profile_directory;
  }
  static uintptr_t next_token = 0;
  const uintptr_t token = ++next_token;
  Pending().emplace(token, reply);
  content::GetUIThreadTaskRunner({})->PostDelayedTask(
      FROM_HERE, base::BindOnce(&Complete, token, kUnavailable),
      kImportTimeout);
  if (!DispatchEngineCall(
          name, profile.c_str(), arguments.c_str(),
          [](void* context, const char* result) {
            Complete(reinterpret_cast<uintptr_t>(context), result);
          },
          reinterpret_cast<void*>(token))) {
    Complete(token, kUnavailable);
  }
  // These JSON arguments can contain plaintext cookies and card numbers.
  volatile char* bytes = arguments.data();
  for (size_t i = 0; i < arguments.size(); ++i)
    bytes[i] = 0;
}
}  // namespace

void RegisterDataProfile(Profile* profile) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (!profile || profile->IsOffTheRecord())
    return;
  static base::NoDestructor<ProfileTracker> tracker;
  tracker->Observe(profile);
  const auto path = profile->GetPath();
  const auto basename = NativePath(path.BaseName());
  const data::ProfilePaths paths{NativePath(path.DirName()), NativePath(path)};
  base::AutoLock lock(Profiles().lock);
  Profiles().paths[basename == "Default" ? "" : basename] = paths;
  if (basename == "Default")
    Profiles().paths["Default"] = paths;
}
void InitializeDataBridge(
    base::RepeatingCallback<void(const std::string&,
                                 const std::string&,
                                 const std::string&)> events) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  static bool initialized = false;
  if (initialized)
    return;
  base::FilePath directory;
  CHECK(base::PathService::Get(chrome::DIR_USER_DATA, &directory));
  data::Configure(NativePath(directory), [](const std::string& id) {
    base::AutoLock lock(Profiles().lock);
    auto found = Profiles().paths.find(id);
    return found == Profiles().paths.end() ? data::ProfilePaths{}
                                           : found->second;
  });
  data::SetEventSink([runner = content::GetUIThreadTaskRunner({}), events](
                         const std::string& module, const std::string& event,
                         const std::string& json) {
    runner->PostTask(FROM_HERE, base::BindOnce(events, module, event, json));
  });
  data::SetEngineCall([](const std::string& name, const std::string& profile,
                         const std::string& arguments) {
    CHECK(!content::BrowserThread::CurrentlyOn(content::BrowserThread::UI));
    auto reply = base::MakeRefCounted<EngineReply>();
    if (!content::GetUIThreadTaskRunner({})->PostTask(
            FROM_HERE,
            base::BindOnce(&Dispatch, reply, name, profile, arguments)))
      return std::string(kUnavailable);
    // Only this data worker waits. Chrome's UI never waits on a data service.
    if (!reply->done.TimedWait(kImportTimeout))
      return std::string(kUnavailable);
    return reply->result;
  });
  initialized = true;
}
}  // namespace bay
