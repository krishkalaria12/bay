// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_AUTOSTART_LINUX_H_
#define CHROME_BROWSER_BAY_WEBUI_AUTOSTART_LINUX_H_

#include <cstdint>
#include <map>
#include <optional>
#include <string>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/sequence_checker.h"
#include "base/values.h"
#include "chrome/browser/bay/webui/host_context.h"

namespace bay {
// Document-owned, UI-sequence service. Autostart is per OS user, independent
// of the assigned profile. Workers never receive a Profile or renderer paths.
class Autostart final {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  struct Paths {
    std::optional<std::string> config_home;
    std::optional<std::string> home;
    base::FilePath executable;
  };
  enum class Result {
    kSuccess,
    kEnabled,
    kNotRegistered,
    kNotFound,
    kConfigError,
    kConflict,
    kPathError,
    kWriteError,
  };
  // Test seams run on the shared MayBlock sequence. Empty callbacks select
  // native environment/wrapper resolution and descriptor-relative file IO.
  // Callbacks and captured state must be safe to destroy on that sequence.
  struct Operations {
    base::RepeatingCallback<Paths()> paths;
    base::RepeatingCallback<Result(const Paths&, std::optional<bool>)> update;
  };
  explicit Autostart(HostContext context);
  Autostart(HostContext context, Operations operations);
  ~Autostart();
  Autostart(const Autostart&) = delete;
  Autostart& operator=(const Autostart&) = delete;

  static base::ListValue SupportedMethods();
  // Unhandled requests leave callback untouched. Accepted work can outlive
  // this owner; teardown settles pending responses once and cancels replies.
  bool Dispatch(const std::string& module,
                const std::string& method,
                const base::ListValue& args,
                Response& callback);

 private:
  void Complete(uint64_t request, Result result);
  void Settle(uint64_t request, std::string response);

  const HostContext context_;
  const Operations operations_;
  uint64_t next_request_ = 0;
  std::map<uint64_t, Response> pending_;
  SEQUENCE_CHECKER(sequence_checker_);
  base::WeakPtrFactory<Autostart> weak_factory_{this};
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_AUTOSTART_LINUX_H_
