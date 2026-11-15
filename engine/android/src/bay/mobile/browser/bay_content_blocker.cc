// Copyright 2026 Bay authors. The filter callbacks follow packages/chromium/ios/NNCoreContentBlocker.mm, desktop's.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#include "bay/mobile/browser/bay_content_blocker.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <utility>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/values.h"
#include "bay/filter/nn_request_filter.h"
#include "bay/mobile/adblock/bay_adblock.h"
#include "bay/mobile/browser/bay_tab.h"
#include "content/public/browser/global_routing_id.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "url/gurl.h"

namespace bay {

namespace {

// The compiled lists. Shared by every request in flight; replaced whole when the lists change.
struct Engine {
  explicit Engine(BayBlocker* blocker) : blocker(blocker) {}
  ~Engine() { bay_blocker_free(blocker); }
  Engine(const Engine&) = delete;
  Engine& operator=(const Engine&) = delete;
  const raw_ptr<BayBlocker> blocker;
};

// What the callbacks read on any thread: replaced whole (never changed in place) under the lock.
struct Live {
  // Every list in one engine: what every site without a group turned off is filtered with.
  std::shared_ptr<Engine> engine;
  // One engine per group (C18), each with the "shared" lists too; empty until a site turns a group off.
  std::map<std::string, std::shared_ptr<Engine>> groups;
  std::vector<std::string> paused;
  // The groups each site turns off, by host.
  std::vector<std::pair<std::string, std::set<std::string>>> groups_off;
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

// What the lists were last loaded from, so the group engines can follow when a site first turns a group off. UI
// thread only.
struct Source {
  std::vector<std::string> files;
  std::vector<std::string> groups;
  std::string version;
  std::string cache_path;
  std::string resources_path;
  // Bumped by each SetLists, so a load that finishes after newer lists arrived is dropped.
  int generation = 0;
  bool loading_groups = false;
};

Source& CurrentSource() {
  static base::NoDestructor<Source> source;
  return *source;
}

std::string HostOf(const char* url) {
  if (!url || !*url) {
    return std::string();
  }
  return base::ToLowerASCII(GURL(url).host());
}

// A site's entry covers its subdomains: "example.com" covers "www.example.com".
bool Covers(const std::string& site, const std::string& host) {
  if (site.empty() || host.empty()) {
    return false;
  }
  return host == site || (host.size() > site.size() && base::EndsWith(host, "." + site));
}

using Engines = std::vector<std::shared_ptr<Engine>>;

// The engines to filter a page with: none while blocking is off or paused on its site, the groups its site keeps
// once it turns some off (or every list, while the group engines load), and the engine of every list otherwise.
Engines EnginesFor(const char* top, const char* fallback) {
  std::shared_ptr<const Live> live = CurrentLive();
  if (!live->engine) {
    return {};
  }
  const std::string host = HostOf(top && *top ? top : fallback);
  for (const std::string& paused : live->paused) {
    if (Covers(paused, host)) {
      return {};
    }
  }
  std::set<std::string> off;
  for (const auto& [site, groups] : live->groups_off) {
    if (Covers(site, host)) {
      off.insert(groups.begin(), groups.end());
    }
  }
  if (off.empty() || live->groups.empty()) {
    return {live->engine};
  }
  Engines engines;
  for (const auto& [group, engine] : live->groups) {
    if (!off.contains(group)) {
      engines.push_back(engine);
    }
  }
  return engines;
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
  // A request is blocked when any group's engine blocks it, with that engine's stand-in; an allowed one takes the
  // first rewrite (tracking parameters, $urlskip) an engine offers.
  for (const std::shared_ptr<Engine>& engine : EnginesFor(top, source)) {
    BayBlockerMatch match =
        bay_blocker_match(engine->blocker, url, source ? source : "", type ? type : "other", method ? method : "GET");
    const bool blocked = match.blocked;
    if (blocked) {
      if (redirect) {
        free(*redirect);
        *redirect = match.redirect ? strdup(match.redirect) : nullptr;
      }
      if (any_origin) {
        *any_origin = false;
      }
    } else if (redirect && !*redirect && match.rewrite) {
      *redirect = strdup(match.rewrite);
      if (any_origin) {
        *any_origin = match.rewrite_any_origin;
      }
    }
    bay_string_free(match.redirect);
    bay_string_free(match.rewrite);
    if (blocked) {
      return true;
    }
  }
  return false;
}

char* Response(const char* url,
               const char* source,
               const char* top,
               const char* type,
               const char* method,
               const char* ip,
               const char* headers) {
  // The first engine that blocks the response answers; otherwise the first that changes its headers.
  char* answer = nullptr;
  for (const std::shared_ptr<Engine>& engine : EnginesFor(top, source)) {
    char* next = Copy(bay_blocker_response(engine->blocker, url, source ? source : "", type ? type : "other",
                                           method ? method : "GET", ip, headers ? headers : "[]"));
    if (!next) {
      continue;
    }
    std::optional<base::DictValue> parsed = base::JSONReader::ReadDict(next, base::JSON_PARSE_RFC);
    if (parsed && parsed->FindBool("blocked").value_or(false)) {
      free(answer);
      return next;
    }
    if (answer) {
      free(next);
    } else {
      answer = next;
    }
  }
  return answer;
}

bool BodyFilterApplies(const char* url,
                       const char* source,
                       const char* top,
                       const char* type,
                       const char* method,
                       int status,
                       const char* content_type,
                       const char* content_disposition) {
  for (const std::shared_ptr<Engine>& engine : EnginesFor(top, url)) {
    if (bay_blocker_body_filter_applies(engine->blocker, url, source ? source : "", type ? type : "other",
                                        method ? method : "GET", status, content_type ? content_type : "",
                                        content_disposition ? content_disposition : "")) {
      return true;
    }
  }
  return false;
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
  // Each engine's body rules apply in turn, each to what the one before it left.
  std::vector<uint8_t> current;
  bool changed = false;
  for (const std::shared_ptr<Engine>& engine : EnginesFor(top, url)) {
    const uint8_t* input = changed ? current.data() : body;
    const size_t input_length = changed ? current.size() : length;
    size_t filtered_length = 0;
    uint8_t* filtered = bay_blocker_body_filter(engine->blocker, url, source ? source : "", type ? type : "other",
                                                method ? method : "GET", content_type ? content_type : "", input,
                                                input_length, &filtered_length);
    if (!filtered) {
      continue;
    }
    current.assign(filtered, filtered + filtered_length);
    changed = true;
    bay_bytes_free(filtered, filtered_length);
  }
  if (!changed) {
    return nullptr;
  }
  auto* copy = static_cast<uint8_t*>(malloc(current.empty() ? 1 : current.size()));
  if (copy) {
    if (!current.empty()) {
      memcpy(copy, current.data(), current.size());
    }
    *out_length = current.size();
  }
  return copy;
}

char* RequestHeaderNames(const char* url, const char* source, const char* top, const char* type, const char* method) {
  // Every header any engine's rules read, once.
  std::set<std::string> names;
  for (const std::shared_ptr<Engine>& engine : EnginesFor(top, url)) {
    char* json = bay_blocker_request_header_names(engine->blocker, url, source ? source : "", type ? type : "other",
                                                  method ? method : "GET");
    std::optional<base::Value> parsed = base::JSONReader::Read(json ? json : "[]", base::JSON_PARSE_RFC);
    bay_string_free(json);
    if (parsed && parsed->is_list()) {
      for (const base::Value& name : parsed->GetList()) {
        if (name.is_string()) {
          names.insert(name.GetString());
        }
      }
    }
  }
  if (names.empty()) {
    return nullptr;
  }
  base::ListValue list;
  for (const std::string& name : names) {
    list.Append(name);
  }
  return strdup(base::WriteJson(list).value_or("[]").c_str());
}

bool RequestHeadersBlocked(const char* url,
                           const char* source,
                           const char* top,
                           const char* type,
                           const char* method,
                           const char* headers) {
  for (const std::shared_ptr<Engine>& engine : EnginesFor(top, url)) {
    if (bay_blocker_request_headers_blocked(engine->blocker, url, source ? source : "", type ? type : "other",
                                            method ? method : "GET", headers ? headers : "[]")) {
      return true;
    }
  }
  return false;
}

bool CnameBlocked(const char* url,
                  const char* alias,
                  const char* source,
                  const char* top,
                  const char* type,
                  const char* method) {
  for (const std::shared_ptr<Engine>& engine : EnginesFor(top, url)) {
    if (bay_blocker_cname_blocked(engine->blocker, url, alias, source ? source : "", type ? type : "other",
                                  method ? method : "GET")) {
      return true;
    }
  }
  return false;
}

char* ContentSecurityPolicy(const char* url, const char* source, const char* top, const char* type) {
  // Policies joined with commas are separate policies, each enforced.
  std::vector<std::string> policies;
  for (const std::shared_ptr<Engine>& engine : EnginesFor(top, url)) {
    char* policy = bay_blocker_content_security_policy(engine->blocker, url, source ? source : "",
                                                       type ? type : "document");
    if (policy && *policy) {
      policies.push_back(policy);
    }
    bay_string_free(policy);
  }
  return policies.empty() ? nullptr : strdup(base::JoinString(policies, ", ").c_str());
}

char* Scriptlets(const char* frame_url, const char* top_origin) {
  // Every group engine has the shared lists, so on a site whose scriptlets all come from those, each engine returns
  // the same script: it runs once.
  std::vector<std::string> scripts;
  for (const std::shared_ptr<Engine>& engine : EnginesFor(top_origin, frame_url)) {
    char* script = bay_blocker_scriptlets(engine->blocker, frame_url);
    if (script && *script && std::find(scripts.begin(), scripts.end(), script) == scripts.end()) {
      scripts.push_back(script);
    }
    bay_string_free(script);
  }
  return scripts.empty() ? nullptr : strdup(base::JoinString(scripts, "\n").c_str());
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

// Each group's engine, of its own lists and the shared ones, cached beside the engine of every list.
std::map<std::string, std::shared_ptr<Engine>> LoadGroups(const Source& source) {
  std::map<std::string, std::vector<std::string>> files;
  std::vector<std::string> shared;
  for (size_t i = 0; i < source.files.size(); ++i) {
    if (source.groups[i] == "shared") {
      shared.push_back(source.files[i]);
    } else {
      files[source.groups[i]].push_back(source.files[i]);
    }
  }
  std::map<std::string, std::shared_ptr<Engine>> engines;
  for (auto& [group, group_files] : files) {
    group_files.insert(group_files.end(), shared.begin(), shared.end());
    if (std::shared_ptr<Engine> engine =
            Load(group_files, source.version, source.cache_path + "." + group, source.resources_path)) {
      engines[group] = std::move(engine);
    }
  }
  return engines;
}

// Loads the group engines the first time a site turns a group off; they stay until the lists change. UI thread.
void LoadGroupsIfNeeded() {
  Source& source = CurrentSource();
  std::shared_ptr<const Live> live = CurrentLive();
  if (live->groups_off.empty() || !live->groups.empty() || !live->engine || source.loading_groups ||
      source.groups.size() != source.files.size()) {
    return;
  }
  source.loading_groups = true;
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE}, base::BindOnce(&LoadGroups, source),
      base::BindOnce(
          [](int generation, std::map<std::string, std::shared_ptr<Engine>> engines) {
            Source& source = CurrentSource();
            source.loading_groups = false;
            if (generation != source.generation) {
              // Made from lists that have since changed: load the new lists' groups instead.
              LoadGroupsIfNeeded();
              return;
            }
            if (engines.empty()) {
              return;
            }
            auto live = std::make_shared<Live>(*CurrentLive());
            live->groups = std::move(engines);
            Publish(std::move(live));
          },
          source.generation));
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
                                 std::vector<std::string> groups,
                                 std::string version,
                                 std::string cache_path,
                                 std::string resources_path,
                                 base::OnceCallback<void(bool)> done) {
  Source& source = CurrentSource();
  const int generation = ++source.generation;
  source.files = files;
  source.groups = groups.size() == files.size() ? std::move(groups) : std::vector<std::string>();
  source.version = version;
  source.cache_path = cache_path;
  source.resources_path = resources_path;
  if (files.empty()) {
    auto live = std::make_shared<Live>(*CurrentLive());
    live->engine = nullptr;
    live->groups.clear();
    Publish(std::move(live));
    std::move(done).Run(true);
    return;
  }
  // Compiling takes seconds the first time, so it never runs on the UI thread; the cache makes later launches quick.
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&Load, std::move(files), std::move(version), std::move(cache_path), std::move(resources_path)),
      base::BindOnce(
          [](int generation, base::OnceCallback<void(bool)> done, std::shared_ptr<Engine> engine) {
            if (engine && generation == CurrentSource().generation) {
              auto live = std::make_shared<Live>(*CurrentLive());
              live->engine = std::move(engine);
              // The group engines were made from the old lists.
              live->groups.clear();
              Publish(std::move(live));
              LoadGroupsIfNeeded();
            }
            std::move(done).Run(engine != nullptr);
          },
          generation, std::move(done)));
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
void BayContentBlocker::SetSiteGroups(const std::string& json) {
  auto live = std::make_shared<Live>(*CurrentLive());
  live->groups_off.clear();
  std::optional<base::Value> parsed = base::JSONReader::Read(json, base::JSON_PARSE_RFC);
  if (parsed && parsed->is_dict()) {
    for (const auto [host, value] : parsed->GetDict()) {
      if (!value.is_list()) {
        continue;
      }
      std::set<std::string> groups;
      for (const base::Value& group : value.GetList()) {
        if (group.is_string()) {
          groups.insert(group.GetString());
        }
      }
      if (!groups.empty()) {
        live->groups_off.emplace_back(base::ToLowerASCII(host), std::move(groups));
      }
    }
  }
  Publish(std::move(live));
  LoadGroupsIfNeeded();
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
  // Every engine's rules for the page, each selector once.
  std::vector<std::string> selectors;
  std::set<std::string> seen;
  auto add = [&](const base::Value& selector) {
    if (selector.is_string() && seen.insert(selector.GetString()).second) {
      selectors.push_back(selector.GetString());
    }
  };
  for (const std::shared_ptr<Engine>& engine : EnginesFor(page_url.c_str(), page_url.c_str())) {
    char* page_json = bay_blocker_cosmetic(engine->blocker, page_url.c_str());
    std::optional<base::Value> page = base::JSONReader::Read(page_json ? page_json : "{}", base::JSON_PARSE_RFC);
    bay_string_free(page_json);
    if (!page || !page->is_dict()) {
      continue;
    }
    if (site_rules) {
      if (const base::ListValue* hide = page->GetDict().FindList("hide")) {
        for (const base::Value& selector : *hide) {
          add(selector);
        }
      }
    }
    const bool generic_hide = page->GetDict().FindBool("generichide").value_or(false);
    if (generic_hide || (classes_json == "[]" && ids_json == "[]")) {
      continue;
    }
    base::DictValue query;
    query.Set("classes", base::JSONReader::Read(classes_json, base::JSON_PARSE_RFC).value_or(base::Value(base::ListValue())));
    query.Set("ids", base::JSONReader::Read(ids_json, base::JSON_PARSE_RFC).value_or(base::Value(base::ListValue())));
    if (const base::ListValue* exceptions = page->GetDict().FindList("exceptions")) {
      query.Set("exceptions", exceptions->Clone());
    }
    char* generic = bay_blocker_hidden_selectors(engine->blocker, base::WriteJson(query).value_or("{}").c_str());
    std::optional<base::Value> found = base::JSONReader::Read(generic ? generic : "[]", base::JSON_PARSE_RFC);
    bay_string_free(generic);
    if (found && found->is_list()) {
      for (const base::Value& selector : found->GetList()) {
        add(selector);
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

// The request filter counts a local stand-in it answered for a tab (C18), as desktop does: it succeeds rather than
// failing with ERR_BLOCKED_BY_CLIENT, which BayTab counts on its own. Posted to the UI thread; a frame that has gone,
// or isn't in the page the tab shows, counts nothing.
namespace nncore {
void NoteContentBlockerRedirect(content::GlobalRenderFrameHostId frame_id, const GURL& url) {
  content::RenderFrameHost* frame = content::RenderFrameHost::FromID(frame_id);
  if (!frame || !frame->GetOutermostMainFrame()->IsInPrimaryMainFrame()) {
    return;
  }
  if (bay::BayTab* tab = bay::BayTab::FromWebContents(content::WebContents::FromRenderFrameHost(frame))) {
    tab->NoteBlocked();
  }
}
}  // namespace nncore
