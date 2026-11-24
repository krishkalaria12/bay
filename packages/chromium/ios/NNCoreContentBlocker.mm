// The built-in content blocker: Bay's own (packages/adblock, Brave's adblock-rust).
//
// The engine asks it about every web request a page makes (NNCoreRequestFilter: subresources on a background
// sequence, subframe navigations on the main thread) and fails the blocked ones with ERR_BLOCKED_BY_CLIENT, or answers
// them with a stand-in; an allowed one may load without its tracking parameters instead ($removeparam). Scriptlets
// reach each document as it starts, before its own scripts (NNCoreScriptletSource); a document's response may get a
// Content-Security-Policy ($csp, NNCoreContentSecurityPolicySource); a page a page opens may be refused ($popup, type
// "popup"). Cosmetic filters go into each frame
// as a user-origin sheet when its page script says hello (NNCoreWebView), and again for the classes and ids the page
// script finds in it (generic hiding).
//
// The filter lists are uBO's default catalogue (filter_lists.json): each one on or off, downloaded into
// <app support>/Content Blocker/lists and updated when its `! Expires:` says so. The default lists are bundled
// (Resources/FilterLists, packages/chromium/scripts/filter-lists.sh), so a new install blocks from its first page. The
// compiled engine is cached (engine.dat), loads in milliseconds at launch and reads its rules from the mapped file, so
// they aren't dirty memory; it's rebuilt when a list or the selection changes. Settings (on/off, the lists, the hosts
// it's paused on) live in settings.json and apply to every profile, private ones included. All of that is bay-lists'
// (packages/rust/bay-lists), which Windows and Linux share; this file downloads, schedules and serves the engine.

#import "NNCoreServices.h"
#import "NNCoreInternal.h"

#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "bay_adblock.h"
#include "bay_lists.h"

namespace {

// MARK: The live engine (any thread)

struct Engine {
  explicit Engine(BayBlocker *b) : blocker(b) {}
  ~Engine() { bay_blocker_free(blocker); }
  Engine(const Engine &) = delete;
  Engine &operator=(const Engine &) = delete;
  BayBlocker *const blocker;
};

// What the request filter reads: replaced whole (never changed in place) under gLiveLock.
struct Live {
  std::shared_ptr<Engine> engine;
  bool enabled = true;
  std::vector<std::string> allowed;
  // Sites the user chose to visit despite a block on the page itself; their requests are still filtered.
  std::vector<std::string> pages;
};

std::mutex gLiveLock;
std::shared_ptr<const Live> gLive = std::make_shared<Live>();

std::shared_ptr<const Live> CurrentLive() {
  std::lock_guard<std::mutex> lock(gLiveLock);
  return gLive;
}

void Publish(std::shared_ptr<const Live> live) {
  std::lock_guard<std::mutex> lock(gLiveLock);
  gLive = std::move(live);
}

std::atomic<uint64_t> gLookups{0};
std::atomic<uint64_t> gLookupNanos{0};
std::atomic<uint64_t> gMaxLookupNanos{0};

// The lowercased host of a URL or origin ("" when it has none).
std::string HostOf(const char *url) {
  if (!url) return {};
  std::string text(url);
  size_t start = text.find("://");
  start = start == std::string::npos ? 0 : start + 3;
  size_t end = text.find_first_of("/?#", start);
  std::string authority = text.substr(start, end == std::string::npos ? std::string::npos : end - start);
  const size_t at = authority.rfind('@');
  if (at != std::string::npos) authority.erase(0, at + 1);
  if (!authority.empty() && authority[0] == '[') {
    const size_t close = authority.find(']');
    authority = authority.substr(0, close == std::string::npos ? std::string::npos : close + 1);
  } else {
    const size_t colon = authority.find(':');
    if (colon != std::string::npos) authority.erase(colon);
  }
  for (char &c : authority) c = (char)tolower((unsigned char)c);
  return authority;
}

// A paused site covers its subdomains: "example.com" covers "www.example.com".
bool Covers(const std::string &allowed, const std::string &host) {
  if (allowed.empty() || host.empty()) return false;
  if (host == allowed) return true;
  return host.size() > allowed.size() && host.compare(host.size() - allowed.size(), allowed.size(), allowed) == 0 &&
         host[host.size() - allowed.size() - 1] == '.';
}

bool PausedOn(const Live &live, const std::string &host) {
  for (const std::string &allowed : live.allowed)
    if (Covers(allowed, host)) return true;
  return false;
}

// NNCoreRequestFilter: on the engine's threads.
bool Filter(const char *url, const char *source, const char *top, const char *type, const char *method,
            char **redirect, bool *any_origin) {
  if (redirect) *redirect = nullptr;
  if (any_origin) *any_origin = false;
  std::shared_ptr<const Live> live = CurrentLive();
  if (!live->enabled || !live->engine) return false;
  if (PausedOn(*live, HostOf(top && *top ? top : source))) return false;
  const auto start = std::chrono::steady_clock::now();
  BayBlockerMatch match =
      bay_blocker_match(live->engine->blocker, url, source ?: "", type ?: "other", method ?: "GET");
  // A blocked request's stand-in, or an allowed one's URL without its tracking parameters.
  const char *answer = match.blocked ? match.redirect : match.rewrite;
  if (redirect && answer) *redirect = strdup(answer);
  if (any_origin && !match.blocked && match.rewrite_any_origin) *any_origin = true;
  bay_string_free(match.redirect);
  bay_string_free(match.rewrite);
  if (match.blocked && type && !strcmp(type, "document")) {
    const std::string host = HostOf(url);
    for (const std::string &page : live->pages)
      if (Covers(page, host)) {
        // Visit Anyway lifts the block whole: no stand-in either.
        if (redirect) free(*redirect), *redirect = nullptr;
        return false;
      }
  }
  const uint64_t nanos =
      (uint64_t)std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - start).count();
  gLookups.fetch_add(1, std::memory_order_relaxed);
  gLookupNanos.fetch_add(nanos, std::memory_order_relaxed);
  uint64_t max = gMaxLookupNanos.load(std::memory_order_relaxed);
  while (nanos > max && !gMaxLookupNanos.compare_exchange_weak(max, nanos, std::memory_order_relaxed)) {
  }
  return match.blocked;
}

