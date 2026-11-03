// The built-in content blocker: Bay's own (packages/adblock, Brave's adblock-rust).
//
// The engine asks it about every web request a page makes (NNCoreRequestFilter: subresources on a background
// sequence, subframe navigations on the main thread) and fails the blocked ones with ERR_BLOCKED_BY_CLIENT. Cosmetic
// filters go into each frame as a user-origin sheet when its page script says hello (NNCoreWebView), and again for the
// classes and ids the page script finds in it (generic hiding).
//
// The filter lists are uBO's default catalogue (filter_lists.json): each one on or off, downloaded into
// <app support>/Content Blocker/lists and updated when its `! Expires:` says so. The default lists are bundled
// (Resources/FilterLists, packages/chromium/scripts/filter-lists.sh), so a new install blocks from its first page. The
// compiled engine is cached (engine.dat) and loads in milliseconds at launch; it's rebuilt when a list or the
// selection changes. Settings (on/off, the lists, the hosts it's paused on) live in settings.json and apply to every
// profile, private ones included.

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
            char **redirect) {
  if (redirect) *redirect = nullptr;
  std::shared_ptr<const Live> live = CurrentLive();
  if (!live->enabled || !live->engine) return false;
  if (PausedOn(*live, HostOf(top && *top ? top : source))) return false;
  const auto start = std::chrono::steady_clock::now();
  BayBlockerMatch match =
      bay_blocker_match(live->engine->blocker, url, source ?: "", type ?: "other", method ?: "GET");
  if (redirect && match.redirect) *redirect = strdup(match.redirect);
  bay_string_free(match.redirect);
  const uint64_t nanos =
      (uint64_t)std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - start).count();
  gLookups.fetch_add(1, std::memory_order_relaxed);
  gLookupNanos.fetch_add(nanos, std::memory_order_relaxed);
  uint64_t max = gMaxLookupNanos.load(std::memory_order_relaxed);
  while (nanos > max && !gMaxLookupNanos.compare_exchange_weak(max, nanos, std::memory_order_relaxed)) {
  }
  return match.blocked;
}

// MARK: The catalogue

NSString *const kVersion = @"adblock-rust 0.13.5";
// Bump with a change to how lists compile (the crate, its features): the cached engine is rebuilt.
NSString *const kEngineFormat = @"bay-adblock 2";

NSArray<NSDictionary *> *Catalogue() {
  static NSArray<NSDictionary *> *lists;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSBundle *bundle = [NSBundle bundleForClass:NNCoreContentBlocker.class];
    NSString *path = [bundle pathForResource:@"filter_lists" ofType:@"json"];
    NSData *data = path ? [NSData dataWithContentsOfFile:path] : nil;
    NSDictionary *json = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    NSMutableArray *valid = [NSMutableArray array];
    for (NSDictionary *list in [json isKindOfClass:NSDictionary.class] ? json[@"lists"] : nil)
      if ([list isKindOfClass:NSDictionary.class] && [list[@"id"] isKindOfClass:NSString.class] &&
          [list[@"urls"] isKindOfClass:NSArray.class])
        [valid addObject:list];
    if (!valid.count) NSLog(@"[blocker] no filter list catalogue (filter_lists.json)");
    lists = valid;
  });
  return lists;
}

NSDictionary *_Nullable CatalogueList(NSString *listId) {
  for (NSDictionary *list in Catalogue())
    if ([list[@"id"] isEqualToString:listId]) return list;
  return nil;
}

// On by default: the catalogue's default lists, and the regional ones for the user's languages (as uBO chose).
BOOL OnByDefault(NSDictionary *list) {
  if ([list[@"defaultOn"] boolValue]) return YES;
  NSString *lang = [list[@"lang"] isKindOfClass:NSString.class] ? list[@"lang"] : nil;
  if (!lang.length) return NO;
  NSSet *codes = [NSSet setWithArray:[lang componentsSeparatedByString:@" "]];
  for (NSString *preferred in NSLocale.preferredLanguages) {
    NSString *code = [[preferred componentsSeparatedByCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"-_"]]
                         .firstObject lowercaseString];
    if ([codes containsObject:code]) return YES;
  }
  return NO;
}

// MARK: Files

NSString *Directory() {
  static NSString *directory;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    directory = [[NNCoreHost.dataDirectory stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"Content Blocker"];
    [NSFileManager.defaultManager createDirectoryAtPath:[directory stringByAppendingPathComponent:@"lists"]
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:nil];
  });
  return directory;
}

