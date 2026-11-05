// Hermes' sampling profiler for the JS benchmark (apps/browser/scripts/perf/js-bench.mjs --cpuprofile 1): samples the
// JS thread's stack and writes a Chrome trace (Chrome DevTools' Performance panel, Perfetto and speedscope open it).
// Only an isolated instance (BAY_DATA_DIR) has it, and it writes only into that data folder. BAY_JS_PROFILE=1 starts
// it as the app loads, so the first profile covers the bundle's evaluation and the first render.
#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#include <hermes/hermes.h>
#include <atomic>

using facebook::hermes::IHermesRootAPI;

static IHermesRootAPI *RootAPI() {
  return facebook::jsi::castInterface<IHermesRootAPI>(facebook::hermes::makeHermesRootAPI());
}

static NSString *DataDir() {
  NSString *dir = NSProcessInfo.processInfo.environment[@"BAY_DATA_DIR"];
  return dir.length ? dir.stringByStandardizingPath : nil;
}

static std::atomic<bool> sampling{false};

static BOOL StartSampling(double hz) {
  IHermesRootAPI *api = RootAPI();
  if (!api || !DataDir()) return NO;
  if (!sampling.exchange(true)) api->enableSamplingProfiler(hz > 0 ? hz : 1000);
  return YES;
}

// As the app loads (RCT_EXPORT_MODULE takes +load), before the bundle runs.
__attribute__((constructor)) static void StartAtLaunch() {
  if ([NSProcessInfo.processInfo.environment[@"BAY_JS_PROFILE"] isEqualToString:@"1"]) StartSampling(1000);
}

@interface NNHermesProfiler : NSObject <RCTBridgeModule>
@end

@implementation NNHermesProfiler

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

/** Samples the JS stack `hz` times a second until `stop`. NO outside an isolated instance. */
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(start : (double)hz) {
  return @(StartSampling(hz));
}

/** Writes what was sampled since `start` to `name` (a file name) in the data folder and stops; its path, or null. */
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(stop : (NSString *)name) {
  NSString *dir = DataDir();
  IHermesRootAPI *api = RootAPI();
  if (!dir || !api || !sampling.exchange(false)) return [NSNull null];
  NSString *file = name.lastPathComponent;
  if (!file.length || [file hasPrefix:@"."]) file = @"profile.trace.json";
  NSString *path = [dir stringByAppendingPathComponent:file];
  api->dumpSampledTraceToFile(path.UTF8String);
  api->disableSamplingProfiler();
  return path;
}

@end