// NNCoreResponseFilter: $header, $ipaddress, $permissions and ##^responseheader, on the request's sequence.
char *Response(const char *url, const char *source, const char *top, const char *type, const char *method,
               const char *ip, const char *headers) {
  std::shared_ptr<const Live> live = CurrentLive();
  if (!live->enabled || !live->engine) return nullptr;
  if (PausedOn(*live, HostOf(top && *top ? top : source))) return nullptr;
  return bay_blocker_response(live->engine->blocker, url, source ?: "", type ?: "other",
                              method ?: "GET", ip, headers ?: "[]");
}

// NNCoreBodyFilterGate: every response's question, whether $replace or an HTML ##^ rule wants its body.
bool BodyFilterApplies(const char *url, const char *source, const char *top, const char *type, const char *method,
                       int status, const char *contentType, const char *contentDisposition) {
  std::shared_ptr<const Live> live = CurrentLive();
  if (!live->enabled || !live->engine) return false;
  if (PausedOn(*live, HostOf(top && *top ? top : url))) return false;
  return bay_blocker_body_filter_applies(live->engine->blocker, url, source ?: "", type ?: "other", method ?: "GET", status,
                                         contentType ?: "", contentDisposition ?: "");
}

// NNCoreBodyFilter: a whole body the gate asked for, on the thread pool. Keeps its own hold on the engine, which a list
// update may replace while it runs.
uint8_t *BodyFiltered(const char *url, const char *source, const char *top, const char *type, const char *method,
                      const char *contentType, const uint8_t *body, size_t length, size_t *outLength) {
  *outLength = 0;
  std::shared_ptr<const Live> live = CurrentLive();
  if (!live->enabled || !live->engine) return nullptr;
  if (PausedOn(*live, HostOf(top && *top ? top : url))) return nullptr;
  size_t filteredLength = 0;
  uint8_t *filtered = bay_blocker_body_filter(live->engine->blocker, url, source ?: "", type ?: "other", method ?: "GET",
                                              contentType ?: "", body, length, &filteredLength);
  if (!filtered) return nullptr;
  uint8_t *copy = (uint8_t *)malloc(filteredLength ?: 1);
  if (copy) {
    memcpy(copy, filtered, filteredLength);
    *outLength = filteredLength;
  }
  bay_bytes_free(filtered, filteredLength);
  return copy;
}

