// The macOS engine bridge for the GPUI app (include/bay_engine_mac.h). Chromium starts through the app's host glue
// (packages/chromium/ios, NNCoreHost), so the GPUI app keeps the React Native app's data folder, keychain item,
// content blocker and page script. Windows and tabs are NNCore's own; the app places the page views itself.
//
// Input routing follows the reference port's hosted windows: GPUI draws in a window NNCore made, so that window's
// sendEvent:, keyDown:, makeFirstResponder: and performKeyEquivalent: ask GPUI first. The methods are replaced once
// per window class, and only windows routed with bay_engine_route_window go through the hooks.
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#import <pthread.h>

#import "NNCore.h"
#import "NNCoreHost.h"

#include <map>
#include <utility>

#include "bay_engine_mac.h"

// MARK: - Launch

@interface BayGpuiAppDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic) BayEngineLaunched launched;
@property(nonatomic) void *context;
@end

@implementation BayGpuiAppDelegate {
  BOOL _didLaunch;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  if (_didLaunch) return;
  _didLaunch = YES;
  [self installMenu];
  if (_launched) _launched(_context);
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)visible {
  return YES;
}

// The spike's menu: enough for ⌘Q and the editing keys a text field expects.
- (void)installMenu {
  NSMenu *bar = [[NSMenu alloc] init];
  NSMenuItem *appItem = [[NSMenuItem alloc] init];
  NSMenu *appMenu = [[NSMenu alloc] initWithTitle:@"Bay"];
  [appMenu addItemWithTitle:@"Quit Bay" action:@selector(terminate:) keyEquivalent:@"q"];
  appItem.submenu = appMenu;
  [bar addItem:appItem];
  NSMenuItem *editItem = [[NSMenuItem alloc] init];
  NSMenu *edit = [[NSMenu alloc] initWithTitle:@"Edit"];
  [edit addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
  [edit addItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"Z"];
  [edit addItem:NSMenuItem.separatorItem];
  [edit addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
  [edit addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
  [edit addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
  [edit addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
  editItem.submenu = edit;
  [bar addItem:editItem];
  NSApp.mainMenu = bar;
}

@end

extern "C" int bay_engine_run(int argc, char **argv, BayEngineLaunched launched, void *context) {
  return [NNCoreHost runWithArgc:argc
                            argv:argv
                        delegate:^id<NSApplicationDelegate> {
                          BayGpuiAppDelegate *delegate = [[BayGpuiAppDelegate alloc] init];
                          delegate.launched = launched;
                          delegate.context = context;
                          return delegate;
                        }];
}

// MARK: - Windows and tabs

namespace {

template <typename T>
T *Object(void *pointer) {
  return (__bridge T *)pointer;
}

void *Retained(id object) {
  return object ? (__bridge_retained void *)object : nullptr;
}

NSString *String(const char *text) {
  return text ? [NSString stringWithUTF8String:text] : @"";
}

}  // namespace

extern "C" void *bay_engine_window_open(double x, double y, double width, double height) {
  NNCoreWindow *window = [[NNCoreWindow alloc] initWithContentRect:NSMakeRect(x, y, width, height)];
  return Retained(window);
}

extern "C" void *bay_engine_window_ns_window(void *window) {
  return (__bridge void *)Object<NNCoreWindow>(window).window;
}

extern "C" void *bay_engine_window_host_view(void *window) {
  return (__bridge void *)Object<NNCoreWindow>(window).hostView;
}

extern "C" void bay_engine_window_show(void *window) {
  NSWindow *ns = Object<NNCoreWindow>(window).window;
  [ns makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
}

extern "C" void *bay_engine_window_open_tab(void *window, const char *url, bool foreground) {
  NNCoreEngine *engine = NNCoreEngine.sharedEngine;
  if (!engine) return nullptr;
  NNCoreTab *tab = [Object<NNCoreWindow>(window) openTab:String(url) profile:engine.defaultProfile foreground:foreground];
  return Retained(tab);
}

extern "C" void *bay_engine_tab_view(void *tab) {
  return (__bridge void *)Object<NNCoreTab>(tab).view;
}

extern "C" void bay_engine_tab_navigate(void *tab, const char *url) {
  [Object<NNCoreTab>(tab) loadURL:String(url) userInitiated:YES];
}

extern "C" void bay_engine_release(void *object) {
  if (object) CFRelease(object);
}

// MARK: - Hosted window input

namespace {

const void *const kRoutedKey = &kRoutedKey;
BayHostedHooks gHooks;

// The implementation a replaced method had, by class and selector: nil when the class only inherited it, so the
// superclass's current one runs.
std::map<std::pair<Class, SEL>, IMP> &Originals() {
  static std::map<std::pair<Class, SEL>, IMP> originals;
  return originals;
}

IMP Next(Class cls, SEL selector) {
  IMP original = Originals()[{cls, selector}];
  return original ?: class_getMethodImplementation(class_getSuperclass(cls), selector);
}

bool Routed(id window) {
  return pthread_main_np() != 0 && objc_getAssociatedObject(window, kRoutedKey) != nil;
}

struct VoidCall {
  IMP imp;
  __unsafe_unretained id target;
  SEL selector;
  __unsafe_unretained id argument;
  bool called;
};

struct BoolCall {
  IMP imp;
  __unsafe_unretained id target;
  SEL selector;
  __unsafe_unretained id argument;
  bool called;
  bool result;
};

void CallVoid(void *thunk) {
  VoidCall *call = static_cast<VoidCall *>(thunk);
  if (!call || call->called) return;
  call->called = true;
  reinterpret_cast<void (*)(id, SEL, id)>(call->imp)(call->target, call->selector, call->argument);
}

bool CallBool(void *thunk) {
  BoolCall *call = static_cast<BoolCall *>(thunk);
  if (!call) return false;
  if (!call->called) {
    call->called = true;
    call->result = reinterpret_cast<BOOL (*)(id, SEL, id)>(call->imp)(call->target, call->selector, call->argument);
  }
  return call->result;
}

using VoidHook = void (*)(void *, void *, BayVoidSuper, void *);
using BoolHook = bool (*)(void *, void *, BayBoolSuper, void *);

IMP VoidImp(Class cls, SEL selector, VoidHook BayHostedHooks::*slot) {
  return imp_implementationWithBlock(^(NSWindow *window, NSEvent *event) {
    IMP next = Next(cls, selector);
    VoidHook hook = event && Routed(window) ? gHooks.*slot : nullptr;
    if (!hook) return reinterpret_cast<void (*)(id, SEL, id)>(next)(window, selector, event);
    VoidCall call{next, window, selector, event, false};
    hook((__bridge void *)window, (__bridge void *)event, CallVoid, &call);
  });
}

IMP BoolImp(Class cls, SEL selector, BoolHook BayHostedHooks::*slot) {
  return imp_implementationWithBlock(^BOOL(NSWindow *window, id argument) {
    IMP next = Next(cls, selector);
    BoolHook hook = Routed(window) ? gHooks.*slot : nullptr;
    if (!hook) return reinterpret_cast<BOOL (*)(id, SEL, id)>(next)(window, selector, argument);
    BoolCall call{next, window, selector, argument, false, false};
    return hook((__bridge void *)window, (__bridge void *)argument, CallBool, &call) ? YES : NO;
  });
}

bool OwnsMethod(Class cls, SEL selector) {
  unsigned count = 0;
  Method *methods = class_copyMethodList(cls, &count);
  bool owns = false;
  for (unsigned i = 0; i < count && !owns; i++) owns = method_getName(methods[i]) == selector;
  free(methods);
  return owns;
}

bool Replace(Class cls, SEL selector, IMP replacement) {
  Method inherited = class_getInstanceMethod(cls, selector);
  if (!inherited) return false;
  if (OwnsMethod(cls, selector)) {
    Originals()[{cls, selector}] = method_setImplementation(inherited, replacement);
    return true;
  }
  Originals()[{cls, selector}] = nil;
  return class_addMethod(cls, selector, replacement, method_getTypeEncoding(inherited));
}

bool Install(Class cls) {
  static NSMutableSet<Class> *installed = [NSMutableSet set];
  if ([installed containsObject:cls]) return true;
  bool ok = Replace(cls, @selector(sendEvent:), VoidImp(cls, @selector(sendEvent:), &BayHostedHooks::send_event)) &&
            Replace(cls, @selector(keyDown:), VoidImp(cls, @selector(keyDown:), &BayHostedHooks::key_down)) &&
            Replace(cls, @selector(makeFirstResponder:),
                    BoolImp(cls, @selector(makeFirstResponder:), &BayHostedHooks::make_first_responder)) &&
            Replace(cls, @selector(performKeyEquivalent:),
                    BoolImp(cls, @selector(performKeyEquivalent:), &BayHostedHooks::perform_key_equivalent));
  if (ok) [installed addObject:cls];
  return ok;
}

}  // namespace

extern "C" bool bay_engine_route_window(void *ns_window, const BayHostedHooks *hooks) {
  NSWindow *window = Object<NSWindow>(ns_window);
  if (!window || !hooks || pthread_main_np() == 0) return false;
  gHooks = *hooks;
  if (!Install(window.class)) return false;
  objc_setAssociatedObject(window, kRoutedKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  return true;
}
