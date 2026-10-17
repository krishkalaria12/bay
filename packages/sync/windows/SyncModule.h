#pragma once
#include <string>
namespace bay::sync {
std::string Invoke(const std::string &module, const std::string &method,
                   const std::string &argsJson);
}