// NNCoreRequestHeaderNames: what $requestheader rules read for this request, nearly always nothing.
char *RequestHeaderNames(const char *url, const char *source, const char *top, const char *type, const char *method) {
  std::shared_ptr<const Live> live = CurrentLive();
  if (!live->enabled || !live->engine) return nullptr;
  if (PausedOn(*live, HostOf(top && *top ? top : url))) return nullptr;
  char *names = bay_blocker_request_header_names(live->engine->blocker, url, source ?: "", type ?: "other", method ?: "GET");
  char *copy = names ? strdup(names) : nullptr;
  bay_string_free(names);
  return copy;
}

// NNCoreRequestHeaderFilter: $requestheader, with the headers it asked for.
bool RequestHeadersBlocked(const char *url, const char *source, const char *top, const char *type, const char *method,
                           const char *headers) {
  std::shared_ptr<const Live> live = CurrentLive();
  if (!live->enabled || !live->engine) return false;
  if (PausedOn(*live, HostOf(top && *top ? top : url))) return false;
  return bay_blocker_request_headers_blocked(live->engine->blocker, url, source ?: "", type ?: "other", method ?: "GET",
                                             headers ?: "[]");
}

// NNCoreCnameFilter: what a hostname is an alias of, for each alias of a response.
bool CnameBlocked(const char *url, const char *alias, const char *source, const char *top, const char *type,
                  const char *method) {
  std::shared_ptr<const Live> live = CurrentLive();
  if (!live->enabled || !live->engine) return false;
  if (PausedOn(*live, HostOf(top && *top ? top : url))) return false;
  return bay_blocker_cname_blocked(live->engine->blocker, url, alias, source ?: "", type ?: "other", method ?: "GET");
}

// NNCoreContentSecurityPolicySource: $csp rules, on the filter's sequence while the navigation waits.
char *ContentSecurityPolicy(const char *url, const char *source, const char *top, const char *type) {
  std::shared_ptr<const Live> live = CurrentLive();
  if (!live->enabled || !live->engine) return nullptr;
  if (PausedOn(*live, HostOf(top && *top ? top : url))) return nullptr;
  char *policy = bay_blocker_content_security_policy(live->engine->blocker, url, source ?: "", type ?: "document");
  char *copy = policy ? strdup(policy) : nullptr;
  bay_string_free(policy);
  return copy;
}

// NNCoreScriptletSource: on a background sequence, while the document's renderer waits.
char *Scriptlets(const char *frameURL, const char *topOrigin) {
  std::shared_ptr<const Live> live = CurrentLive();
  if (!live->enabled || !live->engine) return nullptr;
  if (PausedOn(*live, HostOf(topOrigin && *topOrigin ? topOrigin : frameURL))) return nullptr;
  char *script = bay_blocker_scriptlets(live->engine->blocker, frameURL);
  char *copy = script ? strdup(script) : nullptr;
  bay_string_free(script);
  return copy;
}

// The engine runs scriptlets itself, before a document's own scripts (setScriptletSource:); an older one gets them
// with the frame's cosmetic filters, once its page script says hello.
BOOL gEngineRunsScriptlets = NO;

// MARK: The lists

// The catalogue, the settings, the list files and the cached engine are bay-lists' (packages/rust/bay-lists), shared
// with Windows and Linux. This side keeps the work queue, the downloads, the update timer and the live engine.

NSString *Directory() {
  static NSString *directory;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    directory = [[NNCoreHost.dataDirectory stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"Content Blocker"];
  });
  return directory;
}

// JSON the Rust library returned, which it then frees.
id JSONFrom(char *text) {
  if (!text) return nil;
  id value = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytesNoCopy:text length:strlen(text) freeWhenDone:NO] options:0 error:nil];
  bay_string_free(text);
  return value;
}

// A string the Rust library returned, which it then frees.
NSString *_Nullable StringFrom(char *text) {
  NSString *string = text ? @(text) : nil;
  bay_string_free(text);
  return string;
}

NSString *JSONText(id value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"null";
}

// Opened on first use; any thread may use it after that.
BayLists *Lists() {
  static BayLists *lists;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSString *catalogue = [[NSBundle bundleForClass:NNCoreContentBlocker.class] pathForResource:@"filter_lists" ofType:@"json"];
    lists = bay_lists_open(Directory().fileSystemRepresentation, catalogue.fileSystemRepresentation,
                           JSONText(NSLocale.preferredLanguages).UTF8String);
    if (!bay_lists_catalogue_size(lists)) NSLog(@"[blocker] no filter list catalogue (filter_lists.json)");
  });
  return lists;
}

