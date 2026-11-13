// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/content_blocker.h"

#include <stdlib.h>
#include <string.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <mutex>
#include <optional>
#include <string_view>
#include <utility>

#include "base/base_paths.h"
#include "base/check.h"
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/location.h"
#include "base/logging.h"
#include "base/memory/raw_ptr_exclusion.h"
#include "base/path_service.h"
#include "base/strings/string_util.h"
#include "base/strings/stringprintf.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "bay/core/nn_request_filter.h"
#include "chrome/browser/bay/webui/bay_adblock.h"
#include "chrome/browser/bay/webui/content_blocker_rules.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/net/system_network_context_manager.h"
#include "chrome/common/chrome_paths.h"
#include "content/public/browser/browser_thread.h"
#include "net/base/load_flags.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "url/gurl.h"

namespace bay {
namespace {
using content_blocker::Covers;
using content_blocker::HostOf;

constexpr char kVersion[] = "adblock-rust 0.13.5";
// Bump with a change to how lists compile (the crate, its features): the cached
// engine is rebuilt. As kEngineFormat in NNCoreContentBlocker.mm.
constexpr char kEngineFormat[] = "bay-adblock 5";
constexpr base::TimeDelta kFirstUpdate = base::Seconds(60);
constexpr base::TimeDelta kUpdateEvery = base::Hours(3);
constexpr size_t kMaxList = 32 * 1024 * 1024;

constexpr net::NetworkTrafficAnnotationTag kListsAnnotation =
    net::DefineNetworkTrafficAnnotation("bay_content_blocker_lists", R"(
      semantics {
        sender: "Bay content blocker"
        description: "Downloads the filter lists the user has on."
        trigger: "A list is turned on, or a list on has expired."
        data: "None. The request carries no credentials."
        destination: OTHER
      }
      policy {
        cookies_allowed: NO
        setting: "Privacy settings choose the lists, or turn blocking off."
        policy_exception_justification: "Bay's own feature."
      })");

// What the host needs from the engine, whatever the thread.
struct Engine {
  explicit Engine(BayBlocker* blocker) : blocker(blocker) {}
  ~Engine() { bay_blocker_free(blocker); }
  Engine(const Engine&) = delete;
  Engine& operator=(const Engine&) = delete;
  // Allocated and freed by the Rust library, outside PartitionAlloc.
  RAW_PTR_EXCLUSION BayBlocker* const blocker;
};

// What the request filter reads: replaced whole, never changed in place.
struct Live {
  std::shared_ptr<Engine> engine;
  bool enabled = true;
  std::vector<std::string> allowed;
  // Sites visited despite a block on the page itself. Requests are still
  // filtered on them.
  std::vector<std::string> pages;
};

std::mutex& LiveLock() {
  // Never destroyed. NoDestructor refuses std::mutex where it is trivially
  // destructible, as on Windows.
  static std::mutex* lock = new std::mutex;
  return *lock;
}
std::shared_ptr<const Live>& LiveSlot() {
  static base::NoDestructor<std::shared_ptr<const Live>> live(
      std::make_shared<Live>());
  return *live;
}
std::shared_ptr<const Live> CurrentLive() {
  std::lock_guard<std::mutex> lock(LiveLock());
  return LiveSlot();
}
void Publish(std::shared_ptr<const Live> live) {
  std::lock_guard<std::mutex> lock(LiveLock());
  LiveSlot() = std::move(live);
}

std::atomic<uint64_t> g_lookups{0};
std::atomic<uint64_t> g_lookup_micros_x1000{0};
std::atomic<uint64_t> g_max_lookup_micros_x1000{0};

const char* Or(const char* text, const char* fallback) {
  return text ? text : fallback;
}
bool Present(const char* text) {
  return text && *text;
}
bool PausedOn(const Live& live, const std::string& host) {
  return std::ranges::any_of(live.allowed, [&](const std::string& allowed) {
    return Covers(allowed, host);
  });
}
// The engine to ask for a page at `top` (or else `fallback`), if any.
std::shared_ptr<const Live> Filtering(const char* top, const char* fallback) {
  auto live = CurrentLive();
  if (!live->enabled || !live->engine ||
      PausedOn(*live, HostOf(Or(Present(top) ? top : fallback, ""))))
    return nullptr;
  return live;
}
// A library string as the engine's to free.
char* CopyOf(char* text) {
  char* copy = text ? strdup(text) : nullptr;
  bay_string_free(text);
  return copy;
}

bool Filter(const char* url,
            const char* source,
            const char* top,
            const char* type,
            const char* method,
            char** redirect,
            bool* any_origin) {
  if (redirect)
    *redirect = nullptr;
  if (any_origin)
    *any_origin = false;
  auto live = Filtering(top, source);
  if (!live)
    return false;
  const base::TimeTicks start = base::TimeTicks::Now();
  BayBlockerMatch match =
      bay_blocker_match(live->engine->blocker, url, Or(source, ""),
                        Or(type, "other"), Or(method, "GET"));
  // A blocked request's stand-in, or an allowed one's cleaned URL.
  const char* answer = match.blocked ? match.redirect : match.rewrite;
  if (redirect && answer)
    *redirect = strdup(answer);
  if (any_origin && !match.blocked && match.rewrite_any_origin)
    *any_origin = true;
  bay_string_free(match.redirect);
  bay_string_free(match.rewrite);
  if (match.blocked && type && !strcmp(type, "document")) {
    const std::string host = HostOf(url);
    for (const auto& page : live->pages) {
      if (Covers(page, host)) {
        // Visit Anyway lifts the block whole: no stand-in either.
        if (redirect) {
          free(*redirect);
          *redirect = nullptr;
        }
        return false;
      }
    }
  }
  const uint64_t micros_x1000 =
      static_cast<uint64_t>((base::TimeTicks::Now() - start).InNanoseconds());
  g_lookups.fetch_add(1, std::memory_order_relaxed);
  g_lookup_micros_x1000.fetch_add(micros_x1000, std::memory_order_relaxed);
  uint64_t max = g_max_lookup_micros_x1000.load(std::memory_order_relaxed);
  while (micros_x1000 > max &&
         !g_max_lookup_micros_x1000.compare_exchange_weak(
             max, micros_x1000, std::memory_order_relaxed)) {
  }
  return match.blocked;
}

char* Response(const char* url,
               const char* source,
               const char* top,
               const char* type,
               const char* method,
               const char* ip,
               const char* headers) {
  auto live = Filtering(top, source);
  if (!live)
    return nullptr;
  return CopyOf(bay_blocker_response(live->engine->blocker, url, Or(source, ""),
                                     Or(type, "other"), Or(method, "GET"), ip,
                                     Or(headers, "[]")));
}
bool BodyFilterApplies(const char* url,
                       const char* source,
                       const char* top,
                       const char* type,
                       const char* method,
                       int status,
                       const char* content_type,
                       const char* content_disposition) {
  auto live = Filtering(top, url);
  return live && bay_blocker_body_filter_applies(
                     live->engine->blocker, url, Or(source, ""),
                     Or(type, "other"), Or(method, "GET"), status,
                     Or(content_type, ""), Or(content_disposition, ""));
}
// Holds the engine, which a list update may replace while this runs.
uint8_t* BodyFiltered(const char* url,
                      const char* source,
                      const char* top,
                      const char* type,
                      const char* method,
                      const char* content_type,
                      const uint8_t* body,
                      size_t length,
                      size_t* out_length) {
  *out_length = 0;
  auto live = Filtering(top, url);
  if (!live)
    return nullptr;
  size_t filtered_length = 0;
  uint8_t* filtered = bay_blocker_body_filter(
      live->engine->blocker, url, Or(source, ""), Or(type, "other"),
      Or(method, "GET"), Or(content_type, ""), body, length, &filtered_length);
  if (!filtered)
    return nullptr;
  auto* copy = static_cast<uint8_t*>(malloc(std::max<size_t>(filtered_length, 1)));
  if (copy) {
    memcpy(copy, filtered, filtered_length);
    *out_length = filtered_length;
  }
  bay_bytes_free(filtered, filtered_length);
  return copy;
}
char* RequestHeaderNames(const char* url,
                         const char* source,
                         const char* top,
                         const char* type,
                         const char* method) {
  auto live = Filtering(top, url);
  if (!live)
    return nullptr;
  return CopyOf(bay_blocker_request_header_names(
      live->engine->blocker, url, Or(source, ""), Or(type, "other"),
      Or(method, "GET")));
}
bool RequestHeadersBlocked(const char* url,
                           const char* source,
                           const char* top,
                           const char* type,
                           const char* method,
                           const char* headers) {
  auto live = Filtering(top, url);
  return live && bay_blocker_request_headers_blocked(
                     live->engine->blocker, url, Or(source, ""),
                     Or(type, "other"), Or(method, "GET"), Or(headers, "[]"));
}
bool CnameBlocked(const char* url,
                  const char* alias,
                  const char* source,
                  const char* top,
                  const char* type,
                  const char* method) {
  auto live = Filtering(top, url);
  return live && bay_blocker_cname_blocked(
                     live->engine->blocker, url, alias, Or(source, ""),
                     Or(type, "other"), Or(method, "GET"));
}
char* ContentSecurityPolicy(const char* url,
                            const char* source,
                            const char* top,
                            const char* type) {
  auto live = Filtering(top, url);
  if (!live)
    return nullptr;
  return CopyOf(bay_blocker_content_security_policy(
      live->engine->blocker, url, Or(source, ""), Or(type, "document")));
}
char* Scriptlets(const char* frame_url, const char* top_origin) {
  auto live = Filtering(top_origin, frame_url);
  if (!live)
    return nullptr;
  return CopyOf(bay_blocker_scriptlets(live->engine->blocker, frame_url));
}

// Files, on the blocker's sequence.
base::FilePath ListPath(const base::FilePath& directory, const std::string& id) {
  return directory.AppendASCII("lists").AppendASCII(id + ".txt");
}
std::optional<base::Value> ReadJson(const base::FilePath& path) {
  std::string text;
  if (!base::ReadFileToString(path, &text))
    return std::nullopt;
  return base::JSONReader::Read(text, base::JSON_PARSE_RFC);
}
void WriteJson(const base::FilePath& path, const base::Value& value) {
  const auto text = base::WriteJsonWithOptions(
      value, base::JSONWriter::OPTIONS_PRETTY_PRINT);
  if (text && !base::ImportantFileWriter::WriteFileAtomically(path, *text))
    LOG(WARNING) << "[blocker] couldn't write " << path;
}
std::optional<base::Value> JsonFrom(char* text) {
  if (!text)
    return std::nullopt;
  auto value = base::JSONReader::Read(text, base::JSON_PARSE_RFC);
  bay_string_free(text);
  return value;
}
std::vector<std::string> Strings(const base::ListValue* list) {
  std::vector<std::string> result;
  if (!list)
    return result;
  for (const auto& item : *list) {
    if (item.is_string() && !item.GetString().empty())
      result.push_back(item.GetString());
  }
  return result;
}
base::ListValue ListOf(const std::vector<std::string>& values) {
  base::ListValue list;
  for (const auto& value : values)
    list.Append(value);
  return list;
}
void Add(std::vector<std::string>& values, const std::string& value) {
  if (!std::ranges::contains(values, value))
    values.push_back(value);
}
void RemoveCovering(std::vector<std::string>& values, const std::string& host) {
  std::erase_if(values, [&](const std::string& entry) {
    return Covers(entry, host);
  });
}

// On the blocker's sequence: copies bundled lists in when none is on disk yet.
// They count as fetched long ago, so they update soon. Answers those still gone.
std::vector<std::string> Seed(const base::FilePath& directory,
                              const base::FilePath& resources,
                              const std::vector<std::string>& ids) {
  base::CreateDirectory(directory.AppendASCII("lists"));
  std::vector<std::string> absent;
  for (const auto& id : ids) {
    const auto path = ListPath(directory, id);
    if (base::PathExists(path))
      continue;
    const auto bundled =
        resources.AppendASCII("FilterLists").AppendASCII(id + ".txt");
    if (!base::PathExists(bundled) || !base::CopyFile(bundled, path))
      absent.push_back(id);
  }
  return absent;
}
std::vector<std::string> Absent(const base::FilePath& directory,
                                const std::vector<std::string>& ids) {
  std::vector<std::string> absent;
  for (const auto& id : ids) {
    if (!base::PathExists(ListPath(directory, id)))
      absent.push_back(id);
  }
  return absent;
}
std::string EngineKey(const base::FilePath& directory,
                      const std::vector<std::string>& ids) {
  std::string key = kEngineFormat;
  for (const auto& id : ids) {
    base::File::Info info;
    if (!base::GetFileInfo(ListPath(directory, id), &info))
      continue;
    key += base::StringPrintf(
        "\n%s %lld %.0f", id.c_str(), static_cast<long long>(info.size),
        info.last_modified.InSecondsFSinceUnixEpoch());
  }
  return key;
}
struct ListSource {
  std::string id;
  bool hosts = false;
};
BayBlocker* Compile(const base::FilePath& directory,
                    const std::vector<ListSource>& lists) {
  std::vector<std::string> texts;
  std::vector<const char*> pointers;
  auto hosts = std::make_unique<bool[]>(lists.size() + 1);
  std::vector<uint8_t> permissions;
  texts.reserve(lists.size());
  for (size_t i = 0; i < lists.size(); ++i) {
    std::string text;
    base::ReadFileToString(ListPath(directory, lists[i].id), &text);
    texts.push_back(std::move(text));
    pointers.push_back(texts.back().c_str());
    hosts[i] = lists[i].hosts;
    // As in uBO, only its own uAssets lists may invoke privileged scriptlets.
    permissions.push_back(lists[i].id.starts_with("ublock-") ? 1 : 0);
  }
  return bay_blocker_new_with_permissions(pointers.data(), hosts.get(),
                                          permissions.data(), pointers.size());
}
}  // namespace

struct ContentBlocker::Built {
  std::shared_ptr<Engine> engine;
  double ms = 0;
  std::map<std::string, std::pair<double, double>> counts;
};

namespace {
std::unique_ptr<ContentBlocker::Built> BuildEngine(
    base::FilePath directory,
    base::FilePath resources,
    std::vector<ListSource> wanted,
    bool use_cache);
}  // namespace

// static
ContentBlocker& ContentBlocker::Get() {
  static base::NoDestructor<ContentBlocker> blocker;
  return *blocker;
}
ContentBlocker::ContentBlocker()
    : work_(base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
           base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN})) {}
