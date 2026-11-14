// Copyright 2026 Bay authors. Adapted from content/shell/browser/shell_browser_context.h, Copyright 2013 The Chromium
// Authors. Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#ifndef BAY_MOBILE_BROWSER_BAY_BROWSER_CONTEXT_H_
#define BAY_MOBILE_BROWSER_BAY_BROWSER_CONTEXT_H_

#include <memory>

#include "base/files/file_path.h"
#include "content/public/browser/browser_context.h"

class PrefService;
class SimpleFactoryKey;

namespace bay {

class BayDownloadManagerDelegate;
class BayPermissionManager;

// One browsing session's storage. The normal profile keeps cookies, site storage and the HTTP cache on disk under
// the app's data directory; a private profile is off the record and keeps everything in memory, so it ends with its
// last page (BayProfile on the Java side owns its lifetime).
class BayBrowserContext : public content::BrowserContext {
 public:
  // `path` is where a normal profile keeps its data; a private profile never writes there.
  BayBrowserContext(const base::FilePath& path, bool off_the_record);
  BayBrowserContext(const BayBrowserContext&) = delete;
  BayBrowserContext& operator=(const BayBrowserContext&) = delete;
  ~BayBrowserContext() override;

  // content::BrowserContext:
  base::FilePath GetPath() const override;
  std::unique_ptr<content::ZoomLevelDelegate> CreateZoomLevelDelegate(const base::FilePath& partition_path) override;
  bool IsOffTheRecord() override;
  content::DownloadManagerDelegate* GetDownloadManagerDelegate() override;
  content::BrowserPluginGuestManager* GetGuestManager() override;
  storage::SpecialStoragePolicy* GetSpecialStoragePolicy() override;
  content::PlatformNotificationService* GetPlatformNotificationService() override;
  content::PushMessagingService* GetPushMessagingService() override;
  content::StorageNotificationService* GetStorageNotificationService() override;
  content::SSLHostStateDelegate* GetSSLHostStateDelegate() override;
  content::PermissionControllerDelegate* GetPermissionControllerDelegate() override;
  content::ReduceAcceptLanguageControllerDelegate* GetReduceAcceptLanguageControllerDelegate() override;
  content::ClientHintsControllerDelegate* GetClientHintsControllerDelegate() override;
  content::BackgroundFetchDelegate* GetBackgroundFetchDelegate() override;
  content::BackgroundSyncController* GetBackgroundSyncController() override;
  content::BrowsingDataRemoverDelegate* GetBrowsingDataRemoverDelegate() override;

 private:
  const base::FilePath path_;
  const bool off_the_record_;
  std::unique_ptr<SimpleFactoryKey> key_;
  // In memory, for the components that read prefs (Android Autofill): Bay keeps its settings in the app.
  std::unique_ptr<PrefService> prefs_;
  std::unique_ptr<BayDownloadManagerDelegate> download_delegate_;
  std::unique_ptr<BayPermissionManager> permission_manager_;
};

}  // namespace bay

#endif  // BAY_MOBILE_BROWSER_BAY_BROWSER_CONTEXT_H_