void SaveSettings() {
  if (!bay_lists_save(Lists())) NSLog(@"[blocker] couldn't save settings.json");
}

NSArray<NSString *> *URLs(NSString *listId) {
  NSArray *urls = JSONFrom(bay_lists_urls(Lists(), listId.UTF8String));
  return [urls isKindOfClass:NSArray.class] ? urls : @[];
}

// MARK: State the main thread keeps about the engine

std::atomic<NSUInteger> gGeneration{0};
std::shared_ptr<Engine> gEngine;
bool gFailNext = false;
double gDelayNextLoadMs = 0;

void PublishLive() {
  auto live = std::make_shared<Live>();
  live->engine = gEngine;
  NSDictionary *settings = JSONFrom(bay_lists_live(Lists()));
  live->enabled = [settings[@"enabled"] boolValue];
  for (NSString *host in settings[@"allowed"]) live->allowed.emplace_back(host.UTF8String);
  for (NSString *host in settings[@"pages"]) live->pages.emplace_back(host.UTF8String);
  // Only engines with response rules need every response's headers marshalled to the host.
  if ([NNCoreEngine respondsToSelector:@selector(setResponseFilter:)])
    [NNCoreEngine setResponseFilter:live->enabled && live->engine && bay_blocker_has_response_modifiers(live->engine->blocker)
                                        ? Response
                                        : nullptr];
  // The rest are asked about every response or request, so they're only there when a rule can answer.
  const bool filtering = live->enabled && live->engine;
  if ([NNCoreEngine respondsToSelector:@selector(setBodyFilterGate:filter:)]) {
    const bool bodies = filtering && bay_blocker_has_body_modifiers(live->engine->blocker);
    [NNCoreEngine setBodyFilterGate:bodies ? BodyFilterApplies : nullptr filter:bodies ? BodyFiltered : nullptr];
  }
  if ([NNCoreEngine respondsToSelector:@selector(setRequestHeaderNames:filter:)]) {
    const bool headers = filtering && bay_blocker_has_request_header_modifiers(live->engine->blocker);
    [NNCoreEngine setRequestHeaderNames:headers ? RequestHeaderNames : nullptr filter:headers ? RequestHeadersBlocked : nullptr];
  }
  if ([NNCoreEngine respondsToSelector:@selector(setCnameFilter:)])
    [NNCoreEngine setCnameFilter:filtering ? CnameBlocked : nullptr];
  Publish(std::move(live));
}

dispatch_queue_t Work() {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    queue = dispatch_queue_create("bay.content-blocker", dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL,
                                                                                                QOS_CLASS_USER_INITIATED, 0));
  });
  return queue;
}

// The request filter's timing, for the stats.
NSString *Timing() {
  const uint64_t lookups = gLookups.load(std::memory_order_relaxed);
  const double averageMicros = lookups ? gLookupNanos.load(std::memory_order_relaxed) / 1000.0 / lookups : 0;
  return JSONText(@{
    @"lookups" : @(lookups),
    @"averageLookupMicros" : @(round(averageMicros * 100) / 100),
    @"maxLookupMicros" : @(round(gMaxLookupNanos.load(std::memory_order_relaxed) / 10.0) / 100),
  });
}

NSDictionary *StatsDictionary() { return JSONFrom(bay_lists_stats(Lists(), Timing().UTF8String)); }
NSDictionary *StateDictionary() { return JSONFrom(bay_lists_state(Lists(), Timing().UTF8String)); }

void Emit() {
  if (NNCoreHost.eventHandler) NNCoreHost.eventHandler(@"contentBlocker", StatsDictionary());
}

// MARK: Lists on the network

NSURLSession *Session() {
  static NSURLSession *session;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSURLSessionConfiguration *config = NSURLSessionConfiguration.ephemeralSessionConfiguration;
    config.timeoutIntervalForRequest = 60;
    config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    session = [NSURLSession sessionWithConfiguration:config];
  });
  return session;
}

