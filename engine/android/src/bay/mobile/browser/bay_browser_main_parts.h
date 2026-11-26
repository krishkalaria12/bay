// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#ifndef BAY_MOBILE_BROWSER_BAY_BROWSER_MAIN_PARTS_H_
#define BAY_MOBILE_BROWSER_BAY_BROWSER_MAIN_PARTS_H_

#include <map>
#include <memory>
#include <string>

#include "base/files/file_path.h"
#include "content/public/browser/browser_main_parts.h"

namespace bay {

class BayBrowserContext;

// The browser process's lifetime on Android: it starts with the engine and lives as long as the app's process.
// Holds the normal profile; private profiles belong to the Java BayProfile that made them.
class BayBrowserMainParts : public content::BrowserMainParts {
 public:
  BayBrowserMainParts();
  BayBrowserMainParts(const BayBrowserMainParts&) = delete;
  BayBrowserMainParts& operator=(const BayBrowserMainParts&) = delete;
  ~BayBrowserMainParts() override;

  static BayBrowserMainParts* Get();

  // The persistent profile, made on first use.
  BayBrowserContext* NormalProfile();
  // A space's persistent profile, made on first use and kept for the life of the process. `space_id` is checked on
  // the Java side: letters, digits, '-' and '_' only, so it names a directory.
  BayBrowserContext* SpaceProfile(const std::string& space_id);
  // A new in-memory profile, owned by the caller.
  std::unique_ptr<BayBrowserContext> CreatePrivateProfile();

  // Where profiles live: <app data>/app_bay_engine/v1. The version changes if the layout ever does, so an older engine
  // never opens a newer profile.
  static base::FilePath ProfilesDirectory();

  // content::BrowserMainParts:
  int PreMainMessageLoopRun() override;
  void PostMainMessageLoopRun() override;

 private:
  std::unique_ptr<BayBrowserContext> normal_profile_;
  std::map<std::string, std::unique_ptr<BayBrowserContext>> space_profiles_;
  int private_profiles_ = 0;
};

}  // namespace bay

#endif  // BAY_MOBILE_BROWSER_BAY_BROWSER_MAIN_PARTS_H_