NSString *ListPath(NSString *listId) {
  return [[Directory() stringByAppendingPathComponent:@"lists"] stringByAppendingPathComponent:[listId stringByAppendingPathExtension:@"txt"]];
}

NSString *BundledListPath(NSString *listId) {
  NSString *path = [[NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"FilterLists"]
      stringByAppendingPathComponent:[listId stringByAppendingPathExtension:@"txt"]];
  return [NSFileManager.defaultManager fileExistsAtPath:path] ? path : nil;
}

id ReadJSON(NSString *path) {
  NSData *data = [NSData dataWithContentsOfFile:path];
  return data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
}

// JSON the Rust library returned, which it then frees.
id JSONFrom(char *text) {
  if (!text) return nil;
  id value = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytesNoCopy:text length:strlen(text) freeWhenDone:NO] options:0 error:nil];
  bay_string_free(text);
  return value;
}

void WriteJSON(NSString *path, id value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error:nil];
  if (data) [data writeToFile:path atomically:YES];
}

// MARK: Settings (main thread)

BOOL gEnabled = YES;
NSMutableOrderedSet<NSString *> *gSelected;
NSMutableOrderedSet<NSString *> *gAllowed;
bool gFailNext = false;
double gDelayNextLoadMs = 0;

NSString *SettingsPath() { return [Directory() stringByAppendingPathComponent:@"settings.json"]; }

void LoadSettings() {
  if (gSelected) return;
  NSDictionary *saved = ReadJSON(SettingsPath());
  if (![saved isKindOfClass:NSDictionary.class]) saved = nil;
  gEnabled = [saved[@"enabled"] isKindOfClass:NSNumber.class] ? [saved[@"enabled"] boolValue] : YES;
  gSelected = [NSMutableOrderedSet orderedSet];
  if ([saved[@"lists"] isKindOfClass:NSArray.class]) {
    for (NSString *listId in saved[@"lists"])
      if ([listId isKindOfClass:NSString.class] && CatalogueList(listId)) [gSelected addObject:listId];
  } else {
    for (NSDictionary *list in Catalogue())
      if (OnByDefault(list)) [gSelected addObject:list[@"id"]];
  }
  gAllowed = [NSMutableOrderedSet orderedSet];
  for (NSString *host in [saved[@"allowedHosts"] isKindOfClass:NSArray.class] ? saved[@"allowedHosts"] : @[])
    if ([host isKindOfClass:NSString.class] && host.length) [gAllowed addObject:host.lowercaseString];
}

void SaveSettings() {
  WriteJSON(SettingsPath(), @{@"enabled" : @(gEnabled), @"lists" : gSelected.array, @"allowedHosts" : gAllowed.array});
}

// The selection in catalogue order, so the engine (and its cache key) doesn't depend on the order lists were picked.
NSArray<NSString *> *SelectedInOrder() {
  NSMutableArray *ids = [NSMutableArray array];
  for (NSDictionary *list in Catalogue())
    if ([gSelected containsObject:list[@"id"]]) [ids addObject:list[@"id"]];
  return ids;
}

// MARK: State the main thread keeps about the engine

BOOL gReady = NO;
double gParseMs = 0;
NSDictionary<NSString *, NSDictionary *> *gCounts = @{};
std::atomic<NSUInteger> gGeneration{0};
std::shared_ptr<Engine> gEngine;

