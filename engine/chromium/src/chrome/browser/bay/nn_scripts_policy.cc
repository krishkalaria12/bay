// Copyright 2026 Bay. Apache-2.0.

#include "chrome/browser/bay/nn_scripts_policy.h"

#include "build/build_config.h"

#if BUILDFLAG(IS_WIN)
#include <windows.h>
#else
#include <limits.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#include <memory>
#include <algorithm>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/containers/fixed_flat_set.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/values.h"
#include "chrome/common/chrome_paths.h"
#include "components/crx_file/id_util.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/web_contents.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/browser/management_policy.h"
#include "extensions/common/constants.h"
#include "extensions/common/extension.h"
#include "extensions/common/file_util.h"
#include "extensions/common/mojom/manifest.mojom.h"
#include "extensions/common/manifest.h"
#include "extensions/common/manifest_handlers/permissions_parser.h"
#include "extensions/common/permissions/permission_set.h"
#include "extensions/common/permissions/permissions_data.h"
#include "url/gurl.h"

extern bool (*g_bay_unpacked_path_allowed)(const base::FilePath& requested,
                                             const base::FilePath& resolved,
                                             std::u16string* error);

namespace bay {
namespace {

using extensions::Extension;

constexpr size_t kMaxContentScripts = 256;
constexpr size_t kMaxFilesPerList = 256;
constexpr size_t kMaxDistinctFiles = 512;
constexpr size_t kMaxPathComponents = 4096;
constexpr size_t kMaxVerdicts = 16;

constexpr auto kManifestKeys = base::MakeFixedFlatSet<std::string_view>(
    {"content_scripts", "description", "manifest_version", "name",
     "version"});

constexpr auto kContentScriptKeys = base::MakeFixedFlatSet<std::string_view>(
    {"all_frames", "css", "exclude_globs", "exclude_matches", "include_globs",
     "js", "match_about_blank", "match_origin_as_fallback", "matches",
     "run_at", "world"});

std::optional<base::FilePath> RealPath(const base::FilePath& path) {
#if BUILDFLAG(IS_WIN)
  base::FilePath resolved;
  return base::NormalizeFilePath(path, &resolved)
             ? std::make_optional(std::move(resolved))
             : std::nullopt;
#else
  char resolved[PATH_MAX];
  if (!realpath(path.value().c_str(), resolved)) {
    return std::nullopt;
  }
  return base::FilePath(resolved);
#endif
}

bool SamePath(const base::FilePath& first, const base::FilePath& second) {
#if BUILDFLAG(IS_WIN)
  return base::FilePath::CompareEqualIgnoreCase(
      first.NormalizePathSeparators().StripTrailingSeparators().value(),
      second.NormalizePathSeparators().StripTrailingSeparators().value());
#else
  return first.StripTrailingSeparators() == second.StripTrailingSeparators();
#endif
}

enum class PlainKind { kFile, kFolder };

// Do not follow links, including NTFS junctions and other reparse points.
std::optional<PlainKind> LinkType(const base::FilePath& path) {
#if BUILDFLAG(IS_WIN)
  const DWORD attributes = GetFileAttributesW(path.value().c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES ||
      (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
    return std::nullopt;
  return attributes & FILE_ATTRIBUTE_DIRECTORY ? PlainKind::kFolder
                                                : PlainKind::kFile;
#else
  struct stat info;
  if (lstat(path.value().c_str(), &info) != 0)
    return std::nullopt;
  switch (info.st_mode & S_IFMT) {
    case S_IFDIR: return PlainKind::kFolder;
    case S_IFREG: return PlainKind::kFile;
    default: return std::nullopt;
  }
#endif
}

bool SingleSmallFile(const base::FilePath& path, int64_t limit) {
#if BUILDFLAG(IS_WIN)
  HANDLE file = CreateFileW(path.value().c_str(), FILE_READ_ATTRIBUTES,
                            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            nullptr, OPEN_EXISTING,
                            FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file == INVALID_HANDLE_VALUE)
    return false;
  BY_HANDLE_FILE_INFORMATION info;
  const bool read = GetFileInformationByHandle(file, &info);
  CloseHandle(file);
  return read && !(info.dwFileAttributes &
                   (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) &&
         info.nNumberOfLinks == 1 && info.nFileSizeHigh == 0 &&
         info.nFileSizeLow <= static_cast<uint64_t>(limit);
#else
  struct stat info;
  return lstat(path.value().c_str(), &info) == 0 &&
         (info.st_mode & S_IFMT) == S_IFREG && info.st_nlink == 1 &&
         info.st_size <= limit;
#endif
}

#if !BUILDFLAG(IS_WIN)
std::optional<std::vector<std::string>> AbsoluteParts(
    const base::FilePath& path) {
  std::string value = path.value();
  if (value == "~" || value.starts_with("~/")) {
    if (const char* home = getenv("HOME")) {
      value = std::string(home) + value.substr(1);
    }
  }
  if (value.empty() || value.front() != '/') {
    char cwd[PATH_MAX];
    if (!getcwd(cwd, sizeof(cwd))) {
      return std::nullopt;
    }
    value = std::string(cwd) + "/" + value;
  }
  std::vector<std::string> parts;
  for (std::string& part : base::SplitString(
           value, "/", base::KEEP_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    if (part != ".") {
      parts.push_back(std::move(part));
    }
  }
  return parts;
}

base::FilePath Collapsed(base::FilePath base,
                         const std::vector<std::string>& parts,
                         size_t from) {
  for (size_t i = from; i < parts.size(); ++i) {
    base = parts[i] == ".." ? base.DirName() : base.Append(parts[i]);
  }
  return base;
}

base::FilePath LexicallyAbsolute(const base::FilePath& path) {
  const std::optional<std::vector<std::string>> parts = AbsoluteParts(path);
  return parts ? Collapsed(base::FilePath("/"), *parts, 0) : base::FilePath();
}

#else
base::FilePath LexicallyAbsolute(const base::FilePath& path) {
  if (path.empty() || path.value().find(L'\0') != std::wstring::npos)
    return {};
  const DWORD size = GetFullPathNameW(path.value().c_str(), 0, nullptr, nullptr);
  if (!size || size > 32768)
    return {};
  std::wstring absolute(size, L'\0');
  const DWORD written = GetFullPathNameW(path.value().c_str(), size,
                                         absolute.data(), nullptr);
  if (!written || written >= size)
    return {};
  absolute.resize(written);
  return base::FilePath(absolute);
}
#endif

bool IsSameOrInsideIgnoringCase(const base::FilePath& dir,
                                const base::FilePath& path) {
  const auto parent = dir.StripTrailingSeparators().GetComponents();
  const auto child = path.StripTrailingSeparators().GetComponents();
  if (parent.empty() || parent.size() > child.size())
    return false;
  for (size_t i = 0; i < parent.size(); ++i) {
    if (!base::FilePath::CompareEqualIgnoreCase(parent[i], child[i]))
      return false;
  }
  return true;
}

bool IsEmpty(const extensions::PermissionSet& permissions) {
  return permissions.apis().empty() &&
         permissions.manifest_permissions().empty() &&
         permissions.explicit_hosts().is_empty();
}

std::optional<std::string> ScriptFileProblem(const base::FilePath& root,
                                             const std::string& relative) {
  if (relative.empty() || relative.front() == '/' ||
      relative.find('\0') != std::string::npos ||
      relative.find('\\') != std::string::npos ||
      relative.find(':') != std::string::npos) {
    return "\"" + relative + "\" isn't a path inside the folder";
  }
  const std::vector<std::string> parts = base::SplitString(
      relative, "/", base::KEEP_WHITESPACE, base::SPLIT_WANT_ALL);
  base::FilePath path = root;
  for (size_t i = 0; i < parts.size(); ++i) {
    const std::string& part = parts[i];
    if (part.empty() || part == "." || part == ".."
#if BUILDFLAG(IS_WIN)
        || part.back() == '.' || part.back() == ' '
#endif
        ) {
      return "\"" + relative + "\" isn't a plain path inside the folder";
    }
    path = path.Append(base::FilePath::FromUTF8Unsafe(part));
    const bool last = i + 1 == parts.size();
    if (LinkType(path) != (last ? PlainKind::kFile : PlainKind::kFolder)) {
      return "\"" + relative + "\" isn't a plain file inside the folder";
    }
    if (last) {
      if (!SingleSmallFile(path, 64 * 1024 * 1024)) {
        return "\"" + relative + "\" must be a source file without hard links, at most 64 MiB";
      }
    }
  }
  return std::nullopt;
}

std::optional<std::string> StringListProblem(const base::DictValue& entry,
                                             std::string_view key) {
  const base::Value* value = entry.Find(key);
  if (!value) {
    return std::nullopt;
  }
  const base::ListValue* list = value->GetIfList();
  if (!list) {
    return std::string(key) + " must be a list";
  }
  if (list->size() > kMaxFilesPerList) {
    return std::string(key) + " lists too many files";
  }
  for (const base::Value& item : *list) {
    if (!item.is_string()) {
      return std::string(key) + " must list strings";
    }
  }
  return std::nullopt;
}

bool NamesFolder(const base::FilePath& path) {
  const base::FilePath folder = path.StripTrailingSeparators();
  return base::FilePath::CompareEqualIgnoreCase(
             folder.BaseName().value(), FILE_PATH_LITERAL("extension")) &&
         base::FilePath::CompareEqualIgnoreCase(
             folder.DirName().BaseName().value(), FILE_PATH_LITERAL("Scripts"));
}

std::u16string Refusal(const std::string& problem) {
  return base::UTF8ToUTF16("Bay Scripts can only hold content scripts: " +
                           problem);
}

class ScriptsPolicyProvider : public extensions::ManagementPolicy::Provider {
 public:
  ScriptsPolicyProvider() {
    base::FilePath user_data;
    if (base::PathService::Get(chrome::DIR_USER_DATA, &user_data) &&
        !user_data.empty()) {
#if BUILDFLAG(IS_MAC)
      const auto data_root = user_data.DirName();
#else
      const auto& data_root = user_data;
#endif
      // The host's snapshot names the canonical folder, including when the
      // user's home or BAY_DATA_DIR itself is a symlink/junction.
      scripts_ = RealPath(data_root).value_or(data_root).AppendASCII("Scripts");
      folder_ = scripts_.AppendASCII("extension");
      designated_id_ = crx_file::id_util::GenerateIdForPath(folder_);
    }
  }

  const base::FilePath& folder() const { return folder_; }
  const base::FilePath& scripts() const { return scripts_; }

  void BeginInstall() { ++installs_pending_; }
  void EndInstall() { --installs_pending_; }

  std::string GetDebugPolicyProviderName() const override {
    return "Bay Scripts";
  }

  bool UserMayLoad(const Extension* extension,
                   std::u16string* error) const override {
    if (!IsScriptsExtension(*extension)) {
      return true;
    }
    const std::optional<std::string> problem = Problem(*extension);
    if (!problem) {
      return true;
    }
    if (error) {
      *error = Refusal(*problem);
    }
    return false;
  }

  void UserMayInstall(
      scoped_refptr<const Extension> extension,
      base::OnceCallback<void(extensions::ManagementPolicy::Decision)> callback)
      const override {
    if (installs_pending_ > 0 &&
        extensions::Manifest::IsUnpackedLocation(extension->location()) &&
        !SamePath(extension->path(), folder_)) {
      std::move(callback).Run(
          {false, Refusal("Scripts/extension changed while it was "
                          "installing")});
      return;
    }
    Provider::UserMayInstall(std::move(extension), std::move(callback));
  }

  bool IsScriptsExtension(const Extension& extension) const {
    if (folder_.empty()) {
      return false;
    }
    if (extension.id() == designated_id_) {
      return true;
    }
    if (!extensions::Manifest::IsUnpackedLocation(extension.location()) ||
        !NamesFolder(extension.path())) {
      return false;
    }
    const base::FilePath path = extension.path().StripTrailingSeparators();
    if (base::FilePath::CompareEqualIgnoreCase(path.value(), folder_.value())) {
      return true;
    }
    const std::optional<base::FilePath> real_folder = RealPath(folder_);
    const std::optional<base::FilePath> real_path = RealPath(path);
    return real_folder && real_path && SamePath(*real_folder, *real_path);
  }

  bool IsDesignatedId(const std::string& id) const {
    return !designated_id_.empty() && id == designated_id_;
  }

  // Blocking preflight of the folder supplied by the host. It does not read
  // the UI-sequence policy singleton or its verdict cache.
  static std::optional<std::string> ValidateFolder(const base::FilePath& path) {
    if (LinkType(path.DirName()) != PlainKind::kFolder ||
        LinkType(path) != PlainKind::kFolder)
      return "Scripts/extension must be a plain folder";
    const auto manifest = path.AppendASCII("manifest.json");
    if (LinkType(manifest) != PlainKind::kFile ||
        !SingleSmallFile(manifest, 1 << 20))
      return "manifest.json must be a plain file at most 1 MiB without hard links";
    std::string json;
    if (!base::ReadFileToStringWithMaxSize(manifest, &json, 1 << 20))
      return "manifest.json could not be read";
    auto dictionary = base::JSONReader::ReadDict(
        json, base::JSON_PARSE_CHROMIUM_EXTENSIONS);
    if (!dictionary)
      return "manifest.json must be a JSON object";
    if (auto problem = ManifestProblem(*dictionary))
      return problem;
    // Chrome validates source encodings by opening files. Check their shape
    // first so a FIFO, device or symlink is never handed to that reader.
    const auto files = ScriptFiles(*dictionary);
    size_t components = 0;
    for (const auto& file : files)
      components += std::ranges::count(file, '/') + 1;
    if (files.size() > kMaxDistinctFiles || components > kMaxPathComponents)
      return "content_scripts names too many files or path components";
    for (const auto& file : files) {
      if (auto problem = ScriptFileProblem(path, file))
        return problem;
    }
    std::u16string error;
    auto extension = Extension::Create(
        path, extensions::mojom::ManifestLocation::kUnpacked,
        *dictionary, Extension::NO_FLAGS, &error);
    if (!extension)
      return base::UTF16ToUTF8(error);
    if (auto problem = ShapeProblem(*extension))
      return problem;
    std::vector<extensions::InstallWarning> warnings;
    if (!extensions::file_util::ValidateExtension(extension.get(), &error,
                                                   &warnings))
      return base::UTF16ToUTF8(error);
    return std::nullopt;
  }

 private:
  std::optional<std::string> Problem(const Extension& extension) const {
    if (auto problem = CachedShapeProblem(extension))
      return problem;
    return FileProblem(extension);
  }

  std::optional<std::string> FileProblem(const Extension& extension) const {
    if (LinkType(scripts_) != PlainKind::kFolder ||
        LinkType(folder_) != PlainKind::kFolder) {
      return "Scripts/extension must be a plain folder";
    }
    const std::optional<base::FilePath> real_folder = RealPath(folder_);
    const std::optional<base::FilePath> real_path =
        RealPath(extension.path());
    if (!real_folder || !real_path || !SamePath(*real_folder, *real_path)) {
      return "the extension must be the Scripts/extension folder itself";
    }
    if (!SingleSmallFile(real_folder->AppendASCII("manifest.json"), 1 << 20))
      return "manifest.json must be a plain file at most 1 MiB without hard links";
    for (const std::string& file : ScriptFiles(extension)) {
      if (std::optional<std::string> problem =
              ScriptFileProblem(*real_folder, file)) {
        return problem;
      }
    }
    return std::nullopt;
  }

  static std::optional<std::string> ShapeProblem(const Extension& extension) {
    if (!extensions::Manifest::IsUnpackedLocation(extension.location())) {
      return "it must be loaded unpacked from Scripts/extension";
    }
    if (std::optional<std::string> problem = ManifestProblem(extension)) {
      return problem;
    }
    if (!IsEmpty(extensions::PermissionsParser::GetRequiredPermissions(
            &extension)) ||
        !IsEmpty(extensions::PermissionsParser::GetOptionalPermissions(
            &extension)) ||
        !IsEmpty(extension.permissions_data()->active_permissions()) ||
        !IsEmpty(extension.permissions_data()->withheld_permissions())) {
      return "it may not ask for permissions or host permissions";
    }
    const std::set<std::string> files = ScriptFiles(extension);
    if (files.size() > kMaxDistinctFiles) {
      return "content_scripts names too many files";
    }
    size_t components = 0;
    for (const std::string& file : files) {
      components += std::ranges::count(file, '/') + 1;
    }
    if (components > kMaxPathComponents) {
      return "content_scripts file paths are too deep";
    }
    return std::nullopt;
  }

  static std::optional<std::string> ManifestProblem(const Extension& extension) {
    return ManifestProblem(*extension.manifest()->value());
  }

  static std::optional<std::string> ManifestProblem(
      const base::DictValue& manifest) {
    for (const auto [key, value] : manifest) {
      if (!kManifestKeys.contains(key)) {
        return "manifest.json may not contain \"" + key + "\"";
      }
    }
    const std::optional<int> version = manifest.FindInt("manifest_version");
    if (!version || *version != 3) {
      return "manifest_version must be 3";
    }
    if (!manifest.FindString("name") || !manifest.FindString("version")) {
      return "name and version must be strings";
    }
    const base::Value* description = manifest.Find("description");
    if (description && !description->is_string()) {
      return "description must be a string";
    }
    const base::ListValue* entries = manifest.FindList("content_scripts");
    if (!entries) {
      return "content_scripts must be a list";
    }
    if (entries->empty() || entries->size() > kMaxContentScripts) {
      return "content_scripts must have between 1 and 256 entries";
    }
    for (const base::Value& item : *entries) {
      const base::DictValue* entry = item.GetIfDict();
      if (!entry) {
        return "each content_scripts entry must be an object";
      }
      for (const auto [key, value] : *entry) {
        if (!kContentScriptKeys.contains(key)) {
          return "a content_scripts entry may not contain \"" + key + "\"";
        }
      }
      for (std::string_view key : {"js", "css"}) {
        if (std::optional<std::string> problem =
                StringListProblem(*entry, key)) {
          return problem;
        }
      }
    }
    return std::nullopt;
  }

  static std::set<std::string> ScriptFiles(const Extension& extension) {
    return ScriptFiles(*extension.manifest()->value());
  }

  static std::set<std::string> ScriptFiles(const base::DictValue& manifest) {
    std::set<std::string> files;
    const base::ListValue* entries = manifest.FindList("content_scripts");
    if (!entries) {
      return files;
    }
    for (const base::Value& item : *entries) {
      const base::DictValue* entry = item.GetIfDict();
      if (!entry) {
        continue;
      }
      for (std::string_view key : {"js", "css"}) {
        if (const base::ListValue* list = entry->FindList(key)) {
          for (const base::Value& file : *list) {
            if (const std::string* name = file.GetIfString()) {
              files.insert(*name);
            }
          }
        }
      }
    }
    return files;
  }

  std::optional<std::string> CachedShapeProblem(
      const Extension& extension) const {
    for (const auto& [seen, problem] : verdicts_) {
      if (seen.get() == &extension) {
        return problem;
      }
    }
    std::optional<std::string> problem = ShapeProblem(extension);
    if (verdicts_.size() >= kMaxVerdicts) {
      verdicts_.erase(verdicts_.begin());
    }
    verdicts_.emplace_back(base::WrapRefCounted(&extension), problem);
    return problem;
  }

  base::FilePath scripts_;
  base::FilePath folder_;
  std::string designated_id_;
  int installs_pending_ = 0;
  mutable std::vector<
      std::pair<scoped_refptr<const Extension>, std::optional<std::string>>>
      verdicts_;
};

ScriptsPolicyProvider& Scripts() {
  static base::NoDestructor<ScriptsPolicyProvider> scripts;
  return *scripts;
}

class ScriptsPagesThrottle : public content::NavigationThrottle {
 public:
  explicit ScriptsPagesThrottle(content::NavigationThrottleRegistry& registry)
      : content::NavigationThrottle(registry) {}

  ThrottleCheckResult WillStartRequest() override { return Check(); }
  ThrottleCheckResult WillRedirectRequest() override { return Check(); }
  const char* GetNameForLogging() override {
    return "BayScriptsPagesThrottle";
  }

 private:
  ThrottleCheckResult Check() {
    const GURL& url = navigation_handle()->GetURL();
    if (!url.SchemeIs(extensions::kExtensionScheme)) {
      return PROCEED;
    }
    const std::string id(url.host());
    if (Scripts().IsDesignatedId(id)) {
      return BLOCK_REQUEST;
    }
    const Extension* extension =
        extensions::ExtensionRegistry::Get(
            navigation_handle()->GetWebContents()->GetBrowserContext())
            ->GetExtensionById(id, extensions::ExtensionRegistry::EVERYTHING);
    if (extension && Scripts().IsScriptsExtension(*extension)) {
      return BLOCK_REQUEST;
    }
    return PROCEED;
  }
};

#if !BUILDFLAG(IS_WIN)
bool ResolvedPrefixNamesScripts(const base::FilePath& scripts,
                                const base::FilePath& requested) {
  const std::optional<std::vector<std::string>> parts = AbsoluteParts(requested);
  if (!parts || parts->size() > kMaxPathComponents) {
    return true;
  }
  const std::optional<base::FilePath> real_scripts = RealPath(scripts);
  base::FilePath prefix("/");
  for (size_t i = 0; i <= parts->size(); ++i) {
    if (i > 0) {
      prefix = prefix.Append((*parts)[i - 1]);
    }
    const std::optional<base::FilePath> real = RealPath(prefix);
    if (!real) {
      continue;
    }
    const base::FilePath candidate = Collapsed(*real, *parts, i);
    if (IsSameOrInsideIgnoringCase(scripts, candidate) ||
        (real_scripts && IsSameOrInsideIgnoringCase(*real_scripts, candidate))) {
      return true;
    }
  }
  return false;
}

#endif

bool RequestNamesScripts(const base::FilePath& scripts,
                         const base::FilePath& requested) {
  const base::FilePath absolute = LexicallyAbsolute(requested);
  if (absolute.empty() || IsSameOrInsideIgnoringCase(scripts, absolute)
#if !BUILDFLAG(IS_WIN)
      || ResolvedPrefixNamesScripts(scripts, requested)
#endif
      ) {
    return true;
  }
  std::vector<base::FilePath::StringType> rest;
  for (base::FilePath ancestor = absolute;; ancestor = ancestor.DirName()) {
    if (std::optional<base::FilePath> real = RealPath(ancestor)) {
      base::FilePath candidate = *real;
      for (auto part = rest.rbegin(); part != rest.rend(); ++part) {
        candidate = candidate.Append(*part);
      }
      if (IsSameOrInsideIgnoringCase(scripts, candidate)) {
        return true;
      }
    }
    if (ancestor.DirName() == ancestor) {
      return false;
    }
    rest.push_back(ancestor.BaseName().value());
  }
}

bool UnpackedPathAllowed(const base::FilePath& requested,
                         const base::FilePath& resolved,
                         std::u16string* error) {
  const base::FilePath scripts = Scripts().scripts();
  const base::FilePath folder = Scripts().folder();
  if (scripts.empty()) {
    return true;
  }
  const std::optional<base::FilePath> real_scripts = RealPath(scripts);
  const bool names_scripts =
      RequestNamesScripts(scripts, requested) ||
      IsSameOrInsideIgnoringCase(scripts, resolved) ||
      (real_scripts && IsSameOrInsideIgnoringCase(*real_scripts, resolved));
  if (!names_scripts) {
    return true;
  }
  const auto real_folder = RealPath(folder);
  if (LinkType(scripts) == PlainKind::kFolder &&
      LinkType(folder) == PlainKind::kFolder &&
      SamePath(resolved, folder) && real_folder &&
      SamePath(*real_folder, folder)) {
    return true;
  }
  *error = Refusal(
      "only the Scripts/extension folder itself loads, as a plain folder");
  return false;
}

}

void RegisterManagementPolicyProviders(Profile*,
                                       extensions::ManagementPolicy* policy) {
  if (!g_bay_unpacked_path_allowed) {
    g_bay_unpacked_path_allowed = &UnpackedPathAllowed;
  }
  policy->RegisterProvider(&Scripts());
}

void AddScriptsPagesThrottle(content::NavigationThrottleRegistry& registry) {
  registry.AddThrottle(std::make_unique<ScriptsPagesThrottle>(registry));
}

bool NamesScriptsFolder(const base::FilePath& path) {
  const base::FilePath folder = Scripts().folder();
  if (folder.empty() || !NamesFolder(path)) {
    return false;
  }
  if (base::FilePath::CompareEqualIgnoreCase(
          path.StripTrailingSeparators().value(), folder.value())) {
    return true;
  }
  const std::optional<base::FilePath> real_path = RealPath(path);
  const std::optional<base::FilePath> real_folder = RealPath(folder);
  return real_path && real_folder && SamePath(*real_path, *real_folder);
}

base::FilePath ScriptsFolder() {
  return Scripts().folder();
}

std::optional<std::string> ScriptsFolderInstallProblem(
    const base::FilePath& path) {
  const base::FilePath folder = Scripts().folder();
  if (folder.empty()) {
    return "Bay has no data folder";
  }
  if (LinkType(path.StripTrailingSeparators().DirName()) != PlainKind::kFolder ||
      LinkType(path.StripTrailingSeparators()) != PlainKind::kFolder ||
      LinkType(Scripts().scripts()) != PlainKind::kFolder ||
      LinkType(folder) != PlainKind::kFolder) {
    return "Bay Scripts: Scripts/extension must be a plain folder";
  }
  const std::optional<base::FilePath> real_path = RealPath(path);
  const std::optional<base::FilePath> real_folder = RealPath(folder);
  if (!real_path || !real_folder || !SamePath(*real_path, *real_folder)) {
    return "Bay Scripts: that isn't this Bay's Scripts/extension folder";
  }
  return std::nullopt;
}

std::optional<std::string> ValidateScriptsFolder(const base::FilePath& path) {
  return ScriptsPolicyProvider::ValidateFolder(path);
}

base::ScopedClosureRunner BeginScriptsInstall() {
  Scripts().BeginInstall();
  return base::ScopedClosureRunner(
      base::BindOnce([] { Scripts().EndInstall(); }));
}

}
