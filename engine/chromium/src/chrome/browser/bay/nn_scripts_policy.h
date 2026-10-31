// Copyright 2026 Bay. Apache-2.0.

#ifndef CHROME_BROWSER_BAY_NN_SCRIPTS_POLICY_H_
#define CHROME_BROWSER_BAY_NN_SCRIPTS_POLICY_H_

#include <optional>
#include <string>

#include "base/functional/callback_helpers.h"

class Profile;

namespace base {
class FilePath;
}

namespace content {
class NavigationThrottleRegistry;
}

namespace extensions {
class Extension;
class ManagementPolicy;
}

namespace bay {

void RegisterManagementPolicyProviders(Profile* profile,
                                       extensions::ManagementPolicy* policy);

void AddScriptsPagesThrottle(content::NavigationThrottleRegistry& registry);

bool NamesScriptsFolder(const base::FilePath& path);

std::optional<std::string> ScriptsFolderInstallProblem(
    const base::FilePath& path);

base::FilePath ScriptsFolder();

base::ScopedClosureRunner BeginScriptsInstall();

}

#endif