void PublishLive() {
  auto live = std::make_shared<Live>();
  live->engine = gEngine;
  live->enabled = gEnabled;
  for (NSString *host in gAllowed) live->allowed.emplace_back(host.UTF8String);
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

NSDictionary *StatsDictionary();
void Emit() {
  if (NNCoreHost.eventHandler) NNCoreHost.eventHandler(@"contentBlocker", StatsDictionary());
}

// MARK: Lists on disk and on the network

NSDictionary *ListInfo() {
  NSDictionary *info = ReadJSON([Directory() stringByAppendingPathComponent:@"lists.json"]);
  return [info isKindOfClass:NSDictionary.class] ? info : @{};
}

// How long a list stays fresh, from its `! Expires: 4 days (update frequency)` header: 12 hours to a week, else 4 days.
NSTimeInterval ExpiresAfter(NSString *text) {
  NSString *head = [text substringToIndex:MIN(text.length, (NSUInteger)4096)];
  NSRegularExpression *expires = [NSRegularExpression regularExpressionWithPattern:@"^[!#]\\s*Expires:\\s*(\\d+)\\s*(h|d)"
                                                                           options:NSRegularExpressionCaseInsensitive |
                                                                                   NSRegularExpressionAnchorsMatchLines
                                                                             error:nil];
  NSTextCheckingResult *match = [expires firstMatchInString:head options:0 range:NSMakeRange(0, head.length)];
  if (!match) return 4 * 86400;
  const double n = [head substringWithRange:[match rangeAtIndex:1]].doubleValue;
  const BOOL hours = [[head substringWithRange:[match rangeAtIndex:2]].lowercaseString isEqualToString:@"h"];
  return MIN(MAX(n * (hours ? 3600 : 86400), 12 * 3600), 7 * 86400);
}

// A filter list, not an error page: text that doesn't start like HTML. Bytes, not a decoded prefix: a prefix can end
// inside a multibyte character (as Croatian and Vietnamese lists' do at 512 bytes), which wouldn't decode.
BOOL LooksLikeList(NSData *data) {
  if (data.length < 16 || data.length > 32 * 1024 * 1024) return NO;
  const unsigned char *bytes = (const unsigned char *)data.bytes;
  NSUInteger at = 0;
  // A UTF-8 byte order mark, then whitespace.
  if (data.length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) at = 3;
  while (at < data.length && isspace(bytes[at])) at++;
  return at < data.length && bytes[at] != '<';
}

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

// Downloads a list from its first URL that answers; completion(changed) on Work(): whether its file changed.
void Download(NSDictionary *list, NSUInteger urlIndex, void (^completion)(BOOL changed)) {
  NSArray<NSString *> *urls = list[@"urls"];
  if (urlIndex >= urls.count) return dispatch_async(Work(), ^{ completion(NO); });
  NSURL *url = [NSURL URLWithString:urls[urlIndex]];
  if (!url) return Download(list, urlIndex + 1, completion);
  [[Session() dataTaskWithURL:url
            completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
              const NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class] ? ((NSHTTPURLResponse *)response).statusCode : 0;
              if (error || status != 200 || !LooksLikeList(data)) {
                NSLog(@"[blocker] %@ from %@: %@", list[@"id"], url.host, error.localizedDescription ?: [NSString stringWithFormat:@"HTTP %ld", (long)status]);
                return Download(list, urlIndex + 1, completion);
              }
              dispatch_async(Work(), ^{
                NSString *path = ListPath(list[@"id"]);
                NSData *old = [NSData dataWithContentsOfFile:path];
                const BOOL changed = ![old isEqualToData:data];
                if (changed) [data writeToFile:path atomically:YES];
                NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
                NSMutableDictionary *info = [ListInfo() mutableCopy];
                info[list[@"id"]] = @{@"fetched" : @(NSDate.date.timeIntervalSince1970), @"expires" : @(ExpiresAfter(text))};
                WriteJSON([Directory() stringByAppendingPathComponent:@"lists.json"], info);
                completion(changed);
              });
            }] resume];
}

// On Work(): copies a bundled list in when there's none on disk yet (it counts as fetched long ago: it updates soon).
void SeedFromBundle(NSString *listId) {
  NSString *path = ListPath(listId);
  if ([NSFileManager.defaultManager fileExistsAtPath:path]) return;
  if (NSString *bundled = BundledListPath(listId)) [NSFileManager.defaultManager copyItemAtPath:bundled toPath:path error:nil];
}

// MARK: Building the engine (Work())

NSString *EngineKey(NSArray<NSString *> *ids) {
  NSMutableArray *parts = [NSMutableArray arrayWithObject:kEngineFormat];
  for (NSString *listId in ids) {
    NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:ListPath(listId) error:nil];
    if (!attributes) continue;
    [parts addObject:[NSString stringWithFormat:@"%@ %llu %.0f", listId, attributes.fileSize,
                                                attributes.fileModificationDate.timeIntervalSince1970]];
  }
  return [parts componentsJoinedByString:@"\n"];
}

struct Built {
  std::shared_ptr<Engine> engine;
  double ms = 0;
  NSDictionary<NSString *, NSDictionary *> *counts = @{};
};

NSDictionary *CountsFor(BayBlocker *blocker, NSArray<NSString *> *ids) {
  NSArray *counts = JSONFrom(bay_blocker_list_counts(blocker));
  NSMutableDictionary *byId = [NSMutableDictionary dictionary];
  if (![counts isKindOfClass:NSArray.class] || counts.count != ids.count) return byId;
  for (NSUInteger i = 0; i < ids.count; i++) {
    NSDictionary *c = counts[i];
    byId[ids[i]] = @{@"network" : c[@"networkFilters"] ?: @0, @"cosmetic" : c[@"cosmeticFilters"] ?: @0};
  }
  return byId;
}

