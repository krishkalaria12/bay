// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/nn_extension_import.h"

#include <algorithm>
#include <map>
#include <memory>
#include <string>
#include <utility>

#include "base/files/file.h"
#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "chrome/browser/extensions/extension_util.h"
#include "components/crx_file/id_util.h"
#include "components/prefs/pref_service.h"
#include "components/value_store/leveldb_value_store.h"
#include "components/version_info/version_info.h"
#include "content/public/browser/storage_partition.h"
#include "extensions/browser/api/storage/storage_area_namespace.h"
#include "extensions/browser/api/storage/storage_frontend.h"
#include "extensions/browser/api/storage/storage_utils.h"
#include "extensions/browser/crx_file_info.h"
#include "extensions/browser/crx_installer.h"
#include "extensions/browser/disable_reason.h"
#include "extensions/browser/extension_prefs.h"
#include "extensions/browser/extension_registrar.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/browser/install/crx_install_error.h"
#include "extensions/browser/unpacked_installer.h"
#include "extensions/common/extension.h"
#include "extensions/common/file_util.h"
#include "extensions/common/verifier_formats.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "url/gurl.h"

namespace bay {
namespace {
constexpr char kPending[] = "bay_pending_import";
constexpr char kProvenance[] = "bay_import_source";
using extensions::Extension;
using extensions::StorageAreaNamespace;

scoped_refptr<base::SequencedTaskRunner> SnapshotRunner() {
  // POSIX locks belong to a process. Serialize source snapshots across spaces
  // so two imports cannot release one another's lock on the same database.
  static base::NoDestructor<scoped_refptr<base::SequencedTaskRunner>> runner(
      base::ThreadPool::CreateSequencedTaskRunner({base::MayBlock()}));
  return *runner;
}

struct Snapshot {
  std::string id;
  base::DictValue local;
  base::DictValue sync;
  base::DictValue grants;
  base::ListValue warnings;
  std::string error;
};

// LevelDB may recover or rewrite files when opened. Only open a private clone,
// copied while holding the source's database lock. Never open the source DB.
bool ContainsLinks(const base::FilePath& path) {
  if (base::IsLink(path))
    return true;
  base::FileEnumerator files(path, true,
                             base::FileEnumerator::FILES |
                                 base::FileEnumerator::DIRECTORIES |
                                 base::FileEnumerator::SHOW_SYM_LINKS);
  for (auto current = files.Next(); !current.empty(); current = files.Next()) {
    if (base::IsLink(current))
      return true;
  }
  return false;
}

base::DictValue ReadSnapshot(const base::FilePath& source,
                             const base::FilePath& profile_root,
                             base::ListValue& warnings) {
  if (!base::DirectoryExists(source))
    return {};
  const auto canonical = base::MakeAbsoluteFilePath(source);
  if (canonical.empty() || !profile_root.IsParent(canonical) ||
      ContainsLinks(source)) {
    warnings.Append(
        "Settings snapshot skipped: database must stay inside the source "
        "profile without symlinks");
    return {};
  }
  // FLAG_OPEN never creates or truncates the source LOCK. Chromium's LevelDB
  // and base::File use the same POSIX fcntl lock, so this rejects a live DB.
  base::File lock(source.AppendASCII("LOCK"),
                  base::File::FLAG_OPEN | base::File::FLAG_READ |
                      base::File::FLAG_WRITE | base::File::FLAG_NO_FOLLOW);
  if (!lock.IsValid() ||
      lock.Lock(base::File::LockMode::kExclusive) != base::File::FILE_OK) {
    warnings.Append(
        "Close the source browser and import again to copy its settings");
    return {};
  }
  base::ScopedTempDir temp;
  const bool copied =
      temp.CreateUniqueTempDir() &&
      base::CopyDirectory(source, temp.GetPath().AppendASCII("settings"), true);
  lock.Unlock();
  if (!copied) {
    warnings.Append("Could not snapshot extension settings");
    return {};
  }
  value_store::LeveldbValueStore store("Extensions",
                                       temp.GetPath().AppendASCII("settings"));
  auto result = store.Get();
  if (!result.status().ok() ||
      result.status().restore_status != value_store::ValueStore::RESTORE_NONE) {
    warnings.Append(
        "Settings snapshot was unreadable or required recovery; skipped");
    return {};
  }
  return result.PassSettings();
}

const Extension* FindImported(Profile* profile,
                              const std::string& id,
                              const std::string& source_id,
                              const base::FilePath& source_profile) {
  auto* registry = extensions::ExtensionRegistry::Get(profile);
  if (const auto* existing = registry->GetExtensionById(
          id, extensions::ExtensionRegistry::EVERYTHING))
    return existing;
  auto* prefs = extensions::ExtensionPrefs::Get(profile);
  for (const auto& candidate : registry->GenerateInstalledExtensionsSet()) {
    const auto* source = prefs->ReadPrefAsDict(candidate->id(), kProvenance);
    if (source && source->FindString("id") && source->FindString("profile") &&
        *source->FindString("id") == source_id &&
        *source->FindString("profile") == source_profile.value())
      return candidate.get();
  }
  return nullptr;
}

Snapshot Stage(std::string id,
               std::string source_id,
               base::FilePath source,
               base::FilePath path,
               bool store,
               bool firefox) {
  Snapshot result;
  result.id = id;
  const auto profile_root = base::MakeAbsoluteFilePath(source);
  if (profile_root.empty() || !base::DirectoryExists(profile_root)) {
    result.error = "Source profile directory does not exist";
    return result;
  }
  if (!store) {
    if (ContainsLinks(path)) {
      result.error = "Prepared extension must not contain symlinks";
      return result;
    }
    std::u16string error;
    auto extension = extensions::file_util::LoadExtension(
        path, extensions::mojom::ManifestLocation::kUnpacked,
        Extension::NO_FLAGS, &error);
    if (!extension) {
      result.error = "Could not validate the prepared extension";
      return result;
    }
    if (!id.empty() && id != extension->id()) {
      result.error = "Prepared extension ID does not match the expected ID";
      return result;
    }
    result.id = extension->id();
  }
  if (firefox || !crx_file::id_util::IdIsValid(source_id)) {
    result.warnings.Append(
        "Firefox settings use a different storage format and were not copied");
    return result;
  }
  for (const char* name : {"Preferences", "Secure Preferences"}) {
    std::string json;
    const auto preference_path = source.AppendASCII(name);
    const auto canonical = base::MakeAbsoluteFilePath(preference_path);
    if (canonical.empty() || !profile_root.IsParent(canonical) ||
        base::IsLink(preference_path) ||
        !base::ReadFileToString(preference_path, &json))
      continue;
    auto value =
        base::JSONReader::Read(json, base::JSON_PARSE_CHROMIUM_EXTENSIONS);
    if (!value || !value->is_dict())
      continue;
    const auto* settings =
        value->GetDict().FindDictByDottedPath("extensions.settings");
    const auto* entry = settings ? settings->FindDict(source_id) : nullptr;
    const auto* grants =
        entry ? entry->FindDict("granted_permissions") : nullptr;
    if (grants)
      result.grants = grants->Clone();
  }
  const size_t snapshot_warning_count = result.warnings.size();
  result.local = ReadSnapshot(
      source.AppendASCII("Local Extension Settings").AppendASCII(source_id),
      profile_root, result.warnings);
  result.sync = ReadSnapshot(
      source.AppendASCII("Sync Extension Settings").AppendASCII(source_id),
      profile_root, result.warnings);
  if (result.warnings.size() > snapshot_warning_count) {
    result.error =
        "Could not take a consistent settings snapshot. Close the source "
        "browser and retry.";
  }
  return result;
}

struct Job {
  Job(Reply response,
      base::FilePath local_path,
      bool from_store,
      bool originally_enabled,
      bool originally_pinned)
      : reply(std::move(response)),
        path(std::move(local_path)),
        store(from_store),
        enabled(originally_enabled),
        pinned(originally_pinned) {}
  Reply reply;
  base::FilePath path;
  bool store;
  bool enabled;
  bool pinned;
  Snapshot snapshot;
  int imported = 0;
  bool newly_installed = true;
  bool owns_pending = false;
  std::string source_id;
  base::FilePath source_profile;
  std::unique_ptr<network::SimpleURLLoader> loader;
  scoped_refptr<extensions::CrxInstaller> installer;
};

class ImportState : public ProfileState {
 public:
  explicit ImportState(Profile* profile) : ProfileState(profile) {}
  void Start(std::string id,
             std::string source_id,
             base::FilePath source,
             base::FilePath path,
             bool store,
             bool enabled,
             bool pinned,
             bool firefox,
             Reply reply) {
    for (const auto& [other_key, other] : jobs_) {
      if ((!id.empty() && other->snapshot.id == id) ||
          (other->source_id == source_id && other->source_profile == source)) {
        return reply.Error("This extension is already being imported");
      }
    }
    const int key = ++next_;
    jobs_[key] =
        std::make_unique<Job>(std::move(reply), path, store, enabled, pinned);
    jobs_[key]->snapshot.id = id;
    jobs_[key]->source_id = source_id;
    jobs_[key]->source_profile = source;
    auto* prefs = extensions::ExtensionPrefs::Get(profile());
    const Extension* existing = FindImported(profile(), id, source_id, source);
    if (existing && !prefs->ReadPrefAsDict(existing->id(), kPending)) {
      jobs_[key]->snapshot.id = existing->id();
      return Done(key, false);
    }
    SnapshotRunner()->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(&Stage, id, source_id, source, path, store, firefox),
        base::BindOnce(&ImportState::Staged, weak_.GetWeakPtr(), key));
  }

