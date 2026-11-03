// Exercise the production blocker with temporary storage and controlled, offline downloads.
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#include "../ios/NNCoreContentBlocker.mm"

static NSString *testRoot;
static NSBundle *testBundle;
static NSMutableArray<NSURLProtocol *> *pending;

@implementation NNCoreHost
+ (NSString *)dataDirectory { return [testRoot stringByAppendingPathComponent:@"Chromium"]; }
+ (void (^)(NSString *, NSDictionary<NSString *, id> *))eventHandler { return nil; }
@end
@implementation NNCoreEngine
+ (void)setRequestFilter:(NNCoreRequestFilter)filter {}
@end

@interface BlockerTestProtocol : NSURLProtocol
@end
@implementation BlockerTestProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request { return YES; }
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading { @synchronized (pending) { [pending addObject:self]; } }
- (void)stopLoading {}
@end

@interface NSURLSessionConfiguration (BlockerTest)
+ (NSURLSessionConfiguration *)blockerTestConfiguration;
@end
@implementation NSURLSessionConfiguration (BlockerTest)
+ (NSURLSessionConfiguration *)blockerTestConfiguration {
  NSURLSessionConfiguration *config = [self blockerTestConfiguration];
  config.protocolClasses = @[BlockerTestProtocol.class];
  return config;
}
@end

