#include "bay/core/nn_tab_info.h"


#include "base/strings/sys_string_conversions.h"
#include "bay/core/nn_mac_values.h"
#include "bay/core/nn_page_security.h"
#include "url/gurl.h"

namespace nncore {

namespace {

NSString* NS(const std::string& s) {
  return base::SysUTF8ToNSString(s);
}

}  // namespace

NSString* OriginOf(const GURL& url) {
  if (!url.SchemeIsHTTPOrHTTPS() || url.host().empty()) {
    return nil;
  }
  std::string origin = std::string(url.scheme()) + "://" + std::string(url.host());
  if (url.has_port()) {
    origin += ":" + std::string(url.port());
  }
  return NS(origin);
}

// The shared page security (nn_page_security.cc), as the host's dictionary.
NSDictionary* SecurityInfoFor(content::WebContents* contents) {
  return NSDictionaryFrom(PageSecurityInfo(contents));
}

}  // namespace nncore