 private:
  void Release() override {
    weak_.InvalidateWeakPtrs();
    jobs_.clear();
  }
  void Staged(int key, Snapshot snapshot) {
    Job& job = *jobs_.at(key);
    job.snapshot = std::move(snapshot);
    if (!job.snapshot.error.empty())
      return Fail(key, job.snapshot.error);
    const std::string& id = job.snapshot.id;
    auto* prefs = extensions::ExtensionPrefs::Get(profile());
    for (const auto& [other_key, other] : jobs_) {
      if (other_key != key && (other->snapshot.id == id ||
                               (other->source_id == job.source_id &&
                                other->source_profile == job.source_profile))) {
        return Fail(key, "This extension is already being imported");
      }
    }
    const Extension* existing =
        FindImported(profile(), id, job.source_id, job.source_profile);
    if (existing) {
      job.snapshot.id = existing->id();
      job.newly_installed = false;
      if (prefs->ReadPrefAsDict(existing->id(), kPending)) {
        const auto* provenance =
            prefs->ReadPrefAsDict(existing->id(), kProvenance);
        if (!provenance || !provenance->FindString("id") ||
            !provenance->FindString("profile") ||
            *provenance->FindString("id") != job.source_id ||
            *provenance->FindString("profile") != job.source_profile.value()) {
          return Fail(key,
                      "An incomplete import of this extension belongs to "
                      "another source profile");
        }
        return Hydrate(key, StorageAreaNamespace::kLocal);
      }
      return Done(key, false);
    }
    // Write metadata before installation. The registrar consumes it before
    // registration and persists a dedicated disable reason in the same prefs.
    base::DictValue pending;
    pending.Set("enabled", job.enabled);
    pending.Set("store", job.store);
    pending.Set("grants", job.snapshot.grants.Clone());
    prefs->UpdateExtensionPref(id, kPending, base::Value(std::move(pending)));
    job.owns_pending = true;
    prefs->UpdateExtensionPref(
        id, kProvenance,
        base::Value(base::DictValue()
                        .Set("id", job.source_id)
                        .Set("profile", job.source_profile.value())));
    profile()->GetPrefs()->CommitPendingWrite();
    if (!job.store) {
      extensions::util::SetDeveloperModeForProfile(profile(), true);
      auto installer = extensions::UnpackedInstaller::Create(profile());
      installer->set_be_noisy_on_failure(false);
      installer->set_completion_callback(
          base::BindOnce(&ImportState::Unpacked, weak_.GetWeakPtr(), key));
      installer->Load(job.path);
      return;
    }
    // The update service returns a CRX signed both by the developer and by the
    // Web Store publisher. CrxInstaller enforces the publisher proof below.
    auto request = std::make_unique<network::ResourceRequest>();
    request->url = GURL(
        "https://clients2.google.com/service/update2/crx?"
        "response=redirect&prodversion=" +
        std::string(version_info::GetVersionNumber()) +
        "&acceptformat=crx3&x=id%3D" + id + "%26installsource%3Dondemand%26uc");
    request->credentials_mode = network::mojom::CredentialsMode::kOmit;
    job.loader = network::SimpleURLLoader::Create(
        std::move(request),
        net::DefineNetworkTrafficAnnotation("bay_extension_import", R"(
          semantics { sender: "Browser extension importer"
            description: "Fetches the signed package of an extension the user chose to import."
            trigger: "The user imports extensions from another browser."
            data: "Extension identifier and browser version." destination: GOOGLE_OWNED_SERVICE }
          policy { cookies_allowed: NO setting: "Only requested during extension import."
            policy_exception_justification: "Extension installation policy is checked by CrxInstaller." })"));
    job.loader->SetTimeoutDuration(base::Minutes(2));
    job.loader->DownloadToTempFile(
        profile()
            ->GetDefaultStoragePartition()
            ->GetURLLoaderFactoryForBrowserProcess()
            .get(),
        base::BindOnce(&ImportState::Downloaded, weak_.GetWeakPtr(), key));
  }
  void Downloaded(int key, base::FilePath path) {
    Job& job = *jobs_.at(key);
    if (path.empty())
      return Fail(key, "Could not download the signed Web Store extension");
    job.installer = extensions::CrxInstaller::CreateSilent(profile());
    job.installer->set_expected_id(job.snapshot.id);
    job.installer->set_is_gallery_install(true);
    job.installer->set_allow_silent_install(true);
    job.installer->set_grant_permissions(false);
    job.installer->set_delete_source(true);
    job.installer->AddInstallerCallback(
        base::BindOnce(&ImportState::CrxInstalled, weak_.GetWeakPtr(), key));
    // Default off-store allowance is disallowed. InstallCrx therefore requires
    // the Web Store publisher proof, rather than just a developer signature.
    job.installer->InstallCrxFile(extensions::CRXFileInfo(
        path, extensions::GetWebstoreVerifierFormat(false)));
  }
  void Unpacked(int key,
                const Extension* extension,
                const base::FilePath&,
                const std::u16string& error) {
    if (!extension)
      return Fail(key, "Could not install the prepared extension");
    Hydrate(key, StorageAreaNamespace::kLocal);
  }
  void CrxInstalled(int key,
                    const std::optional<extensions::CrxInstallError>& error) {
    if (error)
      return Fail(key, "Web Store extension installation failed");
    Hydrate(key, StorageAreaNamespace::kLocal);
  }
  void Hydrate(int key, StorageAreaNamespace area) {
    Job& job = *jobs_.at(key);
    const Extension* extension =
        extensions::ExtensionRegistry::Get(profile())->GetExtensionById(
            job.snapshot.id, extensions::ExtensionRegistry::EVERYTHING);
    if (!extension)
      return Fail(key, "Installed extension was not registered");
    auto& source = area == StorageAreaNamespace::kLocal ? job.snapshot.local
                                                        : job.snapshot.sync;
    if (source.empty())
      return Next(key, area);
    auto* storage = extensions::StorageFrontend::Get(profile());
    if (!storage->IsStorageEnabled(
            extensions::StorageAreaToSettingsNamespace(area))) {
      job.snapshot.warnings.Append(
          "This browser has no storage.sync backend; sync settings were not "
          "copied");
      return Next(key, area);
    }
    auto runner = base::SequencedTaskRunner::GetCurrentDefault();
    auto finished =
        base::BindOnce(&ImportState::Merged, weak_.GetWeakPtr(), key, area);
    storage->RunWithStorage(
        base::WrapRefCounted(extension),
        extensions::StorageAreaToSettingsNamespace(area),
        base::BindOnce(
            [](base::DictValue source,
               scoped_refptr<base::SequencedTaskRunner> runner,
               base::OnceCallback<void(int, std::string,
                                       value_store::ValueStoreChangeList)>
                   finished,
               value_store::ValueStore* destination) {
              int count = 0;
              std::string error;
              value_store::ValueStoreChangeList changes;
              if (!destination) {
                error = "Could not open destination extension settings";
              } else {
                // The read and missing-key write run in one backend task,
                // preventing a sync update from interleaving and being lost.
                auto existing = destination->Get();
                if (!existing.status().ok()) {
                  error = "Could not read destination extension settings";
                } else {
                  base::DictValue missing;
                  for (auto [name, value] : source) {
                    if (!existing.settings().contains(name))
                      missing.Set(name, value.Clone());
                  }
                  if (!missing.empty()) {
                    auto written = destination->Set(
                        value_store::ValueStore::DEFAULTS, missing);
                    if (!written.status().ok()) {
                      error = "Could not restore extension settings";
                    } else {
                      count = static_cast<int>(missing.size());
                      changes = written.PassChanges();
                    }
                  }
                }
              }
              runner->PostTask(
                  FROM_HERE,
                  base::BindOnce(std::move(finished), count, std::move(error),
                                 std::move(changes)));
            },
            source.Clone(), runner, std::move(finished)));
  }
  void Merged(int key,
              StorageAreaNamespace area,
              int count,
              std::string error,
              value_store::ValueStoreChangeList changes) {
    if (!error.empty())
      return Fail(key, error + "; extension remains disabled");
    Job& job = *jobs_.at(key);
    job.imported += count;
    if (!changes.empty()) {
      extensions::StorageFrontend::Get(profile())->GetObserver().Run(
          job.snapshot.id, area,
          extensions::storage_utils::GetAccessLevelForArea(job.snapshot.id,
                                                           *profile(), area),
          value_store::ValueStoreChange::ToValue(std::move(changes)));
    }
    Next(key, area);
  }
  void Next(int key, StorageAreaNamespace area) {
    if (area == StorageAreaNamespace::kLocal)
      return Hydrate(key, StorageAreaNamespace::kSync);
    Job& job = *jobs_.at(key);
    auto* prefs = extensions::ExtensionPrefs::Get(profile());
    auto pinned = prefs->GetPinnedExtensions();
    std::erase(pinned, job.snapshot.id);
    if (job.pinned)
      pinned.push_back(job.snapshot.id);
    prefs->SetPinnedExtensions(pinned);
    if (prefs->HasDisableReason(
            job.snapshot.id,
            extensions::disable_reason::DISABLE_PERMISSIONS_INCREASE)) {
      job.snapshot.warnings.Append(
          "Extension permissions changed or original grants could not be "
          "verified; re-enable it to review permissions");
    }
    prefs->UpdateExtensionPref(job.snapshot.id, kPending, std::nullopt);
    prefs->RemoveDisableReason(job.snapshot.id,
                               extensions::disable_reason::DISABLE_IMPORTING);
    profile()->GetPrefs()->CommitPendingWrite();
    // Only enable after our hold is gone and no other disable reasons remain.
    // The registrar still checks blocklist and management policy.
    if (prefs->GetDisableReasons(job.snapshot.id).empty()) {
      extensions::ExtensionRegistrar::Get(profile())->EnableExtension(
          job.snapshot.id);
    }
    Done(key, job.newly_installed);
  }
  void Done(int key, bool installed) {
    Job& job = *jobs_.at(key);
    auto result = base::DictValue()
                      .Set("id", job.snapshot.id)
                      .Set("installed", installed)
                      .Set("storageImported", job.imported)
                      .Set("warnings", std::move(job.snapshot.warnings))
                      .Set("updateMode", job.store ? "store" : "local");
    if (!installed) {
      const auto* existing =
          extensions::ExtensionRegistry::Get(profile())->GetExtensionById(
              job.snapshot.id, extensions::ExtensionRegistry::EVERYTHING);
      if (existing)
        result.Set("updateMode", existing->from_webstore() ? "store" : "local");
    }
    job.reply.Send(std::move(result));
    jobs_.erase(key);
  }
  void Fail(int key, std::string error) {
    Job& job = *jobs_.at(key);
    const Extension* registered =
        job.snapshot.id.empty()
            ? nullptr
            : extensions::ExtensionRegistry::Get(profile())->GetExtensionById(
                  job.snapshot.id, extensions::ExtensionRegistry::EVERYTHING);
    if (!registered && job.owns_pending && !job.snapshot.id.empty()) {
      auto* prefs = extensions::ExtensionPrefs::Get(profile());
      prefs->UpdateExtensionPref(job.snapshot.id, kPending, std::nullopt);
      prefs->UpdateExtensionPref(job.snapshot.id, kProvenance, std::nullopt);
    }
    job.reply.Send(base::DictValue()
                       .Set("error", error)
                       .Set("retainsPath", registered && !job.store &&
                                               registered->path() == job.path));
    jobs_.erase(key);
  }
  std::map<int, std::unique_ptr<Job>> jobs_;
  int next_ = 0;
  base::WeakPtrFactory<ImportState> weak_{this};
};
}  // namespace

}  // namespace bay

NN_ENGINE_CALL(nn_extensions_import) {
  bay::Call call(profile_dir, args_json, reply, context);
  if (!call)
    return;
  const bool store = call.Bool("store");
  const bool firefox = call.String("source") == "firefox";
  const std::string id = call.String("id");
  const std::string source_id = call.String("sourceId");
  const base::FilePath source(call.String("sourceProfilePath"));
  const base::FilePath path(call.String("path"));
  if (!source.IsAbsolute() || (!store && !path.IsAbsolute()) ||
      (store &&
       (!crx_file::id_util::IdIsValid(id) || (!firefox && id != source_id)))) {
    return call.TakeReply().Error("Invalid extension import source");
  }
  if (bay::ProfileAt(source.value())) {
    return call.TakeReply().Error(
        "Close the source profile before importing its extensions");
  }
  bay::StateFor<bay::ImportState>(call.profile())
      .Start(id, source_id, source, path, store, call.Bool("enabled", true),
             call.Bool("pinned"), firefox, call.TakeReply());
}