static NSBundle *BundleForTest(id, SEL, ...) { return testBundle; }
static void Require(BOOL success, const char *message) {
  if (!success) { fprintf(stderr, "FAIL: %s\n", message); exit(1); }
}
static void Until(BOOL (^condition)(void), const char *message) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
  while (!condition() && deadline.timeIntervalSinceNow > 0)
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  Require(condition(), message);
}
static NSURLProtocol *Request(NSString *path, BOOL take) {
  @synchronized (pending) {
    for (NSURLProtocol *request in pending.copy) {
      if (![request.request.URL.path isEqualToString:path]) continue;
      if (take) [pending removeObject:request];
      return request;
    }
  }
  return nil;
}
static NSUInteger RequestCount(NSString *path) {
  @synchronized (pending) {
    NSUInteger count = 0;
    for (NSURLProtocol *request in pending)
      if ([request.request.URL.path isEqualToString:path]) count++;
    return count;
  }
}
static void Respond(NSString *path, NSString *text) {
  NSURLProtocol *request = Request(path, YES);
  Require(request != nil, "expected pending download");
  if (!text) {
    [request.client URLProtocol:request didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorNotConnectedToInternet userInfo:nil]];
    return;
  }
  NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:request.request.URL statusCode:200 HTTPVersion:@"HTTP/1.1" headerFields:nil];
  [request.client URLProtocol:request didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
  [request.client URLProtocol:request didLoadData:[text dataUsingEncoding:NSUTF8StringEncoding]];
  [request.client URLProtocolDidFinishLoading:request];
}
static BOOL Blocks(const char *url, const char *top = "https://site.example/") {
  return Filter(url, "https://site.example/", top, "image", "GET", nullptr);
}
static void Setup() {
  NSString *resources = [testRoot stringByAppendingPathComponent:@"Fixture.bundle/Contents/Resources"];
  [NSFileManager.defaultManager createDirectoryAtPath:[resources stringByAppendingPathComponent:@"FilterLists"] withIntermediateDirectories:YES attributes:nil error:nil];
  [@{@"CFBundleIdentifier": @"bay.content-blocker.tests", @"CFBundlePackageType": @"BNDL"} writeToFile:[testRoot stringByAppendingPathComponent:@"Fixture.bundle/Contents/Info.plist"] atomically:YES];
  NSArray *lists = @[
    @{@"id": @"easylist", @"defaultOn": @YES, @"urls": @[@"https://fixture.test/easylist"]},
    @{@"id": @"FRA-0", @"lang": @"fr", @"urls": @[@"https://fixture.test/french"]},
    @{@"id": @"DEU-0", @"lang": @"de", @"urls": @[@"https://fixture.test/german"]}
  ];
  NSData *catalogue = [NSJSONSerialization dataWithJSONObject:@{@"lists": lists} options:0 error:nil];
  [catalogue writeToFile:[resources stringByAppendingPathComponent:@"filter_lists.json"] atomically:YES];
  [@"||ads.example^\n! Expires: 4 days\n" writeToFile:[resources stringByAppendingPathComponent:@"FilterLists/easylist.txt"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
  [NSFileManager.defaultManager createDirectoryAtPath:[resources stringByAppendingPathComponent:@"ContentBlocker"] withIntermediateDirectories:YES attributes:nil error:nil];
  [@"[]" writeToFile:[resources stringByAppendingPathComponent:@"ContentBlocker/blocker-resources.json"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
  testBundle = [NSBundle bundleWithPath:[testRoot stringByAppendingPathComponent:@"Fixture.bundle"]];
  method_setImplementation(class_getClassMethod(NSBundle.class, @selector(mainBundle)), (IMP)BundleForTest);
  method_setImplementation(class_getClassMethod(NSBundle.class, @selector(bundleForClass:)), (IMP)BundleForTest);
  method_exchangeImplementations(class_getClassMethod(NSURLSessionConfiguration.class, @selector(ephemeralSessionConfiguration)), class_getClassMethod(NSURLSessionConfiguration.class, @selector(blockerTestConfiguration)));
  pending = [NSMutableArray array];
  LoadSettings();
  gSelected = [NSMutableOrderedSet orderedSetWithArray:@[@"easylist", @"FRA-0"]];
}
int main(int argc, char **argv) {
  @autoreleasepool {
    Require(argc == 2, "temporary test directory required");
    testRoot = @(argv[1]);
    Setup();
    __block BOOL initialDone = NO;
    Rebuild(YES, ^(NSArray *missing) { Require(missing.count == 0, "downloaded list is available"); initialDone = YES; });
    Until(^BOOL { return gReady && Request(@"/french", NO) != nil; }, "bundled rules ready while regional download stalls");
    Require(!initialDone && Blocks("https://ads.example/pixel"), "bundled list blocks before regional download completes");
    Respond(@"/french", @"||regional.example^\n! Expires: 4 days\n");
    Until(^BOOL { return initialDone && Blocks("https://regional.example/pixel"); }, "downloaded regional rules apply");
    puts("PASS: bundled rules load before missing regional lists; downloaded rules are added");

    [NNCoreContentBlocker setAllowed:YES onHost:@"site.example" completion:^(NSString *error) { Require(!error, "pause succeeds"); }];
    Require(!Blocks("https://ads.example/pixel", "https://child.site.example/"), "pause covers subdomains");
    [NNCoreContentBlocker setAllowed:NO onHost:@"child.site.example" completion:^(NSString *error) { Require(!error, "resume succeeds"); }];
    Require(Blocks("https://ads.example/pixel"), "resuming a child removes its covering pause");
    [NNCoreContentBlocker setEnabled:NO completion:^(NSString *error) { Require(!error, "disable succeeds"); }];
    Require(!Blocks("https://ads.example/pixel"), "disabled blocker allows requests");
    [NNCoreContentBlocker setEnabled:YES completion:^(NSString *error) { Require(!error, "enable succeeds"); }];
    Require(Blocks("https://ads.example/pixel"), "re-enabling restores existing rules immediately");
    puts("PASS: pause, resume and enabled state control live requests");

    __block BOOL oldDone = NO, disabledDone = NO, newDone = NO;
    [NNCoreContentBlocker setList:@"DEU-0" enabled:YES completion:^(NSString *) { oldDone = YES; }];
    Until(^BOOL { return Request(@"/german", NO) != nil; }, "first regional download pending");
    [NNCoreContentBlocker setList:@"DEU-0" enabled:NO completion:^(NSString *error) { Require(!error, "list disable succeeds"); disabledDone = YES; }];
    Until(^BOOL { return disabledDone; }, "new selection applied");
    [NNCoreContentBlocker setList:@"DEU-0" enabled:YES completion:^(NSString *error) { Require(!error, "new list enable succeeds"); newDone = YES; }];
    Until(^BOOL { return RequestCount(@"/german") == 2; }, "replacement download pending");
    Respond(@"/german", nil);
    Until(^BOOL { return oldDone; }, "stale failed selection completes");
    Require([gSelected containsObject:@"DEU-0"], "stale failure cannot disable a newer selection");
    Until(^BOOL { return Request(@"/german", NO) != nil; }, "replacement download remains pending");
    Respond(@"/german", @"||german.example^\n! Expires: 4 days\n");
    Until(^BOOL { return newDone && Blocks("https://german.example/pixel"); }, "newer download applies after stale failure");
    puts("PASS: an older failed download cannot overwrite a newer list selection");

    // A download is a list by its bytes: a decoded prefix can end inside a multibyte character, as Croatian and
    // Vietnamese lists' first 512 bytes do.
    NSMutableData *list = [[@"! Title: " dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
    while (list.length < 511) [list appendBytes:"a" length:1];
    [list appendData:[@"Lọc quảng cáo\n||ads.example^\n" dataUsingEncoding:NSUTF8StringEncoding]];
    Require(LooksLikeList(list), "a list whose first 512 bytes end inside a character is a list");
    Require(!LooksLikeList([@"\xef\xbb\xbf  <!doctype html><p>error page</p>" dataUsingEncoding:NSUTF8StringEncoding]),
            "an HTML error page isn't a list");
    puts("PASS: downloads are recognised as lists by their bytes");

    // Rewrites ($removeparam) and scriptlets, from the live engine.
    const char *rules = "$removeparam=fbclid\nnews.example##+js(bay-probe)\n";
    BayBlocker *blocker = bay_blocker_new(&rules, nullptr, 1);
    Require(bay_blocker_use_resources(blocker, "[{\"name\":\"bay-probe.js\",\"kind\":{\"mime\":\"application/javascript\"},"
                                               "\"content\":\"Y29uc29sZS5sb2coMSk=\"}]"),
            "scriptlet resources load");
    gEngine = std::make_shared<Engine>(blocker);
    PublishLive();
    const char *tracked = "https://news.example/story?id=1&fbclid=abc";
    char *rewrite = nullptr;
    Require(!Filter(tracked, tracked, tracked, "document", "GET", &rewrite), "a tracked document isn't blocked");
    Require(rewrite && !strcmp(rewrite, "https://news.example/story?id=1"), "it loads without its tracking parameter");
    free(rewrite);
    char *script = Scriptlets("https://news.example/story", "https://news.example");
    Require(script && strstr(script, "console.log(1)"), "a document gets its site's scriptlets");
    free(script);
    [NNCoreContentBlocker setAllowed:YES onHost:@"news.example" completion:^(NSString *error) { Require(!error, "pause succeeds"); }];
    rewrite = nullptr;
    Filter(tracked, tracked, tracked, "document", "GET", &rewrite);
    Require(!rewrite && !Scriptlets("https://news.example/story", "https://news.example"), "a paused site gets neither");
    puts("PASS: allowed documents lose tracking parameters and get scriptlets, except where paused");
  }
}
