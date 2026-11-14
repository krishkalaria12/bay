// Copyright 2026 Bay authors. Adapted from content/shell/browser/shell_download_manager_delegate.h, Copyright 2012 The
// Chromium Authors. Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#ifndef BAY_MOBILE_BROWSER_BAY_DOWNLOAD_MANAGER_DELEGATE_H_
#define BAY_MOBILE_BROWSER_BAY_DOWNLOAD_MANAGER_DELEGATE_H_

#include <string>

#include "base/files/file_path.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_multi_source_observation.h"
#include "components/download/public/common/download_item.h"
#include "content/public/browser/download_manager_delegate.h"

namespace content {
class DownloadManager;
}  // namespace content

namespace bay {

// Downloads in one profile. Chromium fetches them itself, with the page's cookies, so blob:, data: and POST downloads
// work like any other, into a file in the app's cache. The app hears of each one (org.bay.engine.BayDownloads), shows
// its progress and moves the finished file into the person's Downloads.
class BayDownloadManagerDelegate : public content::DownloadManagerDelegate, public download::DownloadItem::Observer {
 public:
  explicit BayDownloadManagerDelegate(content::DownloadManager* download_manager);
  BayDownloadManagerDelegate(const BayDownloadManagerDelegate&) = delete;
  BayDownloadManagerDelegate& operator=(const BayDownloadManagerDelegate&) = delete;
  ~BayDownloadManagerDelegate() override;

  // Cancels the download with this id (its GUID) in whichever profile has it.
  static void Cancel(const std::string& guid);

  // content::DownloadManagerDelegate:
  void Shutdown() override;
  bool DetermineDownloadTarget(download::DownloadItem* item, download::DownloadTargetCallback* callback) override;
  void GetNextId(content::DownloadIdCallback callback) override;

  // download::DownloadItem::Observer:
  void OnDownloadUpdated(download::DownloadItem* item) override;
  void OnDownloadDestroyed(download::DownloadItem* item) override;

 private:
  void OnTargetChosen(const std::string& guid,
                      download::DownloadTargetCallback callback,
                      const base::FilePath& target_path);

  raw_ptr<content::DownloadManager> download_manager_;
  base::ScopedMultiSourceObservation<download::DownloadItem, download::DownloadItem::Observer> observations_{this};
  base::WeakPtrFactory<BayDownloadManagerDelegate> weak_factory_{this};
};

}  // namespace bay

#endif  // BAY_MOBILE_BROWSER_BAY_DOWNLOAD_MANAGER_DELEGATE_H_