// A new engine from the lists' files, in order.
BayBlocker *Compile(NSArray<NSString *> *ids) {
  std::vector<std::string> texts;
  std::unique_ptr<bool[]> hosts(new bool[ids.count + 1]);
  std::vector<uint8_t> permissions;
  for (NSUInteger i = 0; i < ids.count; i++) {
    NSData *data = [NSData dataWithContentsOfFile:ListPath(ids[i])];
    texts.emplace_back((const char *)data.bytes, data.length);
    hosts[i] = [CatalogueList(ids[i])[@"hosts"] boolValue];
    // As in uBO, only its own uAssets lists may invoke privileged scriptlets.
    permissions.push_back([ids[i] hasPrefix:@"ublock-"] ? 1 : 0);
  }
  std::vector<const char *> pointers;
  for (const std::string &text : texts) pointers.push_back(text.c_str());
  return bay_blocker_new_with_permissions(pointers.data(), hosts.get(), permissions.data(), pointers.size());
}

Built Build(NSArray<NSString *> *ids, BOOL useCache) {
  Built built;
  const CFTimeInterval start = CACurrentMediaTime();
  NSMutableArray<NSString *> *present = [NSMutableArray array];
  for (NSString *listId in ids)
    if ([NSFileManager.defaultManager fileExistsAtPath:ListPath(listId)]) [present addObject:listId];
  NSString *key = EngineKey(present);
  NSString *enginePath = [Directory() stringByAppendingPathComponent:@"engine.dat"];
  NSString *keyPath = [Directory() stringByAppendingPathComponent:@"engine.key"];
  NSString *metaPath = [Directory() stringByAppendingPathComponent:@"engine.lists.json"];
  BayBlocker *blocker = nullptr;
  if (useCache && [[NSString stringWithContentsOfFile:keyPath encoding:NSUTF8StringEncoding error:nil] isEqualToString:key]) {
    NSData *data = [NSData dataWithContentsOfFile:enginePath options:NSDataReadingMappedIfSafe error:nil];
    NSArray *cachedIds = ReadJSON(metaPath);
    if (data && [cachedIds isEqual:present]) blocker = bay_blocker_deserialize((const uint8_t *)data.bytes, data.length);
  }
  if (!blocker) {
    blocker = Compile(present);
    size_t length = 0;
    uint8_t *bytes = bay_blocker_serialize(blocker, &length);
    if ([[NSData dataWithBytesNoCopy:bytes length:length freeWhenDone:NO] writeToFile:enginePath atomically:YES]) {
      WriteJSON(metaPath, present);
      [key writeToFile:keyPath atomically:YES encoding:NSUTF8StringEncoding error:nil];
    }
    bay_bytes_free(bytes, length);
  }
  // Resource storage is separate from adblock-rust's serialized filter engine. Load the pinned resources for both
  // new and cached engines, so scriptlets and redirect stand-ins work on every launch.
  NSString *resourcesPath =
      [NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"ContentBlocker/blocker-resources.json"];
  NSString *resources = [NSString stringWithContentsOfFile:resourcesPath encoding:NSUTF8StringEncoding error:nil];
  if (!resources || !bay_blocker_use_resources(blocker, resources.UTF8String))
    NSLog(@"[blocker] missing or invalid bundled scriptlet/redirect resources");
  built.engine = std::make_shared<Engine>(blocker);
  built.ms = (CACurrentMediaTime() - start) * 1000;
  built.counts = CountsFor(blocker, present);
  return built;
}

