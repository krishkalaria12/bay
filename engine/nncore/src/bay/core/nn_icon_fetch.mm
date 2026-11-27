// -[NNCoreProfile fetchIcon:maxBytes:completion:]: an icon the host wants without a tab (a
// restored or unloaded tab's, a bookmark's, a history row's), downloaded as Windows and Linux do
// (nn_icon_download): the profile's own network stack, no cookies or credentials, a 200 only, a
// size cap and a time-out. Only what Chrome would decode as a favicon comes back.

#import "bay/core/public/NNCore.h"

#include <algorithm>
#include <optional>
#include <string>

#include "base/functional/bind.h"
#include "base/strings/sys_string_conversions.h"
#include "chrome/browser/profiles/profile.h"
#include "bay/core/nn_icon_download.h"
#include "bay/core/nncore_internal.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "url/gurl.h"

@implementation NNCoreProfile (Icons)

- (void)fetchIcon:(NSString*)url
         maxBytes:(NSUInteger)maxBytes
       completion:(void (^)(NSData* _Nullable body))completion {
  const GURL target(base::SysNSStringToUTF8(url ?: @""));
  Profile* profile = self.chromeProfile;
  if (!profile || nncore::IsProfileDying(profile) ||
      !target.SchemeIsHTTPOrHTTPS() || maxBytes == 0) {
    dispatch_async(dispatch_get_main_queue(), ^{
      completion(nil);
    });
    return;
  }
  // The shared download (nn_icon_download, as Windows and Linux); the host decodes the bytes.
  nncore::DownloadIcon(profile, target, maxBytes,
                       base::BindOnce(^(std::optional<std::string> body) {
                         NSData* data = body ? [NSData dataWithBytes:body->data() length:body->size()] : nil;
                         dispatch_async(dispatch_get_main_queue(), ^{
                           completion(data);
                         });
                       }));
}

@end
