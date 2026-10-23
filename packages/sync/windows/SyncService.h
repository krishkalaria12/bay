#pragma once
#include <cstdint>
#include <filesystem>
#include <functional>
#include <string>
#include <utility>
#include <vector>
namespace bay::sync {
// The host resolves only loaded, non-private profiles. Empty paths are refused.
using ProfileResolver =
    std::function<std::pair<std::filesystem::path, std::filesystem::path>(
        const std::string &)>;
void SetDataDirectory(std::string directory);
void SetProfileResolver(ProfileResolver resolver);
// Host-only continuation after an asynchronous native save dialog.
// Returns a contract envelope and catches all exceptions before Chromium.
std::uint64_t RecoveryKeyGeneration() noexcept;
std::string SaveRecoveryKitToPath(const std::string &format,
                                  const std::string &path,
                                  std::uint64_t expectedGeneration);
#if defined(__linux__)
void copyRecoveryPhraseText(const std::string &text);
void revealSyncFolder(const std::filesystem::path &path);
void writeRecoveryKitFile(const std::filesystem::path &path,
                          const std::string &content);
#endif
inline constexpr char kModuleName[] = "BaySync";
const std::vector<std::string> &MethodNames();
bool RequiresUIThread(const std::string &method);
std::string InvokeEnvelope(const std::string &method,
                           const std::string &argsJson);
std::string Invoke(const std::string &module, const std::string &method,
                   const std::string &argsJson);
} // namespace bay::sync
