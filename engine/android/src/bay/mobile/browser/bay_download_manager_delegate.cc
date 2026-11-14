// Copyright 2026 Bay authors. Adapted from content/shell/browser/shell_download_manager_delegate.cc, Copyright 2012
// The Chromium Authors. Use of this source code is governed by a BSD-style license that can be found in the LICENSE
// file.

#include "bay/mobile/browser/bay_download_manager_delegate.h"

#include <set>
#include <utility>

#include "base/android/jni_android.h"
#include "base/android/jni_string.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/task/thread_pool.h"
#include "components/download/public/common/download_interrupt_reasons.h"
#include "components/download/public/common/download_target_info.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/download_manager.h"
#include "net/base/filename_util.h"

// Must come after the headers above.
#include "bay/mobile/jni_headers/BayDownloads_jni.h"

using base::android::AttachCurrentThread;
using base::android::ConvertJavaStringToUTF8;
using base::android::ConvertUTF8ToJavaString;
using base::android::JavaRef;

namespace bay {

namespace {

std::set<BayDownloadManagerDelegate*>& Delegates() {
  static base::NoDestructor<std::set<BayDownloadManagerDelegate*>> delegates;
  return *delegates;
}

// Where downloads are written while they run: the app's cache, one directory per download so two files with the
// same name never meet. The app moves each finished file out (BayDownloader on the app side).
base::FilePath ChooseTarget(const std::string& guid,
                            const GURL& url,
                            const std::string& content_disposition,
                            const std::string& suggested_filename,
                            const std::string& mime_type) {
  base::FilePath cache;
  if (!base::PathService::Get(base::DIR_CACHE, &cache)) {
    return base::FilePath();
  }
  const base::FilePath directory = cache.Append("bay-engine-downloads").AppendASCII(guid);
  if (!base::CreateDirectory(directory)) {
    return base::FilePath();
  }
  return directory.Append(
      net::GenerateFileName(url, content_disposition, std::string(), suggested_filename, mime_type, "download"));
}

// What the person reads when a download stops early.
std::string FailureMessage(download::DownloadInterruptReason reason) {
  switch (reason) {
    case download::DOWNLOAD_INTERRUPT_REASON_FILE_NO_SPACE:
      return "There isn't enough storage for this download.";
    case download::DOWNLOAD_INTERRUPT_REASON_NETWORK_DISCONNECTED:
      return "No connection.";
    case download::DOWNLOAD_INTERRUPT_REASON_NETWORK_TIMEOUT:
      return "The site stopped responding.";
    case download::DOWNLOAD_INTERRUPT_REASON_NETWORK_FAILED:
    case download::DOWNLOAD_INTERRUPT_REASON_NETWORK_SERVER_DOWN:
      return "The connection dropped before the download finished.";
    case download::DOWNLOAD_INTERRUPT_REASON_SERVER_UNAUTHORIZED:
    case download::DOWNLOAD_INTERRUPT_REASON_SERVER_FORBIDDEN:
    case download::DOWNLOAD_INTERRUPT_REASON_SERVER_BAD_CONTENT:
    case download::DOWNLOAD_INTERRUPT_REASON_SERVER_FAILED:
      return "The site refused the download.";
    default:
      return "The download failed.";
  }
}

}  // namespace

BayDownloadManagerDelegate::BayDownloadManagerDelegate(content::DownloadManager* download_manager)
    : download_manager_(download_manager) {
  Delegates().insert(this);
}

BayDownloadManagerDelegate::~BayDownloadManagerDelegate() {
  Delegates().erase(this);
  // The profile goes before its download manager does, which must not call back into this.
  if (download_manager_) {
    download_manager_->SetDelegate(nullptr);
    download_manager_ = nullptr;
  }
}

// static
void BayDownloadManagerDelegate::Cancel(const std::string& guid) {
  for (BayDownloadManagerDelegate* delegate : Delegates()) {
    if (!delegate->download_manager_) {
      continue;
    }
    if (download::DownloadItem* item = delegate->download_manager_->GetDownloadByGuid(guid)) {
      item->Cancel(/*user_cancel=*/true);
      return;
    }
  }
}

void BayDownloadManagerDelegate::Shutdown() {
  weak_factory_.InvalidateWeakPtrs();
  observations_.RemoveAllObservations();
  download_manager_ = nullptr;
}

bool BayDownloadManagerDelegate::DetermineDownloadTarget(download::DownloadItem* item,
                                                         download::DownloadTargetCallback* callback) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (!item->GetForcedFilePath().empty()) {
    download::DownloadTargetInfo target;
    target.target_path = item->GetForcedFilePath();
    target.intermediate_path = item->GetForcedFilePath();
    std::move(*callback).Run(std::move(target));
    return true;
  }
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN, base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&ChooseTarget, item->GetGuid(), item->GetURL(), item->GetContentDisposition(),
                     item->GetSuggestedFilename(), item->GetMimeType()),
      base::BindOnce(&BayDownloadManagerDelegate::OnTargetChosen, weak_factory_.GetWeakPtr(), item->GetGuid(),
                     std::move(*callback)));
  return true;
}

