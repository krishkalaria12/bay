// The macOS host's side of the shared external app requests (nn_external_app_requests.cc):
// the scheme's handler from Launch Services, with its icon, and the test runs' launches.

#include "bay/core/nn_external_apps.h"

#import <AppKit/AppKit.h>

#include <optional>
#include <string>

#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/task/single_thread_task_runner.h"
#include "base/strings/sys_string_conversions.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/common/pref_names.h"
#include "components/prefs/pref_service.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "content/public/browser/weak_document_ptr.h"
#include "content/public/browser/web_contents.h"
#include "bay/core/nn_browser.h"
#include "bay/core/nn_external_app_requests.h"
#include "bay/core/nn_mac_values.h"
#import "bay/core/nncore_internal.h"
#include "url/gurl.h"
#include "url/origin.h"

// The hook in Chrome's external_protocol_dialog.cc (engine/nncore/apply.sh).
extern bool (*g_bay_external_protocol_dialog)(
    const GURL& url,
    content::WebContents* web_contents,
    const std::optional<url::Origin>& initiating_origin,
    content::WeakDocumentPtr initiator_document,
    const std::u16string& program_name);

namespace nncore {

namespace {

namespace external_apps = nncore::external_apps;

NSString* IconDataURI(NSURL* app, CGFloat size) {
  NSImage* icon = [NSWorkspace.sharedWorkspace iconForFile:app.path];
  if (!icon) {
    return nil;
  }
  NSBitmapImageRep* rep = [[NSBitmapImageRep alloc]
      initWithBitmapDataPlanes:nullptr
                    pixelsWide:size * 2
                    pixelsHigh:size * 2
                 bitsPerSample:8
               samplesPerPixel:4
                      hasAlpha:YES
                      isPlanar:NO
                colorSpaceName:NSDeviceRGBColorSpace
                   bytesPerRow:0
                  bitsPerPixel:0];
  [NSGraphicsContext saveGraphicsState];
  NSGraphicsContext.currentContext =
      [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
  [icon drawInRect:NSMakeRect(0, 0, size * 2, size * 2)];
  [NSGraphicsContext restoreGraphicsState];
  NSData* png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  return png ? [@"data:image/png;base64," stringByAppendingString:
                   [png base64EncodedStringWithOptions:0]]
             : nil;
}

bool AskHost(const GURL& url,
             content::WebContents* contents,
             const std::optional<url::Origin>& initiating_origin,
             content::WeakDocumentPtr initiator_document,
             const std::u16string& program_name) {
  BrowserWindowInterface* browser =
      GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(contents);
  if (!browser || !WindowHost::ForBrowser(browser)) {
    return false;  // Chrome's own windows keep Chrome's dialog.
  }
  NNCoreTab* tab = TabBridge::GetOrCreate(contents)->tab();
  id<NNCoreTabDelegate> delegate = tab.delegate;
  if (![delegate respondsToSelector:@selector(tab:externalAppRequest:)]) {
    return false;
  }
  NSURL* ns_url = [NSURL URLWithString:base::SysUTF8ToNSString(url.spec())];
  NSURL* app = ns_url ? [NSWorkspace.sharedWorkspace URLForApplicationToOpenURL:ns_url]
                      : nil;
  NSString* name =
      app ? [NSFileManager.defaultManager displayNameAtPath:app.path]
                .stringByDeletingPathExtension
          : nil;
  if (!name.length && !program_name.empty()) {
    name = base::SysUTF16ToNSString(program_name);
  }
  const bool has_origin = initiating_origin && !initiating_origin->opaque();
  const std::string app_name = base::SysNSStringToUTF8(app ? name : @"");
  const bool can_remember =
      external_apps::CanRemember(contents, initiating_origin, !app_name.empty());
  const std::string request_id = external_apps::NextRequestId();
  if (!app_name.empty()) {
    external_apps::Keep(request_id, url, contents, initiating_origin, initiator_document,
                        can_remember);
  }
  NSString* icon = app_name.empty() ? nil : IconDataURI(app, 64);
  NSDictionary* request = NSDictionaryFrom(external_apps::Describe(
      request_id, url.spec(), std::string(url.scheme()),
      has_origin ? std::make_optional(initiating_origin->Serialize()) : std::nullopt,
      app_name,
      app_name.empty() ? std::nullopt : std::make_optional(base::SysNSStringToUTF8(app.path)),
      icon ? base::Value(base::SysNSStringToUTF8(icon)) : base::Value(), can_remember,
      "Your Mac"));
  // On the next turn: the host may answer (and launch) at once.
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](base::WeakPtr<content::WebContents> contents,
                        NSDictionary* request) {
                       if (!contents) {
                         return;
                       }
                       NNCoreTab* tab = TabBridge::GetOrCreate(contents.get())->tab();
                       id<NNCoreTabDelegate> delegate = tab.delegate;
                       if ([delegate respondsToSelector:@selector(tab:externalAppRequest:)]) {
                         [delegate tab:tab externalAppRequest:request];
                       }
                     },
                     contents->GetWeakPtr(), request));
  return true;
}

}  // namespace

namespace {

constexpr char kTestNoLaunchSwitch[] = "bay-test-external-protocol-no-launch";

NSMutableArray<NSDictionary*>* TestLaunches() {
  static NSMutableArray<NSDictionary*>* launches = [NSMutableArray array];
  return launches;
}

}  // namespace

void InstallExternalAppPrompts() {
  g_bay_external_protocol_dialog = &AskHost;
}

void ResolveExternalApp(const std::string& request_id, bool open, bool remember) {
  std::optional<external_apps::Approval> approval =
      external_apps::Resolve(request_id, open, remember);
  if (!approval) {
    return;
  }
  if (base::CommandLine::ForCurrentProcess()->HasSwitch(kTestNoLaunchSwitch)) {
    // Test runs: recorded, with what Chrome now remembers for the origin, not launched.
    // (Chrome's own prefs, not GetBlockState, which answers BLOCK for a while after any
    // request: its flood guard.)
    Profile* profile =
        Profile::FromBrowserContext(approval->contents->GetBrowserContext());
    const base::DictValue* allowed =
        approval->origin ? profile->GetPrefs()
                               ->GetDict(prefs::kProtocolHandlerPerOriginAllowedProtocols)
                               .FindDict(approval->origin->Serialize())
                         : nullptr;
    const bool remembered =
        allowed && allowed->FindBool(std::string(approval->url.scheme())).value_or(false);
    [TestLaunches() addObject:@{
      @"url" : base::SysUTF8ToNSString(approval->url.spec()),
      @"remembered" : @(remembered),
    }];
    return;
  }
  external_apps::Launch(*approval);
}

NSArray<NSDictionary*>* TestExternalLaunches() {
  return [TestLaunches() copy];
}

bool TestNoLaunch() {
  return base::CommandLine::ForCurrentProcess()->HasSwitch(kTestNoLaunchSwitch);
}

void RecordTestLaunch(NSDictionary* launch) {
  [TestLaunches() addObject:launch];
}

}  // namespace nncore
