#pragma once
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
inline constexpr char kModuleName[] = "BaySync";
const std::vector<std::string> &MethodNames();
bool RequiresUIThread(const std::string &method);
std::string InvokeEnvelope(const std::string &method,
                           const std::string &argsJson);
std::string Invoke(const std::string &module, const std::string &method,
                   const std::string &argsJson);
} // namespace bay::sync
