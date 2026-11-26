// Plugins: the plugins folder and the files a plugin's sandbox may read, by bay-plugins (packages/rust/bay-plugins),
// which Windows and Linux share (engine webui/plugins.cc). PluginsModule.swift runs the sandboxes.

#import "NNCoreServices.h"

#include "bay_plugins.h"

static NSString *Take(char *text, NSString *fallback) {
  NSString *out = text ? @(text) : fallback;
  bay_plugins_string_free(text);
  return out ?: fallback;
}

@implementation NNCorePlugins

+ (NSString *)listIn:(NSString *)root {
  return Take(bay_plugins_list(root.fileSystemRepresentation), @"{\"plugins\":[],\"problems\":[]}");
}

+ (NSString *)install:(NSString *)source into:(NSString *)root {
  return Take(bay_plugins_install(root.fileSystemRepresentation, source.fileSystemRepresentation),
              @"{\"ok\":false,\"error\":\"Bay couldn't add the plugin\"}");
}

+ (BOOL)remove:(NSString *)pluginId from:(NSString *)root {
  return bay_plugins_remove(root.fileSystemRepresentation, pluginId.UTF8String);
}

+ (NSDictionary<NSString *, id> *)file:(NSString *)path ofPlugin:(NSString *)pluginId in:(NSString *)root {
  BayPluginFile *file = bay_plugins_file(root.fileSystemRepresentation, pluginId.UTF8String, path.UTF8String);
  if (!file) return nil;
  NSData *data = [NSData dataWithBytes:file->data length:file->len];
  NSString *mime = @(file->mime);
  bay_plugins_file_free(file);
  return @{@"data" : data, @"mime" : mime};
}

+ (NSString *)contentSecurityPolicy {
  return @(bay_plugins_csp());
}

@end
