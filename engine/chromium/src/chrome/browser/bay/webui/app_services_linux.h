// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_APP_SERVICES_LINUX_H_
#define CHROME_BROWSER_BAY_WEBUI_APP_SERVICES_LINUX_H_

#include <optional>
#include <string>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/sequence_checker.h"
#include "base/values.h"
#include "chrome/browser/bay/webui/host_context.h"

class GURL;

namespace bay {
// Document-owned UI-sequence BayApp operations, authorized for either host
// role. Prepare finishes all blocking OS/hardware reads before publishing
// snapshots.
class AppServicesLinux {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  using SystemInfoReply = base::OnceCallback<void(base::DictValue)>;
  struct Operations {
    // Starts on UI, replies on UI with osVersion/osBuild/arch/model/memoryGB.
    // The native collector performs blocking reads on ThreadPool workers.
    base::RepeatingCallback<void(SystemInfoReply)> collect_system_info;
    // Only the eight debug allowlisted keys are queried; never used in release.
    base::RepeatingCallback<std::optional<std::string>(const char*)>
        read_environment;
    // UI submission only, with no desktop acceptance/completion signal.
    base::RepeatingCallback<void(const GURL&)> open_external_url;
  };
  AppServicesLinux(HostContext context, std::string locale);
  AppServicesLinux(HostContext context,
                   std::string locale,
                   Operations operations);
  ~AppServicesLinux();
  AppServicesLinux(const AppServicesLinux&) = delete;
  AppServicesLinux& operator=(const AppServicesLinux&) = delete;

  static base::ListValue SupportedMethods();
  // Concurrent/reentrant callers share one collection. Pending readiness
  // closures are cancelled on teardown; late collector replies are ignored.
  void Prepare(base::OnceClosure ready);
  bool ready() const;
  // A cloned BayApp dictionary, without an outer BayApp key. Empty until ready.
  base::DictValue snapshots() const;
  // Unhandled methods leave callback untouched; handled calls settle once.
  bool Dispatch(const std::string& module,
                const std::string& method,
                const base::ListValue& args,
                Response& callback);

 private:
  void Prepared(base::DictValue system_info);

  const HostContext context_;
  const std::string locale_;
  Operations operations_;
  base::DictValue environment_;
  base::DictValue snapshots_;
  bool preparing_ = false;
  bool ready_ = false;
  std::vector<base::OnceClosure> ready_callbacks_;
  SEQUENCE_CHECKER(sequence_checker_);
  base::WeakPtrFactory<AppServicesLinux> weak_factory_{this};
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_APP_SERVICES_LINUX_H_