// Builds from the available files first, then rebuilds once missing lists have downloaded. Bundled rules must
// already block while an optional regional list is downloading. completion(missing) runs on the main thread.
void Rebuild(BOOL useCache, void (^_Nullable completion)(NSArray<NSString *> *missing)) {
  completion = [completion copy];
  const NSUInteger generation = ++gGeneration;
  NSArray<NSString *> *ids = SelectedInOrder();
  const double delayMs = std::exchange(gDelayNextLoadMs, 0);
  dispatch_async(Work(), ^{
    for (NSString *listId in ids) SeedFromBundle(listId);
    void (^buildAndPublish)(BOOL, NSArray<NSString *> *) = ^(BOOL finished, NSArray<NSString *> *missing) {
      if (generation != gGeneration.load()) {
        if (finished && completion) dispatch_async(dispatch_get_main_queue(), ^{ completion(@[]); });
        return;
      }
      auto built = std::make_shared<Built>(Build(ids, useCache));
      NSLog(@"[blocker] %lu lists in %.0f ms", (unsigned long)built->counts.count, built->ms);
      void (^apply)(void) = ^{
        const BOOL current = generation == gGeneration.load();
        if (current) {
          gEngine = built->engine;
          gParseMs = built->ms;
          gCounts = built->counts;
          gReady = YES;
          PublishLive();
          Emit();
        }
        if (finished && completion) completion(current ? missing : @[]);
      };
      if (delayMs > 0)
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delayMs * NSEC_PER_MSEC)), dispatch_get_main_queue(), apply);
      else
        dispatch_async(dispatch_get_main_queue(), apply);
    };
    NSMutableArray<NSString *> *absent = [NSMutableArray array];
    for (NSString *listId in ids)
      if (![NSFileManager.defaultManager fileExistsAtPath:ListPath(listId)]) [absent addObject:listId];
    buildAndPublish(absent.count == 0, @[]);
    if (!absent.count) return;
    dispatch_group_t group = dispatch_group_create();
    for (NSString *listId in absent) {
      dispatch_group_enter(group);
      Download(CatalogueList(listId), 0, ^(BOOL) { dispatch_group_leave(group); });
    }
    dispatch_group_notify(group, Work(), ^{
      NSMutableArray<NSString *> *missing = [NSMutableArray array];
      for (NSString *listId in ids)
        if (![NSFileManager.defaultManager fileExistsAtPath:ListPath(listId)]) [missing addObject:listId];
      buildAndPublish(YES, missing);
    });
  });
}

// Lists past their expiry are fetched again; the engine is rebuilt if any changed. force: every selected list.
void UpdateLists(BOOL force) {
  NSArray<NSString *> *ids = SelectedInOrder();
  dispatch_async(Work(), ^{
    NSDictionary *info = ListInfo();
    const NSTimeInterval now = NSDate.date.timeIntervalSince1970;
    dispatch_group_t group = dispatch_group_create();
    __block BOOL changed = NO;
    for (NSString *listId in ids) {
      NSDictionary *entry = [info[listId] isKindOfClass:NSDictionary.class] ? info[listId] : nil;
      const NSTimeInterval fetched = [entry[@"fetched"] doubleValue], expires = entry[@"expires"] ? [entry[@"expires"] doubleValue] : 0;
      if (!force && fetched + expires > now) continue;
      NSDictionary *list = CatalogueList(listId);
      if (!list) continue;
      dispatch_group_enter(group);
      Download(list, 0, ^(BOOL listChanged) {
        changed = changed || listChanged;
        dispatch_group_leave(group);
      });
    }
    dispatch_group_notify(group, dispatch_get_main_queue(), ^{
      if (changed) Rebuild(YES, nil);
    });
  });
}

constexpr double kFirstUpdateSeconds = 60;
constexpr double kUpdateEverySeconds = 3 * 3600;

void ScheduleUpdates(double after) {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(after * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (gEnabled) UpdateLists(NO);
    ScheduleUpdates(kUpdateEverySeconds);
  });
}

// MARK: State for the app

NSDictionary *StatsDictionary() {
  double network = 0, cosmetic = 0;
  for (NSString *listId in gCounts) {
    network += [gCounts[listId][@"network"] doubleValue];
    cosmetic += [gCounts[listId][@"cosmetic"] doubleValue];
  }
  const uint64_t lookups = gLookups.load(std::memory_order_relaxed);
  const double averageMicros = lookups ? gLookupNanos.load(std::memory_order_relaxed) / 1000.0 / lookups : 0;
  return @{
    @"ready" : @(gReady),
    @"enabled" : @(gEnabled),
    @"networkFilters" : @(network),
    @"cosmeticFilters" : @(cosmetic),
    @"parseMs" : @(round(gParseMs)),
    @"lookups" : @(lookups),
    @"averageLookupMicros" : @(round(averageMicros * 100) / 100),
    @"maxLookupMicros" : @(round(gMaxLookupNanos.load(std::memory_order_relaxed) / 10.0) / 100),
  };
}

