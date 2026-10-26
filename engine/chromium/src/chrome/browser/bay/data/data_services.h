// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_DATA_DATA_SERVICES_H_
#define CHROME_BROWSER_BAY_DATA_DATA_SERVICES_H_

#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace bay::data {
// UTF-8 on Windows; native, byte-preserving filesystem paths on POSIX.
struct ProfilePaths {
  std::string user_data_directory;
  std::string profile_directory;
};
// Resolve a Bay profile identifier only to an already loaded, non-private
// Chromium profile. The resolver may marshal to the browser UI thread.
using ProfileResolver = std::function<ProfilePaths(const std::string&)>;
using EventSink = std::function<void(const std::string& module,
                                     const std::string& event,
                                     const std::string& payload)>;
// Called from a worker. Marshal the engine call to the browser UI thread and
// return its domain JSON reply. Never forward or log these arguments: they can
// contain cookie values or card numbers. Bound the wait if Chrome is closing.
using EngineCall = std::function<std::string(const std::string& name,
                                             const std::string& profile,
                                             const std::string& arguments)>;
void Configure(std::string data_directory, ProfileResolver resolve_profile);
void SetEventSink(EventSink sink);
void SetEngineCall(EngineCall engine_call);
// Installed once the browser's async crypt providers are ready. The callback
// is thread-safe and returns no plaintext when a key or ciphertext is invalid.
using PasswordDecryptor =
    std::function<std::optional<std::string>(const std::string&)>;
void SetPasswordDecryptor(PasswordDecryptor decryptor);
const std::vector<std::string>& ModuleNames();
const std::vector<std::string>& MethodNames(const std::string& module);
bool RequiresUIThread(const std::string& module, const std::string& method);
// Returns a contract v2 envelope: {value:T} or {error:{code,message}}.
// This function catches all service exceptions before returning to Chromium.
std::string Invoke(const std::string& module,
                   const std::string& method,
                   const std::string& arguments);
}  // namespace bay::data
#endif  // CHROME_BROWSER_BAY_DATA_DATA_SERVICES_H_
