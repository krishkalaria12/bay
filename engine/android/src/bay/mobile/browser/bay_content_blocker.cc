// Copyright 2026 Bay authors. The filter callbacks follow packages/chromium/ios/NNCoreContentBlocker.mm, desktop's.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#include "bay/mobile/browser/bay_content_blocker.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <utility>

#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/strings/string_util.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/values.h"
#include "bay/filter/nn_request_filter.h"
#include "bay/mobile/adblock/bay_adblock.h"
#include "content/public/browser/global_routing_id.h"
#include "url/gurl.h"

namespace bay {

namespace {

// The compiled lists. Shared by every request in flight; replaced whole when the lists change.
struct Engine {
  explicit Engine(BayBlocker* blocker) : blocker(blocker) {}
  ~Engine() { bay_blocker_free(blocker); }
  Engine(const Engine&) = delete;
  Engine& operator=(const Engine&) = delete;
  BayBlocker* const blocker;
};

// What the callbacks read on any thread: replaced whole (never changed in place) under the lock.
struct Live {
  std::shared_ptr<Engine> engine;
  std::vector<std::string> paused;
};

std::mutex& LiveLock() {
  static std::mutex lock;
  return lock;
}

std::shared_ptr<const Live>& LiveSlot() {
  static std::shared_ptr<const Live> live = std::make_shared<Live>();
  return live;
}

std::shared_ptr<const Live> CurrentLive() {
  std::lock_guard<std::mutex> lock(LiveLock());
  return LiveSlot();
}

void Publish(std::shared_ptr<const Live> live) {
  std::lock_guard<std::mutex> lock(LiveLock());
  LiveSlot() = std::move(live);
}

std::string HostOf(const char* url) {
  if (!url || !*url) {
    return std::string();
  }
  return base::ToLowerASCII(GURL(url).host());
}

// A paused site covers its subdomains: "example.com" covers "www.example.com".
bool Covers(const std::string& paused, const std::string& host) {
  if (paused.empty() || host.empty()) {
    return false;
  }
  return host == paused || (host.size() > paused.size() && base::EndsWith(host, "." + paused));
}

// The engine to filter with for a page, or null when blocking is off or paused on its site.
std::shared_ptr<Engine> EngineFor(const char* top, const char* fallback) {
  std::shared_ptr<const Live> live = CurrentLive();
  if (!live->engine) {
    return nullptr;
  }
  const std::string host = HostOf(top && *top ? top : fallback);
  for (const std::string& paused : live->paused) {
    if (Covers(paused, host)) {
      return nullptr;
    }
  }
  return live->engine;
}

// The engine owns strings it returns; the request filter frees with free().
char* Copy(char* owned) {
  char* copy = owned ? strdup(owned) : nullptr;
  bay_string_free(owned);
  return copy;
}

bool Filter(const char* url,
            const char* source,
            const char* top,
            const char* type,
            const char* method,
            char** redirect,
            bool* any_origin) {
  if (redirect) {
    *redirect = nullptr;
  }
  if (any_origin) {
    *any_origin = false;
  }
  std::shared_ptr<Engine> engine = EngineFor(top, source);
  if (!engine) {
    return false;
  }
  BayBlockerMatch match =
      bay_blocker_match(engine->blocker, url, source ? source : "", type ? type : "other", method ? method : "GET");
  // A blocked request's stand-in, or an allowed one's URL without its tracking parameters.
  const char* answer = match.blocked ? match.redirect : match.rewrite;
  if (redirect && answer) {
    *redirect = strdup(answer);
  }
  if (any_origin && !match.blocked && match.rewrite_any_origin) {
    *any_origin = true;
  }
  bay_string_free(match.redirect);
  bay_string_free(match.rewrite);
  return match.blocked;
}

char* Response(const char* url,
               const char* source,
               const char* top,
               const char* type,
               const char* method,
               const char* ip,
               const char* headers) {
  std::shared_ptr<Engine> engine = EngineFor(top, source);
  if (!engine) {
    return nullptr;
  }
  return Copy(bay_blocker_response(engine->blocker, url, source ? source : "", type ? type : "other",
                                   method ? method : "GET", ip, headers ? headers : "[]"));
}

bool BodyFilterApplies(const char* url,
                       const char* source,
                       const char* top,
                       const char* type,
                       const char* method,
                       int status,
                       const char* content_type,
                       const char* content_disposition) {
  std::shared_ptr<Engine> engine = EngineFor(top, url);
  return engine && bay_blocker_body_filter_applies(engine->blocker, url, source ? source : "", type ? type : "other",
                                                   method ? method : "GET", status, content_type ? content_type : "",
                                                   content_disposition ? content_disposition : "");
}

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
  std::shared_ptr<Engine> engine = EngineFor(top, url);
  if (!engine) {
    return nullptr;
  }
  size_t filtered_length = 0;
  uint8_t* filtered = bay_blocker_body_filter(engine->blocker, url, source ? source : "", type ? type : "other",
                                              method ? method : "GET", content_type ? content_type : "", body, length,
                                              &filtered_length);
  if (!filtered) {
    return nullptr;
  }
  auto* copy = static_cast<uint8_t*>(malloc(filtered_length ? filtered_length : 1));
  if (copy) {
    memcpy(copy, filtered, filtered_length);
    *out_length = filtered_length;
  }
  bay_bytes_free(filtered, filtered_length);
  return copy;
}

char* RequestHeaderNames(const char* url, const char* source, const char* top, const char* type, const char* method) {
  std::shared_ptr<Engine> engine = EngineFor(top, url);
  if (!engine) {
    return nullptr;
  }
  return Copy(bay_blocker_request_header_names(engine->blocker, url, source ? source : "", type ? type : "other",
                                               method ? method : "GET"));
}

bool RequestHeadersBlocked(const char* url,
                           const char* source,
                           const char* top,
                           const char* type,
                           const char* method,
                           const char* headers) {
  std::shared_ptr<Engine> engine = EngineFor(top, url);
  return engine && bay_blocker_request_headers_blocked(engine->blocker, url, source ? source : "",
                                                       type ? type : "other", method ? method : "GET",
                                                       headers ? headers : "[]");
}

bool CnameBlocked(const char* url,
                  const char* alias,
                  const char* source,
                  const char* top,
                  const char* type,
                  const char* method) {
  std::shared_ptr<Engine> engine = EngineFor(top, url);
  return engine && bay_blocker_cname_blocked(engine->blocker, url, alias, source ? source : "", type ? type : "other",
                                             method ? method : "GET");
}

char* ContentSecurityPolicy(const char* url, const char* source, const char* top, const char* type) {
  std::shared_ptr<Engine> engine = EngineFor(top, url);
  if (!engine) {
    return nullptr;
  }
  return Copy(
      bay_blocker_content_security_policy(engine->blocker, url, source ? source : "", type ? type : "document"));
}

char* Scriptlets(const char* frame_url, const char* top_origin) {
  std::shared_ptr<Engine> engine = EngineFor(top_origin, frame_url);
  return engine ? Copy(bay_blocker_scriptlets(engine->blocker, frame_url)) : nullptr;
}

std::shared_ptr<Engine> Load(const std::vector<std::string>& files,
                             const std::string& version,
                             const std::string& cache_path,
                             const std::string& resources_path) {
  std::vector<const char*> paths;
  for (const std::string& file : files) {
    paths.push_back(file.c_str());
  }
  // Platform 3: Android's Chromium engine (packages/adblock's Platform::AndroidChromium).
  BayBlocker* blocker = bay_blocker_load(paths.data(), paths.size(), cache_path.c_str(), version.c_str(),
                                         resources_path.empty() ? nullptr : resources_path.c_str(), 3);
  return blocker ? std::make_shared<Engine>(blocker) : nullptr;
}

}  // namespace