// Downloads a list from its first URL that answers with a list; completion(changed) on Work(): whether its file changed.
void Download(NSString *listId, NSArray<NSString *> *urls, NSUInteger urlIndex, void (^completion)(BOOL changed)) {
  if (urlIndex >= urls.count) return dispatch_async(Work(), ^{ completion(NO); });
  NSURL *url = [NSURL URLWithString:urls[urlIndex]];
  if (!url) return Download(listId, urls, urlIndex + 1, completion);
  [[Session() dataTaskWithURL:url
            completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
              const NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class] ? ((NSHTTPURLResponse *)response).statusCode : 0;
              if (error || status != 200) {
                NSLog(@"[blocker] %@ from %@: %@", listId, url.host, error.localizedDescription ?: [NSString stringWithFormat:@"HTTP %ld", (long)status]);
                return Download(listId, urls, urlIndex + 1, completion);
              }
              dispatch_async(Work(), ^{
                const int32_t stored = bay_lists_store(Directory().fileSystemRepresentation, listId.UTF8String, (const uint8_t *)data.bytes,
                                                       data.length, NSDate.date.timeIntervalSince1970);
                if (stored == -1) {
                  NSLog(@"[blocker] %@ from %@: not a filter list", listId, url.host);
                  return Download(listId, urls, urlIndex + 1, completion);
                }
                completion(stored == 1);
              });
            }] resume];
}

// MARK: Building the engine

// Builds from the available files first, then rebuilds once missing lists have downloaded. Bundled rules must
// already block while an optional regional list is downloading. completion(missing) runs on the main thread.
void Rebuild(BOOL useCache, void (^_Nullable completion)(NSArray<NSString *> *missing)) {
  completion = [completion copy];
  const NSUInteger generation = ++gGeneration;
  NSString *ids = StringFrom(bay_lists_selected_ids(Lists()));
  NSString *lists = StringFrom(bay_lists_selected(Lists()));
  const double delayMs = std::exchange(gDelayNextLoadMs, 0);
  dispatch_async(Work(), ^{
    NSString *resourcePath = NSBundle.mainBundle.resourcePath;
    NSString *bundled = [resourcePath stringByAppendingPathComponent:@"FilterLists"];
    NSString *resources = [resourcePath stringByAppendingPathComponent:@"ContentBlocker/blocker-resources.json"];
    NSArray<NSString *> *absent = JSONFrom(bay_lists_seed(Directory().fileSystemRepresentation, bundled.fileSystemRepresentation, ids.UTF8String)) ?: @[];
    void (^buildAndPublish)(BOOL, NSArray<NSString *> *) = ^(BOOL finished, NSArray<NSString *> *missing) {
      // A newer selection is on its way: this one would be replaced at once. Nothing counts as missing, so a stale
      // failure can't turn off a list a newer selection has on.
      if (generation != gGeneration.load()) {
        if (finished && completion) dispatch_async(dispatch_get_main_queue(), ^{ completion(@[]); });
        return;
      }
      BayListsBuilt *built = bay_lists_build(Directory().fileSystemRepresentation, lists.UTF8String, resources.fileSystemRepresentation, useCache);
      NSDictionary *report = JSONFrom(bay_lists_built_report(built));
      NSLog(@"[blocker] %@ lists in %.0f ms", report[@"lists"], [report[@"ms"] doubleValue]);
      if (![report[@"resources"] boolValue]) NSLog(@"[blocker] missing or invalid bundled scriptlet/redirect resources");
      void (^apply)(void) = ^{
        const BOOL current = generation == gGeneration.load();
        if (current) {
          gEngine = std::make_shared<Engine>(bay_lists_apply(Lists(), built));
          PublishLive();
          Emit();
        } else {
          bay_lists_built_free(built);
        }
        if (finished && completion) completion(current ? missing : @[]);
      };
      if (delayMs > 0)
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delayMs * NSEC_PER_MSEC)), dispatch_get_main_queue(), apply);
      else
        dispatch_async(dispatch_get_main_queue(), apply);
    };
    buildAndPublish(absent.count == 0, @[]);
    if (!absent.count) return;
    dispatch_group_t group = dispatch_group_create();
    for (NSString *listId in absent) {
      dispatch_group_enter(group);
      Download(listId, URLs(listId), 0, ^(BOOL) { dispatch_group_leave(group); });
    }
    dispatch_group_notify(group, Work(), ^{
      buildAndPublish(YES, JSONFrom(bay_lists_absent(Directory().fileSystemRepresentation, ids.UTF8String)) ?: @[]);
    });
  });
}

