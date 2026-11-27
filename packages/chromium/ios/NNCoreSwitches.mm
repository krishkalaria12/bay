// Remote kill switches: Bay's signed feed, checked and matched to this release by bay-switches
// (packages/rust/bay-switches), which Windows and Linux share (webui/switches.cc). The app fetches the feed and keeps
// the last one it accepted (apps/browser/src/lib/killSwitches.ts); this only answers what applies.

#import "NNCoreServices.h"

#include "bay_switches.h"

@implementation NNCoreSwitches

+ (NSString *)check:(NSString *)feed
          signature:(NSString *)signature
            version:(NSString *)version
                now:(int64_t)now
         lastIssued:(int64_t)lastIssued {
  char *result = bay_switches_check(feed.UTF8String, signature.UTF8String, "macos", version.UTF8String, now, lastIssued);
  NSString *text = result ? @(result) : @"{\"ok\":false,\"error\":\"format\"}";
  bay_switches_string_free(result);
  return text;
}

@end
