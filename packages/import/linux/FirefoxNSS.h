#pragma once
#include "../windows/ImportCore.h"
namespace bay::importer {
Json firefoxLoginsLinux(const Path &profile, const std::string &password,
                        const std::atomic_bool &cancelled);
} // namespace bay::importer