// Lists past their expiry are fetched again; the engine is rebuilt if any changed.
void UpdateLists() {
  NSString *ids = StringFrom(bay_lists_selected_ids(Lists()));
  dispatch_async(Work(), ^{
    NSArray<NSString *> *due =
        JSONFrom(bay_lists_due(Directory().fileSystemRepresentation, ids.UTF8String, NSDate.date.timeIntervalSince1970));
    dispatch_group_t group = dispatch_group_create();
    __block BOOL changed = NO;
    for (NSString *listId in [due isKindOfClass:NSArray.class] ? due : @[]) {
      dispatch_group_enter(group);
      Download(listId, URLs(listId), 0, ^(BOOL listChanged) {
        changed = changed || listChanged;
        dispatch_group_leave(group);
      });
    }
    dispatch_group_notify(group, dispatch_get_main_queue(), ^{
      if (changed) Rebuild(YES, nil);
    });
  });
}

void ScheduleUpdates(double after) {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(after * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (bay_lists_enabled(Lists())) UpdateLists();
    ScheduleUpdates(bay_lists_update_every_seconds());
  });
}

// MARK: State for the app

// Tests (devFailNextMessage): the next change fails and changes nothing.
NSString *_Nullable FailedForTest() {
  if (!gFailNext) return nil;
  gFailNext = false;
  return @"failed (dev)";
}

void Changed() {
  SaveSettings();
  PublishLive();
  Emit();
}

// MARK: Cosmetic filters

NSString *_Nullable StyleFor(NSArray *selectors) {
  NSMutableString *css = [NSMutableString string];
  // One rule per selector: one the engine can't parse drops only itself.
  for (NSString *selector in selectors)
    if ([selector isKindOfClass:NSString.class] && selector.length && ![selector containsString:@"{"] && ![selector containsString:@"}"])
      [css appendFormat:@"%@{display:none!important}\n", selector];
  return css.length ? css : nil;
}

BOOL IsWeb(NSString *url) { return [url hasPrefix:@"http://"] || [url hasPrefix:@"https://"]; }

// The engine for a web frame's cosmetic filters, and its resources for the frame (bay_blocker_cosmetic); null when the
// blocker is off or paused on the page.
std::shared_ptr<Engine> CosmeticEngine(NSString *frameURL, NSString *pageURL, NSDictionary *_Nullable *resources) {
  if (!IsWeb(frameURL)) return nullptr;
  std::shared_ptr<const Live> live = CurrentLive();
  if (!live->enabled || !live->engine || PausedOn(*live, HostOf(pageURL.UTF8String))) return nullptr;
  NSDictionary *found = JSONFrom(bay_blocker_cosmetic(live->engine->blocker, frameURL.UTF8String));
  if (![found isKindOfClass:NSDictionary.class]) return nullptr;
  *resources = found;
  return live->engine;
}

}  // namespace

namespace nncore_host {

void PrepareContentBlocker() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Lists();
    PublishLive();
    if ([NNCoreEngine respondsToSelector:@selector(setRequestFilter:)]) [NNCoreEngine setRequestFilter:Filter];
    else NSLog(@"[blocker] this engine has no request filter: nothing is blocked");
    if ([NNCoreEngine respondsToSelector:@selector(setContentSecurityPolicySource:)])
      [NNCoreEngine setContentSecurityPolicySource:ContentSecurityPolicy];
    if ([NNCoreEngine respondsToSelector:@selector(setScriptletSource:)]) {
      [NNCoreEngine setScriptletSource:Scriptlets];
      gEngineRunsScriptlets = YES;
    }
    Rebuild(YES, nil);
    ScheduleUpdates(bay_lists_first_update_seconds());
    // Copies of uBlock Origin, the blocker before this one, from before 0.1.1.
    NSString *oldCopies = [[NNCoreHost.dataDirectory stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"Built-in Extensions"];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      if ([NSFileManager.defaultManager fileExistsAtPath:oldCopies]) [NSFileManager.defaultManager removeItemAtPath:oldCopies error:nil];
    });
  });
}

bool ContentBlockerBlocksPage(NSString *url) {
  const char *page = url.UTF8String;
  return page && Filter(page, page, page, "document", "GET", nullptr, nullptr);
}