ContentBlocker::~ContentBlocker() = default;

void ContentBlocker::SetSink(Sink sink) {
  sink_ = std::move(sink);
}
const base::DictValue* ContentBlocker::List(const std::string& id) const {
  for (const auto& item : catalogue_) {
    const auto* list = item.GetIfDict();
    const auto* found = list ? list->FindString("id") : nullptr;
    if (found && *found == id)
      return list;
  }
  return nullptr;
}
void ContentBlocker::Prepare() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (!directory_.empty())
    return;
  base::PathService::Get(chrome::DIR_USER_DATA, &directory_);
  directory_ = directory_.AppendASCII("Content Blocker");
  base::FilePath module;
  base::PathService::Get(base::DIR_MODULE, &module);
  resources_ = module.AppendASCII("ContentBlocker");
  // Settings are read off this sequence, so nothing is filtered until then;
  // the engine isn't built yet anyway. Requests start ahead of it on macOS too.
  work_->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(
          [](base::FilePath directory, base::FilePath resources) {
            return std::make_pair(
                ReadJson(resources.AppendASCII("filter_lists.json")),
                ReadJson(directory.AppendASCII("settings.json")));
          },
          directory_, resources_),
      base::BindOnce(
          [](ContentBlocker* self,
             std::pair<std::optional<base::Value>, std::optional<base::Value>>
                 files) {
            self->SettingsRead(std::move(files.first), std::move(files.second));
          },
          base::Unretained(this)));
}
void ContentBlocker::WhenLoaded(base::OnceClosure ready) {
  if (loaded_)
    std::move(ready).Run();
  else
    waiting_.push_back(std::move(ready));
}
void ContentBlocker::SettingsRead(std::optional<base::Value> catalogue,
                                  std::optional<base::Value> saved) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  const auto* lists =
      catalogue && catalogue->is_dict() ? catalogue->GetDict().FindList("lists")
                                        : nullptr;
  if (lists) {
    for (const auto& item : *lists) {
      const auto* list = item.GetIfDict();
      if (list && list->FindString("id") && list->FindList("urls"))
        catalogue_.Append(list->Clone());
    }
  }
  if (catalogue_.empty())
    LOG(ERROR) << "[blocker] no filter list catalogue (filter_lists.json)";
  const auto* settings = saved ? saved->GetIfDict() : nullptr;
  enabled_ = !settings || settings->FindBool("enabled").value_or(true);
  const auto* chosen = settings ? settings->FindList("lists") : nullptr;
  if (chosen) {
    for (const auto& id : Strings(chosen)) {
      if (List(id))
        Add(selected_, id);
    }
  } else {
    for (const auto& item : catalogue_) {
      if (OnByDefault(item.GetDict()))
        selected_.push_back(*item.GetDict().FindString("id"));
    }
  }
  for (const auto& host :
       Strings(settings ? settings->FindList("allowedHosts") : nullptr))
    Add(allowed_, base::ToLowerASCII(host));
  for (const auto& host :
       Strings(settings ? settings->FindList("allowedPages") : nullptr))
    Add(allowed_pages_, base::ToLowerASCII(host));
  loaded_ = true;
  PublishLive();
  nncore::SetRequestFilter(&Filter);
  nncore::SetContentSecurityPolicySource(&ContentSecurityPolicy);
  nncore::SetScriptletSource(&Scriptlets);
  Rebuild(true, base::DoNothing());
  ScheduleUpdates(kFirstUpdate);
  for (auto& ready : std::exchange(waiting_, {}))
    std::move(ready).Run();
}
// The catalogue's default lists, and the regional ones for the user's language.
bool ContentBlocker::OnByDefault(const base::DictValue& list) const {
  const auto* lang = list.FindString("lang");
  return list.FindBool("defaultOn").value_or(false) ||
         (lang && content_blocker::LanguageMatches(
                      *lang, g_browser_process->GetApplicationLocale()));
}
void ContentBlocker::SaveSettings() {
  auto settings = base::DictValue()
                      .Set("enabled", enabled_)
                      .Set("lists", ListOf(selected_))
                      .Set("allowedHosts", ListOf(allowed_))
                      .Set("allowedPages", ListOf(allowed_pages_));
  work_->PostTask(
      FROM_HERE,
      base::BindOnce(
          [](base::FilePath directory, base::Value value) {
            base::CreateDirectory(directory);
            WriteJson(directory.AppendASCII("settings.json"), value);
          },
          directory_, base::Value(std::move(settings))));
}
std::vector<std::string> ContentBlocker::SelectedInOrder() const {
  std::vector<std::string> ids;
  for (const auto& item : catalogue_) {
    const auto* id = item.GetDict().FindString("id");
    if (std::ranges::contains(selected_, *id))
      ids.push_back(*id);
  }
  return ids;
}
void ContentBlocker::PublishLive() {
  auto live = std::make_shared<Live>();
  live->engine = std::static_pointer_cast<Engine>(engine_);
  live->enabled = enabled_;
  live->allowed = allowed_;
  live->pages = allowed_pages_;
  live->pages.insert(live->pages.end(), session_pages_.begin(),
                     session_pages_.end());
  // Only engines with such rules need every response marshalled to the host.
  const bool filtering = live->enabled && live->engine;
  BayBlocker* blocker = filtering ? live->engine->blocker : nullptr;
  nncore::SetResponseFilter(
      blocker && bay_blocker_has_response_modifiers(blocker) ? Response
                                                             : nullptr);
  const bool bodies = blocker && bay_blocker_has_body_modifiers(blocker);
  nncore::SetBodyFilter(bodies ? BodyFilterApplies : nullptr,
                        bodies ? BodyFiltered : nullptr);
  const bool headers =
      blocker && bay_blocker_has_request_header_modifiers(blocker);
  nncore::SetRequestHeaderFilter(headers ? RequestHeaderNames : nullptr,
                                 headers ? RequestHeadersBlocked : nullptr);
  nncore::SetCnameFilter(filtering ? CnameBlocked : nullptr);
  Publish(std::move(live));
}
void ContentBlocker::Emit() {
  if (sink_)
    sink_.Run(Stats());
}
void ContentBlocker::Changed() {
  SaveSettings();
  PublishLive();
  Emit();
}
base::DictValue ContentBlocker::Stats() const {
  double network = 0;
  double cosmetic = 0;
  for (const auto& [id, count] : counts_) {
    network += count.first;
    cosmetic += count.second;
  }
  const uint64_t lookups = g_lookups.load(std::memory_order_relaxed);
  const double average =
      lookups ? g_lookup_micros_x1000.load(std::memory_order_relaxed) / 1000.0 /
                    lookups
              : 0;
  const double max =
      g_max_lookup_micros_x1000.load(std::memory_order_relaxed) / 1000.0;
  return base::DictValue()
      .Set("ready", ready_)
      .Set("enabled", enabled_)
      .Set("networkFilters", network)
      .Set("cosmeticFilters", cosmetic)
      .Set("parseMs", std::round(parse_ms_))
      .Set("lookups", static_cast<double>(lookups))
      .Set("averageLookupMicros", std::round(average * 100) / 100)
      .Set("maxLookupMicros", std::round(max * 100) / 100);
}
base::DictValue ContentBlocker::State() {
  base::ListValue lists;
  for (const auto& item : catalogue_) {
    const auto& list = item.GetDict();
    const std::string id = *list.FindString("id");
    const auto* title = list.FindString("title");
    const auto* category = list.FindString("category");
    const auto count = counts_.find(id);
    lists.Append(
        base::DictValue()
            .Set("id", id)
            .Set("title", title ? *title : id)
            .Set("category", category ? *category : "ads")
            .Set("enabled", std::ranges::contains(selected_, id))
            .Set("defaultOn", OnByDefault(list))
            .Set("filters", count == counts_.end()
                                ? 0.0
                                : count->second.first + count->second.second));
  }
  return base::DictValue()
      .Set("enabled", enabled_)
      .Set("version", kVersion)
      .Set("lists", std::move(lists))
      .Set("allowedHosts", ListOf(allowed_))
      .Set("allowedPages", ListOf(allowed_pages_))
      .Set("stats", Stats());
}
void ContentBlocker::Rebuild(bool use_cache, Rebuilt done) {
  const uint64_t generation = ++generation_;
  auto ids = SelectedInOrder();
  work_->PostTaskAndReplyWithResult(
      FROM_HERE, base::BindOnce(&Seed, directory_, resources_, ids),
      base::BindOnce(&ContentBlocker::Seeded, base::Unretained(this),
                     generation, ids, use_cache, std::move(done)));
}
// Builds from the available files first, then again once missing lists have
// downloaded: bundled rules must already block meanwhile.
void ContentBlocker::Seeded(uint64_t generation,
                            std::vector<std::string> ids,
                            bool use_cache,
                            Rebuilt done,
                            std::vector<std::string> absent) {
  if (absent.empty()) {
    BuildAndPublish(generation, ids, use_cache, true, {}, std::move(done));
    return;
  }
  BuildAndPublish(generation, ids, use_cache, false, {}, base::DoNothing());
  Fetch(absent, 0, false,
        base::BindOnce(
            [](ContentBlocker* self, uint64_t generation,
               std::vector<std::string> ids, bool use_cache, Rebuilt done,
               bool) {
              self->work_->PostTaskAndReplyWithResult(
                  FROM_HERE,
                  base::BindOnce(&Absent, self->directory_, ids),
                  base::BindOnce(
                      [](ContentBlocker* self, uint64_t generation,
                         std::vector<std::string> ids, bool use_cache,
                         Rebuilt done, std::vector<std::string> missing) {
                        self->BuildAndPublish(generation, ids, use_cache, true,
                                              std::move(missing),
                                              std::move(done));
                      },
                      base::Unretained(self), generation, ids, use_cache,
                      std::move(done)));
            },
            base::Unretained(this), generation, std::move(ids), use_cache,
            std::move(done)));
}
void ContentBlocker::BuildAndPublish(uint64_t generation,
                                     const std::vector<std::string>& ids,
                                     bool use_cache,
                                     bool finished,
                                     std::vector<std::string> missing,
                                     Rebuilt done) {
  // A newer selection is on its way. Nothing counts as missing, so a stale
  // failure can't turn off a list a newer selection has on.
  if (generation != generation_) {
    if (finished)
      std::move(done).Run({});
    return;
  }
  std::vector<ListSource> wanted;
  for (const auto& id : ids) {
    const auto* list = List(id);
    wanted.push_back(
        {id, list && list->FindBool("hosts").value_or(false)});
  }
  work_->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(&BuildEngine, directory_, resources_, std::move(wanted),
                     use_cache),
      base::BindOnce(&ContentBlocker::Apply, base::Unretained(this), generation,
                     finished, std::move(missing), std::move(done)));
}
void ContentBlocker::Apply(uint64_t generation,
                           bool finished,
                           std::vector<std::string> missing,
                           Rebuilt done,
                           std::unique_ptr<Built> built) {
  const bool current = generation == generation_;
  if (current) {
    LOG(INFO) << "[blocker] " << built->counts.size() << " lists in "
              << built->ms << " ms";
    engine_ = std::move(built->engine);
    parse_ms_ = built->ms;
    counts_ = std::move(built->counts);
    ready_ = true;
    PublishLive();
    Emit();
  }
  if (finished)
    std::move(done).Run(current ? std::move(missing)
                                : std::vector<std::string>());
}
void ContentBlocker::UpdateLists() {
  work_->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(
          [](base::FilePath directory, std::vector<std::string> ids) {
            auto info = ReadJson(directory.AppendASCII("lists.json"));
            const auto* entries = info ? info->GetIfDict() : nullptr;
            const double now = base::Time::Now().InSecondsFSinceUnixEpoch();
            std::vector<std::string> due;
            for (const auto& id : ids) {
              const auto* entry = entries ? entries->FindDict(id) : nullptr;
              const double fetched =
                  entry ? entry->FindDouble("fetched").value_or(0) : 0;
              const double expires =
                  entry ? entry->FindDouble("expires").value_or(0) : 0;
              if (fetched + expires <= now)
                due.push_back(id);
            }
            return due;
          },
          directory_, SelectedInOrder()),
      base::BindOnce(
          [](ContentBlocker* self, std::vector<std::string> due) {
            self->Fetch(std::move(due), 0, false,
                        base::BindOnce(
                            [](ContentBlocker* self, bool changed) {
                              if (changed)
                                self->Rebuild(true, base::DoNothing());
                            },
                            base::Unretained(self)));
          },
          base::Unretained(this)));
}
void ContentBlocker::Fetch(std::vector<std::string> ids,
                           size_t next,
                           bool changed,
                           base::OnceCallback<void(bool changed)> done) {
  if (next >= ids.size()) {
    std::move(done).Run(changed);
    return;
  }
  FetchFrom(std::move(ids), next, changed, 0, std::move(done));
}
// A list from its first URL that answers, one list at a time.
void ContentBlocker::FetchFrom(std::vector<std::string> ids,
                               size_t next,
                               bool changed,
                               size_t url,
                               base::OnceCallback<void(bool changed)> done) {
  const auto* list = List(ids[next]);
  const auto* urls = list ? list->FindList("urls") : nullptr;
  if (!urls || url >= urls->size() || !(*urls)[url].is_string()) {
    Fetch(std::move(ids), next + 1, changed, std::move(done));
    return;
  }
  auto request = std::make_unique<network::ResourceRequest>();
  request->url = GURL((*urls)[url].GetString());
  request->credentials_mode = network::mojom::CredentialsMode::kOmit;
  request->load_flags = net::LOAD_BYPASS_CACHE | net::LOAD_DISABLE_CACHE;
  auto loader = network::SimpleURLLoader::Create(std::move(request),
                                                 kListsAnnotation);
  loader->SetTimeoutDuration(base::Seconds(60));
  auto* raw = loader.get();
  raw->DownloadToString(
      g_browser_process->system_network_context_manager()
          ->GetSharedURLLoaderFactory()
          .get(),
      base::BindOnce(&ContentBlocker::Fetched, base::Unretained(this),
                     std::move(ids), next, changed, url, std::move(done),
                     std::move(loader)),
      kMaxList);
}
void ContentBlocker::Fetched(std::vector<std::string> ids,
                             size_t next,
                             bool changed,
                             size_t url,
                             base::OnceCallback<void(bool changed)> done,
                             std::unique_ptr<network::SimpleURLLoader> loader,
                             std::optional<std::string> body) {
  if (!body || !content_blocker::LooksLikeList(*body)) {
    LOG(WARNING) << "[blocker] " << ids[next] << ": " << loader->NetError();
    FetchFrom(std::move(ids), next, changed, url + 1, std::move(done));
    return;
  }
  const std::string id = ids[next];
  work_->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(
          [](base::FilePath directory, std::string id, std::string body) {
            const auto path = ListPath(directory, id);
            std::string old;
            const bool differs =
                !base::ReadFileToString(path, &old) || old != body;
            if (differs)
              base::ImportantFileWriter::WriteFileAtomically(path, body);
            const auto index = directory.AppendASCII("lists.json");
            auto info = ReadJson(index);
            base::DictValue entries;
            if (info && info->is_dict())
              entries = std::move(info->GetDict());
            entries.Set(
                id, base::DictValue()
                        .Set("fetched",
                             base::Time::Now().InSecondsFSinceUnixEpoch())
                        .Set("expires", content_blocker::ExpiresAfter(body)
                                            .InSecondsF()));
            WriteJson(index, base::Value(std::move(entries)));
            return differs;
          },
          directory_, id, std::move(*body)),
      base::BindOnce(
          [](ContentBlocker* self, std::vector<std::string> ids, size_t next,
             bool changed, base::OnceCallback<void(bool)> done, bool differs) {
            self->Fetch(std::move(ids), next + 1, changed || differs,
                        std::move(done));
          },
          base::Unretained(this), std::move(ids), next, changed,
          std::move(done)));
}
void ContentBlocker::ScheduleUpdates(base::TimeDelta after) {
  updates_.Start(FROM_HERE, after, base::BindOnce(
                                       [](ContentBlocker* self) {
                                         if (self->enabled_)
                                           self->UpdateLists();
                                         self->ScheduleUpdates(kUpdateEvery);
                                       },
                                       base::Unretained(this)));
}
void ContentBlocker::SetEnabled(bool enabled, Done done) {
  const bool was_enabled = enabled_;
  enabled_ = enabled;
  Changed();
  // Back on after a while off: its lists may have gone stale meanwhile.
  if (enabled && !was_enabled)
    UpdateLists();
  std::move(done).Run(std::nullopt);
}
void ContentBlocker::SetListEnabled(const std::string& id,
                                    bool enabled,
                                    Done done) {
  if (!List(id)) {
    std::move(done).Run("no list " + id);
    return;
  }
  if (enabled == std::ranges::contains(selected_, id)) {
    std::move(done).Run(std::nullopt);
    return;
  }
  if (enabled)
    selected_.push_back(id);
  else
    std::erase(selected_, id);
  SaveSettings();
  // Done when the engine has it (a new list downloads first). A list that
  // couldn't be downloaded isn't turned on.
  Rebuild(true, base::BindOnce(
                    [](ContentBlocker* self, std::string id, bool enabled,
                       Done done, std::vector<std::string> missing) {
                      if (!enabled || !std::ranges::contains(missing, id)) {
                        std::move(done).Run(std::nullopt);
                        return;
                      }
                      std::erase(self->selected_, id);
                      self->SaveSettings();
                      self->Rebuild(true, base::DoNothing());
                      std::move(done).Run("couldn't download " + id);
                    },
                    base::Unretained(this), id, enabled, std::move(done)));
}
bool ContentBlocker::IsAllowed(const std::string& host) {
  const std::string name = HostOf(host);
  return std::ranges::any_of(allowed_, [&](const std::string& allowed) {
    return Covers(allowed, name);
  });
}
void ContentBlocker::SetAllowed(const std::string& host,
                                bool allowed,
                                Done done) {
  const std::string name = HostOf(host);
  if (name.empty()) {
    std::move(done).Run("no host");
    return;
  }
  if (allowed)
    Add(allowed_, name);
  else
    RemoveCovering(allowed_, name);
  Changed();
  std::move(done).Run(std::nullopt);
}
void ContentBlocker::SetPageAllowed(const std::string& host,
                                    bool allowed,
                                    bool remember,
                                    Done done) {
  const std::string name = HostOf(host);
  if (name.empty()) {
    std::move(done).Run("no host");
    return;
  }
  if (allowed) {
    Add(remember ? allowed_pages_ : session_pages_, name);
  } else {
    RemoveCovering(allowed_pages_, name);
    RemoveCovering(session_pages_, name);
  }
  Changed();
  std::move(done).Run(std::nullopt);
}

