// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_DATA_BRIDGE_H_
#define CHROME_BROWSER_BAY_WEBUI_DATA_BRIDGE_H_

#include <string>

#include "base/functional/callback.h"

class Profile;
namespace bay {
// Call on the browser UI thread. Profiles are snapshotted as native paths so a
// data worker never dereferences a Chrome Profile or waits for a UI lookup.
void RegisterDataProfile(Profile* profile);
void InitializeDataBridge(
    base::RepeatingCallback<void(const std::string&,
                                 const std::string&,
                                 const std::string&)> events);
}  // namespace bay
#endif
