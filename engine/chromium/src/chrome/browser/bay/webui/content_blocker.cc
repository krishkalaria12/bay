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
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/location.h"
#include "base/logging.h"
#include "base/memory/raw_ptr_exclusion.h"
#include "base/path_service.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "bay/core/nn_request_filter.h"
#include "chrome/browser/bay/webui/bay_adblock.h"
#include "chrome/browser/bay/webui/bay_lists.h"
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

// The longest list downloaded. bay-lists refuses longer ones too.
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

// bay-lists answers and their files, off the UI sequence where they touch the disk.
std::string Utf8(const base::FilePath& path) {
  return path.AsUTF8Unsafe();
}
std::optional<base::Value> JsonFrom(char* text) {
  if (!text)
    return std::nullopt;
  auto value = base::JSONReader::Read(text, base::JSON_PARSE_RFC);
  bay_string_free(text);
  return value;
}
std::string TextFrom(char* text) {
  std::string copy = text ? text : "";
  bay_string_free(text);
  return copy;
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
std::vector<std::string> StringsFrom(char* text) {
  auto value = JsonFrom(text);
  return value && value->is_list() ? Strings(&value->GetList())
                                   : std::vector<std::string>();
}
base::ListValue ListOf(const std::vector<std::string>& values) {
  base::ListValue list;
  for (const auto& value : values)
    list.Append(value);
  return list;
}
double Now() {
  return base::Time::Now().InSecondsFSinceUnixEpoch();
}
// The request filter's timing, for the stats.
std::string Timing() {
  const uint64_t lookups = g_lookups.load(std::memory_order_relaxed);
  const double average =
      lookups ? g_lookup_micros_x1000.load(std::memory_order_relaxed) / 1000.0 /
                    lookups
              : 0;
  const double max =
      g_max_lookup_micros_x1000.load(std::memory_order_relaxed) / 1000.0;
  return base::WriteJson(
             base::DictValue()
                 .Set("lookups", static_cast<double>(lookups))
                 .Set("averageLookupMicros", std::round(average * 100) / 100)
                 .Set("maxLookupMicros", std::round(max * 100) / 100))
      .value_or("null");
}

content_blocker::BuiltEngine BuildEngine(base::FilePath directory,
                                         base::FilePath resources,
                                         std::string lists,
                                         bool use_cache) {
  content_blocker::BuiltEngine built(bay_lists_build(
      Utf8(directory).c_str(), lists.c_str(),
      Utf8(resources.AppendASCII("blocker-resources.json")).c_str(),
      use_cache));
  if (!built)
    return built;
  if (auto report = JsonFrom(bay_lists_built_report(built.get()));
      report && report->is_dict()) {
    LOG(INFO) << "[blocker] " << report->GetDict().FindInt("lists").value_or(0)
              << " lists in " << report->GetDict().FindDouble("ms").value_or(0)
              << " ms";
    if (!report->GetDict().FindBool("resources").value_or(false))
      LOG(ERROR) << "[blocker] missing or invalid scriptlet resources";
  }
  return built;
}
}  // namespace