// static
bool ContentBlocker::BlocksPage(const std::string& url) {
  const char* page = url.c_str();
  return Filter(page, page, page, "document", "GET", nullptr, nullptr);
}

namespace {
bool IsWeb(const std::string& url) {
  return url.starts_with("http://") || url.starts_with("https://");
}
struct FrameCosmetics {
  std::shared_ptr<const Live> live;
  base::DictValue resources;
};
std::optional<FrameCosmetics> ForFrame(const std::string& frame_url,
                                       const std::string& page_url) {
  if (!IsWeb(frame_url))
    return std::nullopt;
  auto live = Filtering(page_url.c_str(), nullptr);
  if (!live)
    return std::nullopt;
  auto found = JsonFrom(bay_blocker_cosmetic(live->engine->blocker,
                                             frame_url.c_str()));
  if (!found || !found->is_dict())
    return std::nullopt;
  return FrameCosmetics{std::move(live), std::move(found->GetDict())};
}
}  // namespace

// static
std::optional<ContentBlocker::Cosmetics> ContentBlocker::CosmeticsFor(
    const std::string& frame_url,
    const std::string& page_url) {
  auto frame = ForFrame(frame_url, page_url);
  if (!frame)
    return std::nullopt;
  Cosmetics cosmetics;
  cosmetics.css =
      content_blocker::StyleFor(Strings(frame->resources.FindList("hide")));
  cosmetics.generic = !frame->resources.FindBool("generichide").value_or(false);
  if (auto* procedural = frame->resources.FindList("procedural"))
    cosmetics.procedural = procedural->Clone();
  return cosmetics;
}
// static
std::optional<std::string> ContentBlocker::GenericStyle(
    const std::string& frame_url,
    const std::string& page_url,
    const std::vector<std::string>& classes,
    const std::vector<std::string>& ids) {
  auto frame = ForFrame(frame_url, page_url);
  if (!frame || frame->resources.FindBool("generichide").value_or(false))
    return std::nullopt;
  auto query = base::DictValue()
                   .Set("classes", ListOf(classes))
                   .Set("ids", ListOf(ids))
                   .Set("exceptions", ListOf(Strings(frame->resources.FindList(
                                          "exceptions"))));
  const auto text = base::WriteJson(query);
  if (!text)
    return std::nullopt;
  auto selectors = JsonFrom(
      bay_blocker_hidden_selectors(frame->live->engine->blocker, text->c_str()));
  if (!selectors || !selectors->is_list())
    return std::nullopt;
  return content_blocker::StyleFor(Strings(&selectors->GetList()));
}

