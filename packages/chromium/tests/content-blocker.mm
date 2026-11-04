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
static NNCoreResponseFilter gResponseFilter;
static NNCoreBodyFilterGate gBodyGate;
static NNCoreBodyFilter gBodyFilter;
static NNCoreRequestHeaderNames gHeaderNames;
static NNCoreRequestHeaderFilter gHeaderFilter;
static NNCoreCnameFilter gCnameFilter;
@implementation NNCoreEngine
+ (void)setRequestFilter:(NNCoreRequestFilter)filter {}
+ (void)setResponseFilter:(NNCoreResponseFilter)filter { gResponseFilter = filter; }
+ (void)setBodyFilterGate:(NNCoreBodyFilterGate)gate filter:(NNCoreBodyFilter)filter {
  gBodyGate = gate;
  gBodyFilter = filter;
}
+ (void)setRequestHeaderNames:(NNCoreRequestHeaderNames)names filter:(NNCoreRequestHeaderFilter)filter {
  gHeaderNames = names;
  gHeaderFilter = filter;
}
+ (void)setCnameFilter:(NNCoreCnameFilter)filter { gCnameFilter = filter; }
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
  return Filter(url, "https://site.example/", top, "image", "GET", nullptr, nullptr);
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
    Require(!Filter(tracked, tracked, tracked, "document", "GET", &rewrite, nullptr), "a tracked document isn't blocked");
    Require(rewrite && !strcmp(rewrite, "https://news.example/story?id=1"), "it loads without its tracking parameter");
    free(rewrite);
    char *script = Scriptlets("https://news.example/story", "https://news.example");
    Require(script && strstr(script, "console.log(1)"), "a document gets its site's scriptlets");
    free(script);
    [NNCoreContentBlocker setAllowed:YES onHost:@"news.example" completion:^(NSString *error) { Require(!error, "pause succeeds"); }];
    rewrite = nullptr;
    Filter(tracked, tracked, tracked, "document", "GET", &rewrite, nullptr);
    Require(!rewrite && !Scriptlets("https://news.example/story", "https://news.example"), "a paused site gets neither");
    puts("PASS: allowed documents lose tracking parameters and get scriptlets, except where paused");

    // Popups and $csp, from the live engine.
    const char *policies = "||pop.example^$popup\n||policy.example^$doc,csp=worker-src 'none'\n";
    gEngine = std::make_shared<Engine>(bay_blocker_new(&policies, nullptr, 1));
    PublishLive();
    const char *opener = "https://opener.example/";
    Require(Filter("https://pop.example/ad", opener, opener, "popup", "GET", nullptr, nullptr), "a popup rule refuses the page");
    Require(!Filter("https://pop.example/a.png", opener, opener, "image", "GET", nullptr, nullptr), "and not the host's other requests");
    Require(!Filter("https://fine.example/", opener, opener, "popup", "GET", nullptr, nullptr), "another page opens");
    const char *page = "https://policy.example/";
    char *policy = ContentSecurityPolicy(page, page, page, "document");
    Require(policy && !strcmp(policy, "worker-src 'none'"), "a document gets its site's policy");
    free(policy);
    Require(!ContentSecurityPolicy(opener, opener, opener, "document"), "other sites get none");
    [NNCoreContentBlocker setAllowed:YES onHost:@"opener.example" completion:^(NSString *error) { Require(!error, "pause succeeds"); }];
    Require(!Filter("https://pop.example/ad", opener, opener, "popup", "GET", nullptr, nullptr), "a paused opener's popups open");
    [NNCoreContentBlocker setAllowed:YES onHost:@"policy.example" completion:^(NSString *error) { Require(!error, "pause succeeds"); }];
    Require(!ContentSecurityPolicy(page, page, page, "document"), "a paused site gets no policy");
    puts("PASS: popup rules refuse pages a page opens and documents get $csp, except where paused");

    // Response rules: $header and its plain exception, $permissions, ##^responseheader.
    const char *responses = "||cdn.example^$script,header=server:nginx\n@@||cdn.example/ok.js^$script\n\
                             *$doc,permissions=compute-pressure=()\nstream.example##^responseheader(set-cookie)\n";
    gEngine = std::make_shared<Engine>(bay_blocker_new(&responses, nullptr, 1));
    PublishLive();
    Require(gResponseFilter != nullptr, "response rules register a filter");
    const char *asset = "https://cdn.example/ad.js";
    char *answer = gResponseFilter(asset, "https://site.example/", "https://site.example/", "script", "GET", "1.2.3.4",
                                   "[[\"Server\",\"nginx\"]]");
    Require(answer && strstr(answer, "\"blocked\":true"), "a matching response header blocks");
    free(answer);
    const char *allowed = "https://cdn.example/ok.js";
    Require(!gResponseFilter(allowed, "https://site.example/", "https://site.example/", "script", "GET", "1.2.3.4",
                             "[[\"Server\",\"nginx\"]]"),
            "a plain exception allows it");
    const char *policyPage = "https://perms.example/";
    answer = gResponseFilter(policyPage, policyPage, policyPage, "document", "GET", nullptr, "[]");
    Require(answer && strstr(answer, "permissions-policy") && strstr(answer, "compute-pressure=()"),
            "a document gets its Permissions-Policy");
    free(answer);
    const char *stream = "https://stream.example/";
    answer = gResponseFilter(stream, stream, stream, "document", "GET", nullptr, "[[\"Set-Cookie\",\"a=b\"]]");
    Require(answer && strstr(answer, "\"remove\":[\"set-cookie\"]"), "a response header is removed");
    free(answer);
    const char *plain = "||ads.example^\n";
    gEngine = std::make_shared<Engine>(bay_blocker_new(&plain, nullptr, 1));
    PublishLive();
    Require(gResponseFilter == nullptr, "lists without response rules register none");
    puts("PASS: response rules block, add and remove headers, and plain exceptions lift them");

    // Body rules: $replace and HTML filtering, gated per response, and lifted on a paused site.
    Require(gBodyGate == nullptr && gHeaderNames == nullptr, "lists without body or header rules register neither");
    const char *bodies = "||body.example^$replace=/advert/article/g\n\
                          page.example##^script:has-text(tracker)\n\
                          ||headers.example/a.js$script,3p,requestheader=Cookie:*secret*\n\
                          ||tracker.example^\n@@||excepted.example^$cname\n";
    gEngine = std::make_shared<Engine>(bay_blocker_new(&bodies, nullptr, 1));
    PublishLive();
    Require(gBodyGate && gBodyFilter, "body rules register a filter");
    const char *bodyURL = "https://body.example/text";
    const char *top = "https://body.example/";
    Require(gBodyGate(bodyURL, top, top, "xmlhttprequest", "GET", 200, "text/plain", ""), "a matching response is wanted");
    Require(!gBodyGate(bodyURL, top, top, "xmlhttprequest", "GET", 200, "image/png", ""), "a binary one isn't");
    Require(!gBodyGate(bodyURL, top, top, "xmlhttprequest", "GET", 200, "text/plain", "attachment"), "nor a download");
    Require(!gBodyGate("https://other.example/", top, top, "xmlhttprequest", "GET", 200, "text/plain", ""),
            "nor one no rule matches");
    size_t length = 0;
    const char *text = "an advert, an advert";
    uint8_t *filtered = gBodyFilter(bodyURL, top, top, "xmlhttprequest", "GET", "text/plain", (const uint8_t *)text,
                                    strlen(text), &length);
    Require(filtered && std::string((char *)filtered, length) == "an article, an article", "$replace rewrites a body");
    free(filtered);
    Require(!gBodyFilter(bodyURL, top, top, "xmlhttprequest", "GET", "text/plain", (const uint8_t *)"clean", 5, &length) &&
                length == 0,
            "a body nothing matches is left alone");
    const char *pageURL = "https://page.example/";
    const char *html = "<!doctype html><html><head><script>tracker()</script><script>site()</script></head></html>";
    Require(gBodyGate(pageURL, pageURL, pageURL, "document", "GET", 200, "text/html; charset=utf-8", ""),
            "an HTML rule wants a document");
    filtered = gBodyFilter(pageURL, pageURL, pageURL, "document", "GET", "text/html; charset=utf-8", (const uint8_t *)html,
                           strlen(html), &length);
    const std::string document((char *)filtered, length);
    Require(document.find("tracker()") == std::string::npos && document.find("site()") != std::string::npos,
            "HTML filtering removes the element and keeps the rest");
    free(filtered);
    char *names = gHeaderNames("https://headers.example/a.js", "https://site.example/", "https://site.example/", "script", "GET");
    Require(names && !strcmp(names, "[\"cookie\"]"), "$requestheader asks for the header it reads");
    free(names);
    Require(!gHeaderNames("https://headers.example/b.js", "https://site.example/", "https://site.example/", "script", "GET"),
            "and for nothing on other requests");
    Require(gHeaderFilter("https://headers.example/a.js", "https://site.example/", "https://site.example/", "script", "GET",
                          "[[\"Cookie\",\"a=secret\"]]"),
            "a matching header blocks");
    Require(!gHeaderFilter("https://headers.example/a.js", "https://site.example/", "https://site.example/", "script", "GET",
                           "[[\"Cookie\",\"a=b\"]]"),
            "another doesn't");
    Require(gCnameFilter("https://metrics.site.example/a.js", "x.tracker.example", "https://site.example/",
                         "https://site.example/", "script", "GET"),
            "a CNAME of a blocked host blocks");
    Require(!gCnameFilter("https://metrics.excepted.example/a.js", "x.tracker.example", "https://excepted.example/",
                          "https://excepted.example/", "script", "GET"),
            "a $cname exception lifts that for its site");
    Require(!gCnameFilter("https://site.example/", "x.tracker.example", "https://site.example/", "https://site.example/",
                          "document", "GET"),
            "a main frame isn't uncloaked");
    [NNCoreContentBlocker setAllowed:YES onHost:@"body.example" completion:^(NSString *error) { Require(!error, "pause succeeds"); }];
    Require(!gBodyGate(bodyURL, top, top, "xmlhttprequest", "GET", 200, "text/plain", ""), "a paused site's bodies stay");
    [NNCoreContentBlocker setAllowed:NO onHost:@"body.example" completion:^(NSString *error) { Require(!error, "unpause succeeds"); }];
    gEngine = std::make_shared<Engine>(bay_blocker_new(&plain, nullptr, 1));
    PublishLive();
    Require(gBodyGate == nullptr && gHeaderNames == nullptr, "and they go with their rules");
    puts("PASS: body rules rewrite what they should, $requestheader reads headers and CNAMEs are uncloaked");


    // Visits to pages the lists block.
    const char *pages = "||visit.example^$doc\n||hostonly.example^$all\n";
    gEngine = std::make_shared<Engine>(bay_blocker_new(&pages, nullptr, 1));
    PublishLive();
    Require(nncore_host::ContentBlockerBlocksPage(@"https://visit.example/"), "a $doc rule stops a visit");
    Require(Filter("https://www.hostonly.example/", "https://www.hostonly.example/", "https://www.hostonly.example/", "document", "GET", nullptr, nullptr),
            "and a subdomain of a hostname's rule");
    [NNCoreContentBlocker setPageAllowed:YES onHost:@"visit.example" remember:NO completion:^(NSString *error) { Require(!error, "visit anyway succeeds"); }];
    Require(!nncore_host::ContentBlockerBlocksPage(@"https://www.visit.example/"), "Visit Anyway covers the site");
    Require(![ReadJSON(SettingsPath())[@"allowedPages"] containsObject:@"visit.example"], "Visit Anyway isn't saved");
    [NNCoreContentBlocker setPageAllowed:NO onHost:@"www.visit.example" remember:NO completion:^(NSString *error) { Require(!error, "ending it succeeds"); }];
    Require(nncore_host::ContentBlockerBlocksPage(@"https://visit.example/"), "blocking again ends what covers the host");
    [NNCoreContentBlocker setPageAllowed:YES onHost:@"visit.example" remember:YES completion:^(NSString *error) { Require(!error, "always allow succeeds"); }];
    Require([ReadJSON(SettingsPath())[@"allowedPages"] containsObject:@"visit.example"], "Always Allow is saved");
    Require(!nncore_host::ContentBlockerBlocksPage(@"https://visit.example/"), "and lifts the block");
    Require(!Filter("https://visit.example/a.js", "https://visit.example/", "https://visit.example/", "document", "GET", nullptr, nullptr), "for documents");
    puts("PASS: visits to blocked pages stop, and Visit Anyway and Always Allow lift only that");
  }
}