void BayDownloadManagerDelegate::OnTargetChosen(const std::string& guid,
                                                download::DownloadTargetCallback callback,
                                                const base::FilePath& target_path) {
  download::DownloadItem* item = download_manager_ ? download_manager_->GetDownloadByGuid(guid) : nullptr;
  download::DownloadTargetInfo target;
  if (!item || target_path.empty()) {
    // No file to write: the download fails at once (an empty target interrupts it).
    target.interrupt_reason = download::DOWNLOAD_INTERRUPT_REASON_FILE_FAILED;
    std::move(callback).Run(std::move(target));
    return;
  }
  target.target_path = target_path;
  target.intermediate_path = target_path.AddExtension(FILE_PATH_LITERAL(".crdownload"));
  target.target_disposition = download::DownloadItem::TARGET_DISPOSITION_OVERWRITE;
  JNIEnv* env = AttachCurrentThread();
  Java_BayDownloads_onStarted(env, ConvertUTF8ToJavaString(env, guid),
                              ConvertUTF8ToJavaString(env, item->GetURL().spec()),
                              ConvertUTF8ToJavaString(env, target_path.BaseName().value()),
                              ConvertUTF8ToJavaString(env, item->GetMimeType()), item->GetTotalBytes(),
                              download_manager_->GetBrowserContext()->IsOffTheRecord());
  if (!observations_.IsObservingSource(item)) {
    observations_.AddObservation(item);
  }
  std::move(callback).Run(std::move(target));
}

void BayDownloadManagerDelegate::GetNextId(content::DownloadIdCallback callback) {
  // Ids only need to be unique while the app runs: Bay keeps no download history of its own here.
  static uint32_t next_id = download::DownloadItem::kInvalidId + 1;
  std::move(callback).Run(next_id++);
}

void BayDownloadManagerDelegate::OnDownloadUpdated(download::DownloadItem* item) {
  JNIEnv* env = AttachCurrentThread();
  auto guid = ConvertUTF8ToJavaString(env, item->GetGuid());
  switch (item->GetState()) {
    case download::DownloadItem::IN_PROGRESS:
      Java_BayDownloads_onProgress(env, guid, item->GetReceivedBytes(), item->GetTotalBytes());
      return;
    case download::DownloadItem::COMPLETE:
      Java_BayDownloads_onFinished(env, guid, ConvertUTF8ToJavaString(env, item->GetTargetFilePath().value()),
                                   ConvertUTF8ToJavaString(env, item->GetMimeType()));
      break;
    case download::DownloadItem::CANCELLED:
      Java_BayDownloads_onCancelled(env, guid);
      break;
    case download::DownloadItem::INTERRUPTED:
      // Downloads aren't resumed later: an interrupted one has failed.
      Java_BayDownloads_onFailed(env, guid, ConvertUTF8ToJavaString(env, FailureMessage(item->GetLastReason())));
      break;
    case download::DownloadItem::MAX_DOWNLOAD_STATE:
      return;
  }
  observations_.RemoveObservation(item);
}

void BayDownloadManagerDelegate::OnDownloadDestroyed(download::DownloadItem* item) {
  observations_.RemoveObservation(item);
}

static void JNI_BayDownloads_Cancel(JNIEnv* env, const JavaRef<jstring>& id) {
  BayDownloadManagerDelegate::Cancel(ConvertJavaStringToUTF8(env, id));
}

}  // namespace bay

DEFINE_JNI(BayDownloads)