// static
void BayContentBlocker::Install() {
  nncore::SetRequestFilter(&Filter);
  nncore::SetContentSecurityPolicySource(&ContentSecurityPolicy);
  nncore::SetResponseFilter(&Response);
  nncore::SetBodyFilter(&BodyFilterApplies, &BodyFiltered);
  nncore::SetRequestHeaderFilter(&RequestHeaderNames, &RequestHeadersBlocked);
  nncore::SetCnameFilter(&CnameBlocked);
  nncore::SetScriptletSource(&Scriptlets);
}

// static
void BayContentBlocker::SetLists(std::vector<std::string> files,
                                 std::string version,
                                 std::string cache_path,
                                 std::string resources_path,
                                 base::OnceCallback<void(bool)> done) {
  if (files.empty()) {
    auto live = std::make_shared<Live>(*CurrentLive());
    live->engine = nullptr;
    Publish(std::move(live));
    std::move(done).Run(true);
    return;
  }
  // Compiling takes seconds the first time, so it never runs on the UI thread; the cache makes later launches quick.
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&Load, std::move(files), std::move(version), std::move(cache_path), std::move(resources_path)),
      base::BindOnce(
          [](base::OnceCallback<void(bool)> done, std::shared_ptr<Engine> engine) {
            if (engine) {
              auto live = std::make_shared<Live>(*CurrentLive());
              live->engine = std::move(engine);
              Publish(std::move(live));
            }
            std::move(done).Run(engine != nullptr);
          },
          std::move(done)));
}