NSDictionary *StateDictionary() {
  NSMutableArray *lists = [NSMutableArray array];
  for (NSDictionary *list in Catalogue()) {
    NSDictionary *counts = gCounts[list[@"id"]];
    [lists addObject:@{
      @"id" : list[@"id"],
      @"title" : [list[@"title"] isKindOfClass:NSString.class] ? list[@"title"] : list[@"id"],
      @"category" : [list[@"category"] isKindOfClass:NSString.class] ? list[@"category"] : @"ads",
      @"enabled" : @([gSelected containsObject:list[@"id"]]),
      @"defaultOn" : @(OnByDefault(list)),
      @"filters" : @([counts[@"network"] doubleValue] + [counts[@"cosmetic"] doubleValue]),
    }];
  }
  return @{
    @"enabled" : @(gEnabled),
    @"version" : kVersion,
    @"lists" : lists,
    @"allowedHosts" : gAllowed.array,
    @"stats" : StatsDictionary(),
  };
}

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
    LoadSettings();
    PublishLive();
    if ([NNCoreEngine respondsToSelector:@selector(setRequestFilter:)]) [NNCoreEngine setRequestFilter:Filter];
    else NSLog(@"[blocker] this engine has no request filter: nothing is blocked");
    Rebuild(YES, nil);
    ScheduleUpdates(kFirstUpdateSeconds);
    // Copies of uBlock Origin, the blocker before this one, from before 0.1.1.
    NSString *oldCopies = [[NNCoreHost.dataDirectory stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"Built-in Extensions"];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      if ([NSFileManager.defaultManager fileExistsAtPath:oldCopies]) [NSFileManager.defaultManager removeItemAtPath:oldCopies error:nil];
    });
  });
}

NSDictionary *ContentBlockerCosmetics(NSString *frameURL, NSString *pageURL) {
  NSDictionary *resources;
  if (!CosmeticEngine(frameURL, pageURL, &resources)) return nil;
  NSMutableDictionary *answer = [NSMutableDictionary dictionary];
  answer[@"css"] = StyleFor([resources[@"hide"] isKindOfClass:NSArray.class] ? resources[@"hide"] : @[]);
  if ([resources[@"script"] isKindOfClass:NSString.class] && [resources[@"script"] length]) answer[@"script"] = resources[@"script"];
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
  LoadSettings();
  completion(StateDictionary());
}

+ (void)setEnabled:(BOOL)enabled completion:(void (^)(NSString *))completion {
  LoadSettings();
  if (NSString *error = FailedForTest()) return completion(error);
  const BOOL wasEnabled = gEnabled;
  gEnabled = enabled;
  Changed();
  // Back on after a while off: its lists may have gone stale meanwhile.
  if (enabled && !wasEnabled) UpdateLists(NO);
  completion(nil);
}

+ (void)setList:(NSString *)listId enabled:(BOOL)enabled completion:(void (^)(NSString *))completion {
  LoadSettings();
  if (!CatalogueList(listId)) return completion([@"no list " stringByAppendingString:listId ?: @""]);
  if (NSString *error = FailedForTest()) return completion(error);
  if (enabled == [gSelected containsObject:listId]) return completion(nil);
  if (enabled) [gSelected addObject:listId];
  else [gSelected removeObject:listId];
  SaveSettings();
  // Done when the engine has it (a new list downloads first), as uBO answered once its lists had reloaded. A list that
  // couldn't be downloaded isn't turned on.
  completion = [completion copy];
  Rebuild(YES, ^(NSArray<NSString *> *missing) {
    if (!enabled || ![missing containsObject:listId]) return completion(nil);
    [gSelected removeObject:listId];
    SaveSettings();
    Rebuild(YES, nil);
    completion([@"couldn't download " stringByAppendingString:listId]);
  });
}

+ (void)isAllowedOnHost:(NSString *)host completion:(void (^)(BOOL))completion {
  LoadSettings();
  const std::string name = HostOf(host.lowercaseString.UTF8String);
  for (NSString *allowed in gAllowed)
    if (Covers(allowed.UTF8String, name)) return completion(YES);
  completion(NO);
}

+ (void)setAllowed:(BOOL)allowed onHost:(NSString *)host completion:(void (^)(NSString *))completion {
  LoadSettings();
  if (NSString *error = FailedForTest()) return completion(error);
  NSString *name = [NSString stringWithUTF8String:HostOf(host.lowercaseString.UTF8String).c_str()];
  if (!name.length) return completion(@"no host");
  if (allowed) {
    [gAllowed addObject:name];
  } else {
    // Blocking again on a host ends every pause that covers it ("example.com" for "www.example.com").
    for (NSString *entry in gAllowed.array)
      if (Covers(entry.UTF8String, name.UTF8String)) [gAllowed removeObject:entry];
  }
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
