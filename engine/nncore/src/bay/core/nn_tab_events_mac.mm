// Copyright 2026 Bay. Apache-2.0.
#include "bay/core/nn_tab_events.h"

#import <Foundation/Foundation.h>

#include "base/strings/sys_string_conversions.h"
#include "bay/core/nn_browser.h"
#include "bay/core/nn_page_channel.h"
#import "bay/core/nncore_internal.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "components/tabs/public/tab_interface.h"
#include "ui/views/widget/widget.h"

namespace nncore {
void EnsureTabBridge(content::WebContents* contents) {
  TabBridge::GetOrCreate(contents);
}
void ReportTabWillClose(content::WebContents* contents) {
  if (auto* bridge = TabBridge::FromWebContents(contents))
    bridge->ReportWillClose();
}
void MarkTabClosedByHost(content::WebContents* contents) {
  if (auto* bridge = TabBridge::FromWebContents(contents))
    bridge->set_closed_by_host();
}
void ReportAppURLRequest(content::WebContents* contents,
                         const GURL& url,
                         bool user_gesture) {
  NNCoreTab* tab = TabBridge::GetOrCreate(contents)->tab();
  id<NNCoreTabDelegate> delegate = tab.delegate;
  if ([delegate respondsToSelector:@selector(tab:
                                       didRequestAppURL:userGesture:)]) {
    [delegate tab:tab
        didRequestAppURL:base::SysUTF8ToNSString(url.spec())
             userGesture:user_gesture];
  }
}

void DeliverPageMessage(content::WebContents* contents,
                        const std::string& kind,
                        const std::string& json,
                        const std::string& frame_id,
                        bool main_frame) {
  NNCoreTab* tab = TabBridge::GetOrCreate(contents)->tab();
  id<NNCoreTabDelegate> delegate = tab.delegate;
  NSString* ns_kind = base::SysUTF8ToNSString(kind);
  NSString* ns_json = base::SysUTF8ToNSString(json);
  if ([delegate respondsToSelector:@selector
                (tab:didReceivePageMessage:json:frame:main:)]) {
    [delegate tab:tab
        didReceivePageMessage:ns_kind
                         json:ns_json
                        frame:base::SysUTF8ToNSString(frame_id)
                         main:main_frame];
  } else if (main_frame && [delegate respondsToSelector:@selector
                                     (tab:didReceivePageMessage:json:)]) {
    [delegate tab:tab didReceivePageMessage:ns_kind json:ns_json];
  }
}
content::WebContents* ShownHostPageForProfile(Profile* profile) {
  content::WebContents* found = nullptr;
  ForEachCurrentBrowserWindowInterfaceOrderedByActivation(
      [&](BrowserWindowInterface* browser) {
        WindowHost* host = WindowHost::ForBrowser(browser);
        tabs::TabInterface* tab = browser->GetActiveTabInterface();
        if (browser->GetProfile() != profile || !host || host->internal() ||
            host->closing() || !host->widget() ||
            !host->widget()->IsVisible() ||
            !host->IsActiveBrowser(static_cast<Browser*>(browser)) || !tab) {
          return true;  // Continue iterating.
        }
        found = tab->GetContents();
        return false;
      });
  return found;
}

void LogNavigationHoldInfo(const std::string& message) {
  NSLog(@"%s", message.c_str());
}
}  // namespace nncore