namespace content_blocker {
void BuiltEngineFree::operator()(BayListsBuilt* built) const {
  bay_lists_built_free(built);
}
}  // namespace content_blocker

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
void ContentBlocker::Prepare() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (!directory_.empty())
    return;
  base::PathService::Get(chrome::DIR_USER_DATA, &directory_);
  directory_ = directory_.AppendASCII("Content Blocker");
  base::FilePath module;
  base::PathService::Get(base::DIR_MODULE, &module);
  resources_ = module.AppendASCII("ContentBlocker");
  // The regional lists on by default follow the application's language.
  const std::string languages =
      base::WriteJson(base::ListValue().Append(
                          g_browser_process->GetApplicationLocale()))
          .value_or("[]");
  // Settings are read off this sequence, so nothing is filtered until then;
  // the engine isn't built yet anyway. Requests start ahead of it on macOS too.
  work_->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(
          [](base::FilePath directory, base::FilePath resources,
             std::string languages) {
            return bay_lists_open(
                Utf8(directory).c_str(),
                Utf8(resources.AppendASCII("filter_lists.json")).c_str(),
                languages.c_str());
          },
          directory_, resources_, languages),
      base::BindOnce(&ContentBlocker::Opened, base::Unretained(this)));
}
void ContentBlocker::WhenLoaded(base::OnceClosure ready) {
  if (loaded_)
    std::move(ready).Run();
  else
    waiting_.push_back(std::move(ready));
}
void ContentBlocker::Opened(BayLists* lists) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  lists_ = lists;
  if (!bay_lists_catalogue_size(lists_))
    LOG(ERROR) << "[blocker] no filter list catalogue (filter_lists.json)";
  loaded_ = true;
  PublishLive();
  nncore::SetRequestFilter(&Filter);
  nncore::SetContentSecurityPolicySource(&ContentSecurityPolicy);
  nncore::SetScriptletSource(&Scriptlets);
  Rebuild(true, base::DoNothing());
  ScheduleUpdates(base::Seconds(bay_lists_first_update_seconds()));
  for (auto& ready : std::exchange(waiting_, {}))
    std::move(ready).Run();
}
void ContentBlocker::SaveSettings() {
  work_->PostTask(FROM_HERE, base::BindOnce(
                                 [](ContentBlocker* self) {
                                   if (!bay_lists_save(self->lists_))
                                     LOG(WARNING)
                                         << "[blocker] couldn't write settings";
                                 },
                                 base::Unretained(this)));
}
void ContentBlocker::PublishLive() {
  auto live = std::make_shared<Live>();
  live->engine = std::static_pointer_cast<Engine>(engine_);
  if (auto settings = JsonFrom(bay_lists_live(lists_));
      settings && settings->is_dict()) {
    live->enabled = settings->GetDict().FindBool("enabled").value_or(true);
    live->allowed = Strings(settings->GetDict().FindList("allowed"));
    live->pages = Strings(settings->GetDict().FindList("pages"));
  }
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
  if (!lists_)
    return base::DictValue();
  auto stats = JsonFrom(bay_lists_stats(lists_, Timing().c_str()));
  return stats && stats->is_dict() ? std::move(stats->GetDict())
                                   : base::DictValue();
}
base::DictValue ContentBlocker::State() {
  if (!lists_)
    return base::DictValue();
  auto state = JsonFrom(bay_lists_state(lists_, Timing().c_str()));
  return state && state->is_dict() ? std::move(state->GetDict())
                                   : base::DictValue();
}
void ContentBlocker::Rebuild(bool use_cache, Rebuilt done) {
  const uint64_t generation = ++generation_;
  std::string ids = TextFrom(bay_lists_selected_ids(lists_));
  std::string lists = TextFrom(bay_lists_selected(lists_));
  // Copies bundled lists in when none is on disk yet. They count as fetched
  // long ago, so they update soon. Answers those still gone.
  work_->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(
          [](base::FilePath directory, base::FilePath resources,
             std::string ids) {
            return StringsFrom(bay_lists_seed(
                Utf8(directory).c_str(),
                Utf8(resources.AppendASCII("FilterLists")).c_str(),
                ids.c_str()));
          },
          directory_, resources_, ids),
      base::BindOnce(&ContentBlocker::Seeded, base::Unretained(this),
                     generation, std::move(ids), std::move(lists), use_cache,
                     std::move(done)));
}
// Builds from the available files first, then again once missing lists have
// downloaded: bundled rules must already block meanwhile.
void ContentBlocker::Seeded(uint64_t generation,
                            std::string ids,
                            std::string lists,
                            bool use_cache,
                            Rebuilt done,
                            std::vector<std::string> absent) {
  if (absent.empty()) {
    BuildAndPublish(generation, lists, use_cache, true, {}, std::move(done));
    return;
  }
  BuildAndPublish(generation, lists, use_cache, false, {}, base::DoNothing());
  Fetch(absent, 0, false,
        base::BindOnce(
            [](ContentBlocker* self, uint64_t generation, std::string ids,
               std::string lists, bool use_cache, Rebuilt done, bool) {
              self->work_->PostTaskAndReplyWithResult(
                  FROM_HERE,
                  base::BindOnce(
                      [](base::FilePath directory, std::string ids) {
                        return StringsFrom(bay_lists_absent(
                            Utf8(directory).c_str(), ids.c_str()));
                      },
                      self->directory_, std::move(ids)),
                  base::BindOnce(
                      [](ContentBlocker* self, uint64_t generation,
                         std::string lists, bool use_cache, Rebuilt done,
                         std::vector<std::string> missing) {
                        self->BuildAndPublish(generation, lists, use_cache,
                                              true, std::move(missing),
                                              std::move(done));
                      },
                      base::Unretained(self), generation, std::move(lists),
                      use_cache, std::move(done)));
            },
            base::Unretained(this), generation, std::move(ids),
            std::move(lists), use_cache, std::move(done)));
}
void ContentBlocker::BuildAndPublish(uint64_t generation,
                                     const std::string& lists,
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
  work_->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(&BuildEngine, directory_, resources_, lists, use_cache),
      base::BindOnce(&ContentBlocker::Apply, base::Unretained(this), generation,
                     finished, std::move(missing), std::move(done)));
}
void ContentBlocker::Apply(uint64_t generation,
                           bool finished,
                           std::vector<std::string> missing,
                           Rebuilt done,
                           content_blocker::BuiltEngine built) {
  const bool current = generation == generation_ && built;
  if (current) {
    engine_ = std::make_shared<Engine>(bay_lists_apply(lists_, built.release()));
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
          [](base::FilePath directory, std::string ids) {
            return StringsFrom(
                bay_lists_due(Utf8(directory).c_str(), ids.c_str(), Now()));
          },
          directory_, TextFrom(bay_lists_selected_ids(lists_))),
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
// A list from its first URL that answers with a list, one list at a time.
void ContentBlocker::FetchFrom(std::vector<std::string> ids,
                               size_t next,
                               bool changed,
                               size_t url,
                               base::OnceCallback<void(bool changed)> done) {
  const auto urls = StringsFrom(bay_lists_urls(lists_, ids[next].c_str()));
  if (url >= urls.size()) {
    Fetch(std::move(ids), next + 1, changed, std::move(done));
    return;
  }
  auto request = std::make_unique<network::ResourceRequest>();
  request->url = GURL(urls[url]);
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
  if (!body) {
    LOG(WARNING) << "[blocker] " << ids[next] << ": " << loader->NetError();
    FetchFrom(std::move(ids), next, changed, url + 1, std::move(done));
    return;
  }
  const std::string id = ids[next];
  work_->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(
          [](base::FilePath directory, std::string id, std::string body) {
            return bay_lists_store(Utf8(directory).c_str(), id.c_str(),
                                   reinterpret_cast<const uint8_t*>(body.data()),
                                   body.size(), Now());
          },
          directory_, id, std::move(*body)),
      base::BindOnce(
          [](ContentBlocker* self, std::vector<std::string> ids, size_t next,
             bool changed, size_t url, base::OnceCallback<void(bool)> done,
             int32_t stored) {
            // An error page, not a list: the list's next URL.
            if (stored == -1) {
              LOG(WARNING) << "[blocker] " << ids[next] << ": not a list";
              self->FetchFrom(std::move(ids), next, changed, url + 1,
                              std::move(done));
              return;
            }
            self->Fetch(std::move(ids), next + 1, changed || stored == 1,
                        std::move(done));
          },
          base::Unretained(this), std::move(ids), next, changed, url,
          std::move(done)));
}
void ContentBlocker::ScheduleUpdates(base::TimeDelta after) {
  updates_.Start(
      FROM_HERE, after, base::BindOnce(
                            [](ContentBlocker* self) {
                              if (bay_lists_enabled(self->lists_))
                                self->UpdateLists();
                              self->ScheduleUpdates(base::Seconds(
                                  bay_lists_update_every_seconds()));
                            },
                            base::Unretained(this)));
}
void ContentBlocker::SetEnabled(bool enabled, Done done) {
  const bool turned_on = bay_lists_set_enabled(lists_, enabled);
  Changed();
  // Back on after a while off: its lists may have gone stale meanwhile.
  if (turned_on)
    UpdateLists();
  std::move(done).Run(std::nullopt);
}
void ContentBlocker::SetListEnabled(const std::string& id,
                                    bool enabled,
                                    Done done) {
  const int32_t changed = bay_lists_set_list(lists_, id.c_str(), enabled);
  if (changed < 0) {
    std::move(done).Run("no list " + id);
    return;
  }
  if (!changed) {
    std::move(done).Run(std::nullopt);
    return;
  }
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
                      bay_lists_set_list(self->lists_, id.c_str(), false);
                      self->SaveSettings();
                      self->Rebuild(true, base::DoNothing());
                      std::move(done).Run("couldn't download " + id);
                    },
                    base::Unretained(this), id, enabled, std::move(done)));
}
bool ContentBlocker::IsAllowed(const std::string& host) {
  return bay_lists_is_allowed(lists_, host.c_str());
}
void ContentBlocker::SetAllowed(const std::string& host,
                                bool allowed,
                                Done done) {
  // Blocking again ends every pause that covers the host.
  if (!bay_lists_set_allowed(lists_, host.c_str(), allowed)) {
    std::move(done).Run("no host");
    return;
  }
  Changed();
  std::move(done).Run(std::nullopt);
}
void ContentBlocker::SetPageAllowed(const std::string& host,
                                    bool allowed,
                                    bool remember,
                                    Done done) {
  if (!bay_lists_set_page_allowed(lists_, host.c_str(), allowed, remember)) {
    std::move(done).Run("no host");
    return;
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

}  // namespace bay