NSDictionary *ContentBlockerCosmetics(NSString *frameURL, NSString *pageURL) {
  NSDictionary *resources;
  if (!CosmeticEngine(frameURL, pageURL, &resources)) return nil;
  NSMutableDictionary *answer = [NSMutableDictionary dictionary];
  answer[@"css"] = StyleFor([resources[@"hide"] isKindOfClass:NSArray.class] ? resources[@"hide"] : @[]);
  if (!gEngineRunsScriptlets && [resources[@"script"] isKindOfClass:NSString.class] && [resources[@"script"] length])
    answer[@"script"] = resources[@"script"];
  answer[@"generic"] = @(![resources[@"generichide"] boolValue]);
  if ([resources[@"procedural"] isKindOfClass:NSArray.class]) answer[@"procedural"] = resources[@"procedural"];
  return answer;
}

NSString *ContentBlockerGenericStyle(NSString *frameURL, NSString *pageURL, NSArray<NSString *> *classes,
                                     NSArray<NSString *> *ids) {
  NSDictionary *resources;
  std::shared_ptr<Engine> engine = CosmeticEngine(frameURL, pageURL, &resources);
  if (!engine || [resources[@"generichide"] boolValue]) return nil;
  NSDictionary *query = @{@"classes" : classes, @"ids" : ids, @"exceptions" : resources[@"exceptions"] ?: @[]};
  NSData *json = [NSJSONSerialization dataWithJSONObject:query options:0 error:nil];
  if (!json) return nil;
  NSString *text = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
  NSArray *selectors = JSONFrom(bay_blocker_hidden_selectors(engine->blocker, text.UTF8String));
  return [selectors isKindOfClass:NSArray.class] ? StyleFor(selectors) : nil;
}

}  // namespace nncore_host

@implementation NNCoreContentBlocker

+ (void)state:(void (^)(NSDictionary<NSString *, id> *))completion {
  completion(StateDictionary());
}

+ (void)setEnabled:(BOOL)enabled completion:(void (^)(NSString *))completion {
  if (NSString *error = FailedForTest()) return completion(error);
  const bool turnedOn = bay_lists_set_enabled(Lists(), enabled);
  Changed();
  // Back on after a while off: its lists may have gone stale meanwhile.
  if (turnedOn) UpdateLists();
  completion(nil);
}

+ (void)setList:(NSString *)listId enabled:(BOOL)enabled completion:(void (^)(NSString *))completion {
  if (!bay_lists_known(Lists(), listId.UTF8String)) return completion([@"no list " stringByAppendingString:listId ?: @""]);
  if (NSString *error = FailedForTest()) return completion(error);
  if (bay_lists_set_list(Lists(), listId.UTF8String, enabled) == 0) return completion(nil);
  SaveSettings();
  // Done when the engine has it (a new list downloads first), as uBO answered once its lists had reloaded. A list that
  // couldn't be downloaded isn't turned on.
  completion = [completion copy];
  Rebuild(YES, ^(NSArray<NSString *> *missing) {
    if (!enabled || ![missing containsObject:listId]) return completion(nil);
    bay_lists_set_list(Lists(), listId.UTF8String, NO);
    SaveSettings();
    Rebuild(YES, nil);
    completion([@"couldn't download " stringByAppendingString:listId]);
  });
}

+ (void)isAllowedOnHost:(NSString *)host completion:(void (^)(BOOL))completion {
  completion(bay_lists_is_allowed(Lists(), host.UTF8String));
}

+ (void)setAllowed:(BOOL)allowed onHost:(NSString *)host completion:(void (^)(NSString *))completion {
  if (NSString *error = FailedForTest()) return completion(error);
  // Blocking again on a host ends every pause that covers it ("example.com" for "www.example.com").
  if (!bay_lists_set_allowed(Lists(), host.UTF8String, allowed)) return completion(@"no host");
  Changed();
  completion(nil);
}

+ (void)setPageAllowed:(BOOL)allowed
                onHost:(NSString *)host
              remember:(BOOL)remember
            completion:(void (^)(NSString *))completion {
  if (NSString *error = FailedForTest()) return completion(error);
  if (!bay_lists_set_page_allowed(Lists(), host.UTF8String, allowed, remember)) return completion(@"no host");
  Changed();
  completion(nil);
}

+ (void)devFailNextMessage {
  gFailNext = true;
}

+ (void)devDelayNextLoad:(double)ms {
  gDelayNextLoadMs = ms;
}

@end