// static
void BayContentBlocker::SetPausedHosts(std::vector<std::string> hosts) {
  auto live = std::make_shared<Live>(*CurrentLive());
  live->paused.clear();
  for (std::string& host : hosts) {
    live->paused.push_back(base::ToLowerASCII(host));
  }
  Publish(std::move(live));
}

// static
bool BayContentBlocker::SetTrackingParameters(const std::string& json) {
  return bay_tracking_set(json.c_str());
}

// static
std::string BayContentBlocker::CleanUrl(const std::string& url) {
  char* cleaned = bay_tracking_clean(url.c_str());
  std::string result = cleaned ? cleaned : "";
  bay_string_free(cleaned);
  return result;
}

// static
std::string BayContentBlocker::CosmeticCss(const std::string& page_url,
                                           const std::string& classes_json,
                                           const std::string& ids_json,
                                           bool site_rules) {
  std::shared_ptr<Engine> engine = EngineFor(page_url.c_str(), page_url.c_str());
  if (!engine) {
    return std::string();
  }
  char* page_json = bay_blocker_cosmetic(engine->blocker, page_url.c_str());
  std::optional<base::Value> page = base::JSONReader::Read(page_json ? page_json : "{}");
  bay_string_free(page_json);
  if (!page || !page->is_dict()) {
    return std::string();
  }
  std::vector<std::string> selectors;
  if (site_rules) {
    if (const base::Value::List* hide = page->GetDict().FindList("hide")) {
      for (const base::Value& selector : *hide) {
        if (selector.is_string()) {
          selectors.push_back(selector.GetString());
        }
      }
    }
  }
  const bool generic_hide = page->GetDict().FindBool("generichide").value_or(false);
  if (!generic_hide && (classes_json != "[]" || ids_json != "[]")) {
    base::Value::Dict query;
    query.Set("classes", base::JSONReader::Read(classes_json).value_or(base::Value(base::Value::List())));
    query.Set("ids", base::JSONReader::Read(ids_json).value_or(base::Value(base::Value::List())));
    if (const base::Value::List* exceptions = page->GetDict().FindList("exceptions")) {
      query.Set("exceptions", exceptions->Clone());
    }
    char* generic = bay_blocker_hidden_selectors(engine->blocker, base::WriteJson(query).value_or("{}").c_str());
    std::optional<base::Value> found = base::JSONReader::Read(generic ? generic : "[]");
    bay_string_free(generic);
    if (found && found->is_list()) {
      for (const base::Value& selector : found->GetList()) {
        if (selector.is_string()) {
          selectors.push_back(selector.GetString());
        }
      }
    }
  }
  // One rule per chunk, so a selector the browser can't parse only drops its own chunk (as Android's WebView engine).
  std::string css;
  for (size_t start = 0; start < selectors.size(); start += 200) {
    const size_t end = std::min(selectors.size(), start + 200);
    std::vector<std::string> chunk(selectors.begin() + start, selectors.begin() + end);
    css += base::JoinString(chunk, ",") + "{display:none!important}\n";
  }
  return css;
}

}  // namespace bay

// The request filter counts a local stand-in it answered for a tab (desktop shows it on the tab). Android's tabs
// don't show a count yet, so this has nothing to record.
namespace nncore {
void NoteContentBlockerRedirect(content::GlobalRenderFrameHostId frame, const GURL& url) {}
}  // namespace nncore
