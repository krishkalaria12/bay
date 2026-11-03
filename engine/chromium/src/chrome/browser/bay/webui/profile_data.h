// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_PROFILE_DATA_H_
#define CHROME_BROWSER_BAY_WEBUI_PROFILE_DATA_H_

#include <string>

#include "base/functional/callback.h"
#include "base/values.h"

namespace bay {

// BayCEF.deleteProfileData on the web desktop host, as macOS NNCoreHost and
// NNCoreProfileData do it. A space's own profile goes with Chrome's profile
// deletion (its browsers close, its folder goes, at the latest when Chrome
// next starts). Chrome's Default profile backs the coordinator and private
// windows, so it stays: its data goes store by store through the engine, each
// store listed again afterwards. Extensions are turned off, not removed:
// Chrome confirms every removal that doesn't come from its own UI.
class ProfileData {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  // An engine call: name, Bay profile id, arguments; replies a wire envelope.
  using EngineInvoker = base::RepeatingCallback<
      void(const std::string&, const std::string&, base::DictValue, Response)>;

  // Replies {remaining: [what couldn't be deleted]}: empty once it's gone.
  static void Delete(const EngineInvoker& engine,
                     const std::string& profile,
                     Response response);

  // The labels of the Default profile's stores, in the order they're cleared.
  static const char* const kDefaultStores[8];
};

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_PROFILE_DATA_H_
