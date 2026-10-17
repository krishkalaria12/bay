#pragma once
#include <string>
#include <vector>
namespace bay::sync {
inline constexpr char kModuleName[] = "BaySync";
const std::vector<std::string> &MethodNames();
bool RequiresUIThread(const std::string &method);
std::string InvokeEnvelope(const std::string &method,
                           const std::string &argsJson);
std::string Invoke(const std::string &module, const std::string &method,
                   const std::string &argsJson);
} // namespace bay::sync
