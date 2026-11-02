// Per-tab state NNCore reports in the shapes packages/cefPatches's JS uses (packages/cefPatches/src/*.ts), so
// the RN module passes them through as they are.

#ifndef BAY_CORE_NN_TAB_INFO_H_
#define BAY_CORE_NN_TAB_INFO_H_

#import <Foundation/Foundation.h>

#include <string>

class GURL;

namespace content {
class WebContents;
}

namespace nncore {

// JS SecurityInfo (WebView.tsx), as packages/cefPatches/ios/NNSiteSettings.mm builds it.
NSDictionary* SecurityInfoFor(content::WebContents* contents);

// "scheme://host[:port]" for http(s) URLs, else nil (NNCef.mm OriginOf).
NSString* OriginOf(const GURL& url);

}  // namespace nncore

#endif  // BAY_CORE_NN_TAB_INFO_H_
