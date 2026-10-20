// Copyright 2026 Bay. Apache-2.0.
// A test-only mailbox into the real engine. Loaded into a disposable app copy,
// following apps/browser/scripts/perf/nnmark.m's established injection pattern.
#import <AppKit/AppKit.h>
#import <dlfcn.h>
#import "../../../nncore/src/bay/core/public/NNCore.h"
#import "chrome/browser/bay/public/nn_engine.h"

static NSString *gDirectory;
static NSString *gLastRequest;
static NSMutableDictionary<NSString *, NNCoreProfile *> *gProfiles;
static NNCoreWindow *gWindow;
static BOOL gBusy;

static void Answer(NSString *requestID, NSDictionary *result) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"id": requestID, @"result": result}
                                               options:0 error:nil];
  [json writeToFile:[gDirectory stringByAppendingPathComponent:@"reply.json"] atomically:YES];
  gBusy = NO;
}

static void EngineReply(void *context, const char *json) {
  void (^completion)(NSDictionary *) = (__bridge_transfer id)context;
  NSData *data = json ? [NSData dataWithBytes:json length:strlen(json)] : nil;
  id result = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  completion([result isKindOfClass:NSDictionary.class] ? result : @{@"error": @"Invalid engine reply"});
}

static void Poll(void) {
  if (!gBusy) {
    NSData *data = [NSData dataWithContentsOfFile:[gDirectory stringByAppendingPathComponent:@"request.json"]];
    NSDictionary *request = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    NSString *requestID = request[@"id"];
    Class engineClass = NSClassFromString(@"NNCoreEngine");
    NNCoreEngine *engine = engineClass ? [engineClass sharedEngine] : nil;
    if (requestID && ![requestID isEqualToString:gLastRequest] && engine.defaultProfile) {
      gLastRequest = requestID;
      gBusy = YES;
      NSString *method = request[@"method"];
      NSDictionary *args = request[@"args"] ?: @{};
      if ([method isEqualToString:@"profile"]) {
        NSString *name = args[@"name"];
        if (!name.length || [name containsString:@"/"]) {
          Answer(requestID, @{@"error": @"Invalid test profile name"});
        } else {
          [engine loadProfile:name completion:^(NNCoreProfile *profile) {
            if (!profile) return Answer(requestID, @{@"error": @"Could not load test profile"});
            gProfiles[name] = profile;
            Answer(requestID, @{@"path": profile.path});
          }];
        }
      } else {
        NNCoreProfile *profile = gProfiles[args[@"profile"]];
        if (!profile) {
          Answer(requestID, @{@"error": @"Load the test profile first"});
        } else if ([method isEqualToString:@"open"]) {
          if (!gWindow) {
            Class windowClass = NSClassFromString(@"NNCoreWindow");
            gWindow = [[windowClass alloc] initWithContentRect:NSMakeRect(0, 0, 600, 400)];
          }
          NNCoreTab *tab = [gWindow openTab:args[@"url"] profile:profile foreground:NO];
          Answer(requestID, @{@"tabId": @(tab.tabId)});
        } else if ([method isEqualToString:@"call"]) {
          NSString *symbol = args[@"symbol"];
          NSArray *allowed = @[@"nn_extensions_install", @"nn_extensions_import", @"nn_extensions_list",
                               @"nn_extensions_set_enabled", @"nn_extensions_configure"];
          nn_engine_call_t call = [allowed containsObject:symbol] ? dlsym(RTLD_DEFAULT, symbol.UTF8String) : NULL;
          if (!call) {
            Answer(requestID, @{@"error": @"Engine symbol unavailable; rebuild and embed the framework"});
          } else {
            NSData *json = [NSJSONSerialization dataWithJSONObject:args[@"params"] ?: @{} options:0 error:nil];
            NSString *text = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
            void (^completion)(NSDictionary *) = ^(NSDictionary *result) { Answer(requestID, result); };
            call(profile.path.UTF8String, text.UTF8String, EngineReply, (__bridge_retained void *)completion);
          }
        } else {
          Answer(requestID, @{@"error": @"Unknown test command"});
        }
      }
    }
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ Poll(); });
}

__attribute__((constructor)) static void Start(void) {
  const char *directory = getenv("BAY_EXTENSION_IMPORT_PROBE");
  if (!directory || ![NSBundle.mainBundle.bundlePath hasSuffix:@".app"] ||
      [NSBundle.mainBundle.bundlePath containsString:@"Helper"]) return;
  gDirectory = @(directory);
  gProfiles = [NSMutableDictionary dictionary];
  dispatch_async(dispatch_get_main_queue(), ^{ Poll(); });
}
