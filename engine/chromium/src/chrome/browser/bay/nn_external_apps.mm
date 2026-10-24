// Copyright 2026 Bay. Apache-2.0.

#include "chrome/browser/bay/nn_external_apps.h"

#import <AppKit/AppKit.h>

#include <string>
#include <utility>

#include "base/strings/sys_string_conversions.h"

namespace bay {

// As NNExternalApps.mm: the bundle's display name, else its file name.
NSString* AppName(NSURL* app) {
  NSBundle* bundle = [NSBundle bundleWithURL:app];
  for (NSString* key in @[ @"CFBundleDisplayName", @"CFBundleName" ]) {
    NSString* name = bundle.localizedInfoDictionary[key]
                         ?: bundle.infoDictionary[key];
    if ([name isKindOfClass:NSString.class] && name.length) {
      return name;
    }
  }
  return app.lastPathComponent.stringByDeletingPathExtension;
}

NSString* IconDataURI(NSURL* app, int pixels) {
  NSImage* icon = [NSWorkspace.sharedWorkspace iconForFile:app.path];
  NSBitmapImageRep* rep = [[NSBitmapImageRep alloc]
      initWithBitmapDataPlanes:nil
                    pixelsWide:pixels
                    pixelsHigh:pixels
                 bitsPerSample:8
               samplesPerPixel:4
                      hasAlpha:YES
                      isPlanar:NO
                colorSpaceName:NSDeviceRGBColorSpace
                   bytesPerRow:0
                  bitsPerPixel:0];
  if (!icon || !rep) {
    return nil;
  }
  [NSGraphicsContext saveGraphicsState];
  NSGraphicsContext.currentContext =
      [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
  [icon drawInRect:NSMakeRect(0, 0, pixels, pixels)
          fromRect:NSZeroRect
         operation:NSCompositingOperationCopy
          fraction:1];
  [NSGraphicsContext restoreGraphicsState];
  NSData* png = [rep representationUsingType:NSBitmapImageFileTypePNG
                                  properties:@{}];
  return png ? [@"data:image/png;base64,"
                   stringByAppendingString:[png base64EncodedStringWithOptions:0]]
             : nil;
}

base::DictValue AppForScheme(const std::string& scheme) {
  NSURL* probe = [NSURL
      URLWithString:[base::SysUTF8ToNSString(scheme) stringByAppendingString:@":"]];
  NSURL* app =
      probe ? [NSWorkspace.sharedWorkspace URLForApplicationToOpenURL:probe]
            : nil;
  NSString* icon = app ? IconDataURI(app, 64) : nil;
  return base::DictValue()
      .Set("app", app ? base::Value(base::SysNSStringToUTF8(AppName(app)))
                      : base::Value())
      .Set("icon", icon ? base::Value(base::SysNSStringToUTF8(icon))
                        : base::Value());
}

}  // namespace bay
