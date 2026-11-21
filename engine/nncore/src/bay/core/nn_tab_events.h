// Copyright 2026 Bay. Apache-2.0.
// Host notification adapters. Portable engine code never imports NNCore.h or
// mentions Objective-C delegates. The macOS adapter preserves that API.
#ifndef BAY_CORE_NN_TAB_EVENTS_H_
#define BAY_CORE_NN_TAB_EVENTS_H_

#include <string>

class GURL;
class Profile;
namespace content {
class WebContents;
}

namespace nncore {
void EnsureTabBridge(content::WebContents* contents);
void ReportTabWillClose(content::WebContents* contents);
void MarkTabClosedByHost(content::WebContents* contents);
void ReportAppURLRequest(content::WebContents* contents,
                         const GURL& url,
                         bool user_gesture);
void DeliverPageMessage(content::WebContents* contents,
                        const std::string& kind,
                        const std::string& json,
                        const std::string& frame_id,
                        bool main_frame);
content::WebContents* ShownHostPageForProfile(Profile* profile);
void LogNavigationHoldInfo(const std::string& message);
}  // namespace nncore
#endif
