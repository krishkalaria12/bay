#import "MockControl.h"

static NSString *directory;
static BOOL capable;
static NSDictionary *reply;
static NSDictionary *arguments;
static BOOL referencePath;
static BOOL listFails;
static int calls;
static NSDictionary *event;
typedef void (^ImportExtensionsHandler)(NSString * _Nonnull, NSDictionary<NSString *, id> * _Nonnull);
static ImportExtensionsHandler extensionsHandler;

void ImportMockConfigure(NSString *dir, BOOL hasExport, NSDictionary *result, BOOL referenced, BOOL failedList) {
  directory = dir;
  capable = hasExport;
  reply = result;
  arguments = @{};
  referencePath = referenced;
  listFails = failedList;
  calls = 0;
  event = @{};
  extensionsHandler = ^(NSString *name, NSDictionary *payload) { event = @{@"name": name, @"payload": payload}; };
}
NSDictionary *ImportMockArgs(void) { return arguments; }
NSDictionary *ImportMockEvent(void) { return event; }
int ImportMockCalls(void) { return calls; }

@implementation NNCoreEngineBridge
+ (BOOL)exports:(NSString *)name { return capable && [name isEqualToString:@"nn_extensions_import"]; }
@end

@implementation NNCoreHost
+ (NSString *)dataDirectory { return directory; }
@end

@implementation NNCoreServices
+ (ImportExtensionsHandler _Nullable)extensionsHandler { return extensionsHandler; }
+ (void)setExtensionsHandler:(ImportExtensionsHandler _Nullable)handler { extensionsHandler = [handler copy]; }
+ (void)call:(NSString *)name profile:(NSString *)profile args:(NSDictionary *)args completion:(NNCoreResult)completion {
  NSCAssert([name isEqualToString:@"nn_extensions_import"], @"unexpected engine call");
  arguments = args;
  calls++;
  completion(reply);
}
+ (NSDictionary *)inspectUnpacked:(NSString *)path { return @{}; }
+ (void)listExtensions:(NSString *)profile completion:(NNCoreResult)completion {
  if (listFails) { completion(@{@"error": @"engine unavailable"}); return; }
  NSArray *extensions = referencePath && arguments[@"path"] ? @[@{@"path": arguments[@"path"]}] : @[];
  completion(@{@"extensions": extensions});
}
@end