namespace {
std::unique_ptr<ContentBlocker::Built> BuildEngine(
    base::FilePath directory,
    base::FilePath resources,
    std::vector<ListSource> wanted,
    bool use_cache) {
  auto built = std::make_unique<ContentBlocker::Built>();
  const base::TimeTicks start = base::TimeTicks::Now();
  std::vector<ListSource> present;
  std::vector<std::string> ids;
  for (auto& list : wanted) {
    if (base::PathExists(ListPath(directory, list.id))) {
      ids.push_back(list.id);
      present.push_back(std::move(list));
    }
  }
  const std::string key = EngineKey(directory, ids);
  const auto engine_path = directory.AppendASCII("engine.dat");
  const auto key_path = directory.AppendASCII("engine.key");
  const auto meta_path = directory.AppendASCII("engine.lists.json");
  BayBlocker* blocker = nullptr;
  std::string cached_key;
  if (use_cache && base::ReadFileToString(key_path, &cached_key) &&
      cached_key == key) {
    auto data = std::make_unique<std::string>();
    auto cached_ids = ReadJson(meta_path);
    if (base::ReadFileToString(engine_path, data.get()) && cached_ids &&
        cached_ids->is_list() && Strings(&cached_ids->GetList()) == ids) {
      // Rust keeps the bytes until the engine is freed, or releases them on failure.
      auto* owner = data.release();
      blocker = bay_blocker_deserialize(
          reinterpret_cast<const uint8_t*>(owner->data()), owner->size(), owner,
          [](void* bytes) { delete static_cast<std::string*>(bytes); });
    }
  }
  if (!blocker) {
    blocker = Compile(directory, present);
    size_t length = 0;
    uint8_t* bytes = bay_blocker_serialize(blocker, &length);
    if (base::ImportantFileWriter::WriteFileAtomically(
            engine_path,
            std::string_view(reinterpret_cast<const char*>(bytes), length))) {
      WriteJson(meta_path, base::Value(ListOf(ids)));
      base::ImportantFileWriter::WriteFileAtomically(key_path, key);
    }
    bay_bytes_free(bytes, length);
  }
  // Resources aren't in the serialized engine: load them for new and cached
  // engines alike, so scriptlets and stand-ins work on every launch.
  std::string scriptlets;
  if (!base::ReadFileToString(resources.AppendASCII("blocker-resources.json"),
                              &scriptlets) ||
      !bay_blocker_use_resources(blocker, scriptlets.c_str())) {
    LOG(ERROR) << "[blocker] missing or invalid scriptlet resources";
  }
  auto counts = JsonFrom(bay_blocker_list_counts(blocker));
  if (counts && counts->is_list() && counts->GetList().size() == ids.size()) {
    for (size_t i = 0; i < ids.size(); ++i) {
      const auto* count = counts->GetList()[i].GetIfDict();
      if (!count)
        continue;
      built->counts[ids[i]] = {
          count->FindDouble("networkFilters").value_or(0),
          count->FindDouble("cosmeticFilters").value_or(0)};
    }
  }
  built->engine = std::make_shared<Engine>(blocker);
  built->ms = (base::TimeTicks::Now() - start).InMillisecondsF();
  return built;
}
}  // namespace

}  // namespace bay
