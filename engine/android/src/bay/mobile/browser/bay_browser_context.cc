// Copyright 2026 Bay authors. Adapted from content/shell/browser/shell_browser_context.cc, Copyright 2013 The
// Chromium Authors. Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#include "bay/mobile/browser/bay_browser_context.h"

#include "bay/mobile/browser/bay_download_manager_delegate.h"
#include "bay/mobile/browser/bay_permission_manager.h"
#include "components/autofill/core/common/autofill_prefs.h"
#include "components/keyed_service/content/browser_context_dependency_manager.h"
#include "components/keyed_service/core/simple_dependency_manager.h"
#include "components/keyed_service/core/simple_factory_key.h"
#include "components/keyed_service/core/simple_key_map.h"
#include "components/pref_registry/pref_registry_syncable.h"
#include "components/prefs/in_memory_pref_store.h"
#include "components/prefs/pref_service.h"
#include "components/prefs/pref_service_factory.h"
#include "components/user_prefs/user_prefs.h"
#include "content/public/browser/zoom_level_delegate.h"

namespace bay {

namespace {

// The prefs Android Autofill reads, as WebView registers them: it hands forms to the system's autofill service, so
// Chromium's own address and card filling stay off.
std::unique_ptr<PrefService> CreatePrefs() {
  auto registry = base::MakeRefCounted<user_prefs::PrefRegistrySyncable>();
  registry->RegisterIntegerPref(autofill::prefs::kAutocompleteLastVersionRetentionPolicy, 0);
  registry->RegisterBooleanPref(autofill::prefs::kAutofillProfileEnabled, false);
  registry->RegisterBooleanPref(autofill::prefs::kAutofillCreditCardEnabled, false);
  PrefServiceFactory factory;
  factory.set_user_prefs(base::MakeRefCounted<InMemoryPrefStore>());
  return factory.Create(std::move(registry));
}

}  // namespace

BayBrowserContext::BayBrowserContext(const base::FilePath& path, bool off_the_record)
    : path_(path), off_the_record_(off_the_record) {
  prefs_ = CreatePrefs();
  user_prefs::UserPrefs::Set(this, prefs_.get());
  key_ = std::make_unique<SimpleFactoryKey>(path_, off_the_record_);
  SimpleKeyMap::GetInstance()->Associate(this, key_.get());
  BrowserContextDependencyManager::GetInstance()->CreateBrowserContextServices(this);
}

BayBrowserContext::~BayBrowserContext() {
  NotifyWillBeDestroyed();
  DependencyManager::PerformInterlockedTwoPhaseShutdown(BrowserContextDependencyManager::GetInstance(), this,
                                                        SimpleDependencyManager::GetInstance(), key_.get());
  SimpleKeyMap::GetInstance()->Dissociate(this);
  ShutdownStoragePartitions();
}

base::FilePath BayBrowserContext::GetPath() const {
  return path_;
}

std::unique_ptr<content::ZoomLevelDelegate> BayBrowserContext::CreateZoomLevelDelegate(const base::FilePath&) {
  // Page zoom is Bay's own per-site text size, applied by the app.
  return nullptr;
}

bool BayBrowserContext::IsOffTheRecord() {
  return off_the_record_;
}

content::DownloadManagerDelegate* BayBrowserContext::GetDownloadManagerDelegate() {
  if (!download_delegate_) {
    download_delegate_ = std::make_unique<BayDownloadManagerDelegate>(GetDownloadManager());
  }
  return download_delegate_.get();
}

content::BrowserPluginGuestManager* BayBrowserContext::GetGuestManager() {
  return nullptr;
}

storage::SpecialStoragePolicy* BayBrowserContext::GetSpecialStoragePolicy() {
  return nullptr;
}

content::PlatformNotificationService* BayBrowserContext::GetPlatformNotificationService() {
  // Web notifications aren't offered (BayPermissionManager denies them).
  return nullptr;
}

content::PushMessagingService* BayBrowserContext::GetPushMessagingService() {
  return nullptr;
}

content::StorageNotificationService* BayBrowserContext::GetStorageNotificationService() {
  return nullptr;
}

content::SSLHostStateDelegate* BayBrowserContext::GetSSLHostStateDelegate() {
  // No certificate-error bypass: a page with a bad certificate shows Bay's error screen.
  return nullptr;
}

content::PermissionControllerDelegate* BayBrowserContext::GetPermissionControllerDelegate() {
  if (!permission_manager_) {
    permission_manager_ = std::make_unique<BayPermissionManager>();
  }
  return permission_manager_.get();
}

content::ReduceAcceptLanguageControllerDelegate* BayBrowserContext::GetReduceAcceptLanguageControllerDelegate() {
  return nullptr;
}

content::ClientHintsControllerDelegate* BayBrowserContext::GetClientHintsControllerDelegate() {
  return nullptr;
}

content::BackgroundFetchDelegate* BayBrowserContext::GetBackgroundFetchDelegate() {
  return nullptr;
}

content::BackgroundSyncController* BayBrowserContext::GetBackgroundSyncController() {
  return nullptr;
}

content::BrowsingDataRemoverDelegate* BayBrowserContext::GetBrowsingDataRemoverDelegate() {
  return nullptr;
}

}  // namespace bay
