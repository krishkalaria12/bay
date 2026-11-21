// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_KEYCHAIN_H_
#define CHROME_BROWSER_BAY_WEBUI_KEYCHAIN_H_

#include <cstdint>
#include <map>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/sequence_checker.h"
#include "base/values.h"
#include "chrome/browser/bay/webui/host_context.h"

namespace bay {
// Connected-account credentials are per OS user, independent of the browser
// profile. Synchronous native secret stores run on one shared MayBlock queue.
class Keychain final {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  // Test backends run on the worker and must be safe to destroy on either
  // sequence. They return the native value/error envelope and never touch UI.
  using Operation = base::RepeatingCallback<
      std::string(const std::string&, const std::string&, std::string)>;
  explicit Keychain(HostContext context, Operation operation = {});
  ~Keychain();
  Keychain(const Keychain&) = delete;
  Keychain& operator=(const Keychain&) = delete;

  static base::ListValue SupportedMethods();
  bool Dispatch(const std::string& module,
                const std::string& method,
                const base::ListValue& args,
                Response& callback);

 private:
  // Defined by the platform backend. Linux never falls back to a disk file.
  static std::string Credential(const std::string& method,
                                const std::string& account,
                                std::string secret);
  void Complete(uint64_t request, std::string response);
  void Settle(uint64_t request, std::string response);

  const HostContext context_;
  const Operation operation_;
  uint64_t next_request_ = 0;
  std::map<uint64_t, Response> pending_;
  SEQUENCE_CHECKER(sequence_checker_);
  base::WeakPtrFactory<Keychain> weak_factory_{this};
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_KEYCHAIN_H_
