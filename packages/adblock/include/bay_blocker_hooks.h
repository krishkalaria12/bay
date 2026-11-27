// Bay's content blocker as the engine asks it about each request (nncore's request filter hooks), on any thread: the
// engine and settings in force, replaced whole when a list or a setting changes, and the hooks that read them. One
// copy for the macOS host (packages/chromium/ios/NNCoreContentBlocker.mm) and Windows and Linux
// (webui/content_blocker.cc). It needs only bay_adblock.h's C ABI and the standard library, so each build compiles it
// as it is.
//
// Every string a hook hands the engine is malloc'd (the engine frees it with free()); the library's own strings go
// back to the library.

#ifndef BAY_BLOCKER_HOOKS_H_
#define BAY_BLOCKER_HOOKS_H_

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

#include "bay_adblock.h"

namespace bay_blocker {

// A compiled engine, shared by every request reading it and freed with the last.
class Engine {
 public:
  explicit Engine(BayBlocker* blocker) : blocker_(blocker) {}
  BayBlocker* blocker() const { return blocker_.get(); }

 private:
  struct Free {
    void operator()(BayBlocker* blocker) const { bay_blocker_free(blocker); }
  };
  std::unique_ptr<BayBlocker, Free> blocker_;
};

// What the hooks read: replaced whole, never changed in place.
struct Live {
  std::shared_ptr<Engine> engine;
  bool enabled = true;
  // Sites blocking is paused on (each covers its subdomains).
  std::vector<std::string> allowed;
  // Sites visited despite a block on the page itself; their requests are still filtered.
  std::vector<std::string> pages;
};

// Never destroyed: a request may still be reading at exit.
inline std::mutex& LiveLock() {
  static std::mutex* lock = new std::mutex;
  return *lock;
}
inline std::shared_ptr<const Live>& LiveSlot() {
  static auto* live = new std::shared_ptr<const Live>(std::make_shared<Live>());
  return *live;
}
inline std::shared_ptr<const Live> Current() {
  std::lock_guard<std::mutex> lock(LiveLock());
  return LiveSlot();
}
inline void Publish(std::shared_ptr<const Live> live) {
  std::lock_guard<std::mutex> lock(LiveLock());
  LiveSlot() = std::move(live);
}

// How long the request filter's lookups take, for the blocker's stats.
struct Timings {
  std::atomic<uint64_t> lookups{0};
  std::atomic<uint64_t> nanos{0};
  std::atomic<uint64_t> max_nanos{0};
};
inline Timings& Timing() {
  static auto* timings = new Timings;
  return *timings;
}

// The lowercased host of a URL or origin ("" when it has none).
inline std::string HostOf(std::string_view url) {
  const size_t scheme = url.find("://");
  const size_t start = scheme == std::string_view::npos ? 0 : scheme + 3;
  const size_t end = url.find_first_of("/?#", start);
  std::string_view authority =
      url.substr(std::min(start, url.size()), end == std::string_view::npos ? std::string_view::npos : end - start);
  const size_t at = authority.rfind('@');
  if (at != std::string_view::npos) authority.remove_prefix(at + 1);
  if (!authority.empty() && authority.front() == '[') {
    const size_t close = authority.find(']');
    if (close != std::string_view::npos) authority = authority.substr(0, close + 1);
  } else {
    authority = authority.substr(0, authority.find(':'));
  }
  std::string host(authority);
  for (char& c : host) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return host;
}
inline std::string HostOf(const char* url) { return url ? HostOf(std::string_view(url)) : std::string(); }

// A paused site covers its subdomains: "example.com" covers "www.example.com".
inline bool Covers(std::string_view allowed, std::string_view host) {
  if (allowed.empty() || host.empty()) return false;
  if (host == allowed) return true;
  return host.size() > allowed.size() && host.substr(host.size() - allowed.size()) == allowed &&
         host[host.size() - allowed.size() - 1] == '.';
}

inline bool PausedOn(const Live& live, const std::string& host) {
  return std::any_of(live.allowed.begin(), live.allowed.end(),
                     [&](const std::string& allowed) { return Covers(allowed, host); });
}

inline const char* Or(const char* text, const char* fallback) { return text ? text : fallback; }

// The live engine to ask for a page at `top` (or else `fallback`), or null where blocking is off or paused.
inline std::shared_ptr<const Live> Filtering(const char* top, const char* fallback) {
  std::shared_ptr<const Live> live = Current();
  if (!live->enabled || !live->engine || PausedOn(*live, HostOf(top && *top ? top : fallback))) return nullptr;
  return live;
}

// A library string as the engine's to free.
inline char* CopyOf(char* text) {
  char* copy = text ? strdup(text) : nullptr;
  bay_string_free(text);
  return copy;
}

// The request filter: whether to fail the request, and in `redirect` a blocked request's stand-in or an allowed
// one's URL without its tracking parameters ($removeparam; `any_origin` when the rewrite may cross origins).
inline bool Filter(const char* url, const char* source, const char* top, const char* type, const char* method,
                   char** redirect, bool* any_origin) {
  if (redirect) *redirect = nullptr;
  if (any_origin) *any_origin = false;
  std::shared_ptr<const Live> live = Filtering(top, source);
  if (!live) return false;
  const auto start = std::chrono::steady_clock::now();
  BayBlockerMatch match =
      bay_blocker_match(live->engine->blocker(), url, Or(source, ""), Or(type, "other"), Or(method, "GET"));
  const char* answer = match.blocked ? match.redirect : match.rewrite;
  if (redirect && answer) *redirect = strdup(answer);
  if (any_origin && !match.blocked && match.rewrite_any_origin) *any_origin = true;
  bay_string_free(match.redirect);
  bay_string_free(match.rewrite);
  if (match.blocked && type && !strcmp(type, "document")) {
    const std::string host = HostOf(url);
    for (const std::string& page : live->pages) {
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
  const uint64_t nanos = static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - start).count());
  Timings& timing = Timing();
  timing.lookups.fetch_add(1, std::memory_order_relaxed);
  timing.nanos.fetch_add(nanos, std::memory_order_relaxed);
  uint64_t max = timing.max_nanos.load(std::memory_order_relaxed);
  while (nanos > max && !timing.max_nanos.compare_exchange_weak(max, nanos, std::memory_order_relaxed)) {
  }
  return match.blocked;
}

// $header, $ipaddress, $permissions and ##^responseheader: the response's verdict as JSON, or null.
inline char* Response(const char* url, const char* source, const char* top, const char* type, const char* method,
                      const char* ip, const char* headers) {
  std::shared_ptr<const Live> live = Filtering(top, source);
  if (!live) return nullptr;
  return CopyOf(bay_blocker_response(live->engine->blocker(), url, Or(source, ""), Or(type, "other"),
                                     Or(method, "GET"), ip, Or(headers, "[]")));
}

// Every response's question: whether $replace or an HTML ##^ rule wants its body.
inline bool BodyFilterApplies(const char* url, const char* source, const char* top, const char* type,
                              const char* method, int status, const char* content_type,
                              const char* content_disposition) {
  std::shared_ptr<const Live> live = Filtering(top, url);
  return live && bay_blocker_body_filter_applies(live->engine->blocker(), url, Or(source, ""), Or(type, "other"),
                                                 Or(method, "GET"), status, Or(content_type, ""),
                                                 Or(content_disposition, ""));
}

// A whole body the gate asked for. Holds the engine, which a list update may replace while this runs.
inline uint8_t* BodyFiltered(const char* url, const char* source, const char* top, const char* type,
                             const char* method, const char* content_type, const uint8_t* body, size_t length,
                             size_t* out_length) {
  *out_length = 0;
  std::shared_ptr<const Live> live = Filtering(top, url);
  if (!live) return nullptr;
  size_t filtered_length = 0;
  uint8_t* filtered = bay_blocker_body_filter(live->engine->blocker(), url, Or(source, ""), Or(type, "other"),
                                              Or(method, "GET"), Or(content_type, ""), body, length, &filtered_length);
  if (!filtered) return nullptr;
  auto* copy = static_cast<uint8_t*>(malloc(std::max<size_t>(filtered_length, 1)));
  if (copy) {
    memcpy(copy, filtered, filtered_length);
    *out_length = filtered_length;
  }
  bay_bytes_free(filtered, filtered_length);
  return copy;
}

// What $requestheader rules read for this request, nearly always nothing.
inline char* RequestHeaderNames(const char* url, const char* source, const char* top, const char* type,
                                const char* method) {
  std::shared_ptr<const Live> live = Filtering(top, url);
  if (!live) return nullptr;
  return CopyOf(bay_blocker_request_header_names(live->engine->blocker(), url, Or(source, ""), Or(type, "other"),
                                                 Or(method, "GET")));
}

// $requestheader, with the headers it asked for.
inline bool RequestHeadersBlocked(const char* url, const char* source, const char* top, const char* type,
                                  const char* method, const char* headers) {
  std::shared_ptr<const Live> live = Filtering(top, url);
  return live && bay_blocker_request_headers_blocked(live->engine->blocker(), url, Or(source, ""), Or(type, "other"),
                                                     Or(method, "GET"), Or(headers, "[]"));
}

// Whether a response's hostname is an alias of a blocked one.
inline bool CnameBlocked(const char* url, const char* alias, const char* source, const char* top, const char* type,
                         const char* method) {
  std::shared_ptr<const Live> live = Filtering(top, url);
  return live && bay_blocker_cname_blocked(live->engine->blocker(), url, alias, Or(source, ""), Or(type, "other"),
                                           Or(method, "GET"));
}

// $csp rules, while the navigation waits.
inline char* ContentSecurityPolicy(const char* url, const char* source, const char* top, const char* type) {
  std::shared_ptr<const Live> live = Filtering(top, url);
  if (!live) return nullptr;
  return CopyOf(
      bay_blocker_content_security_policy(live->engine->blocker(), url, Or(source, ""), Or(type, "document")));
}

// A document's scriptlets, while its renderer waits.
inline char* Scriptlets(const char* frame_url, const char* top_origin) {
  std::shared_ptr<const Live> live = Filtering(top_origin, frame_url);
  if (!live) return nullptr;
  return CopyOf(bay_blocker_scriptlets(live->engine->blocker(), frame_url));
}

}  // namespace bay_blocker

#endif  // BAY_BLOCKER_HOOKS_H_
