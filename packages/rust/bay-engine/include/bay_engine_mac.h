// The macOS engine bridge (src/macos/bridge.mm): NNCore started through the app's host glue, its windows and tabs as
// opaque retained pointers, and the hooks that route a window's events to GPUI before the page. Main thread only.
#ifndef BAY_ENGINE_MAC_H_
#define BAY_ENGINE_MAC_H_

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*BayEngineLaunched)(void *context);

// Runs Chromium on the calling thread (the process's main thread) and returns its exit code when the app quits.
// `launched` runs once, inside Chromium's loop, when the engine is up and the app can make windows.
int bay_engine_run(int argc, char **argv, BayEngineLaunched launched, void *context);

// An NNCoreWindow: its AppKit window and the host's root view in it. Release with bay_engine_release.
void *bay_engine_window_open(double x, double y, double width, double height);
void *bay_engine_window_ns_window(void *window);
void *bay_engine_window_host_view(void *window);
void bay_engine_window_show(void *window);

// A tab of the default profile in `window`; its page view is bay_engine_tab_view's. Release with bay_engine_release.
void *bay_engine_window_open_tab(void *window, const char *url, bool foreground);
void *bay_engine_tab_view(void *tab);
void bay_engine_tab_navigate(void *tab, const char *url);

void bay_engine_release(void *object);

// Input routing for windows GPUI hosts. Each hook gets the window and the event (or responder), and a call_super that
// runs the window's own handling once; a hook that never calls it consumes the event.
typedef void (*BayVoidSuper)(void *thunk);
typedef bool (*BayBoolSuper)(void *thunk);
typedef struct BayHostedHooks {
  void (*send_event)(void *window, void *event, BayVoidSuper call_super, void *thunk);
  void (*key_down)(void *window, void *event, BayVoidSuper call_super, void *thunk);
  bool (*make_first_responder)(void *window, void *responder, BayBoolSuper call_super, void *thunk);
  bool (*perform_key_equivalent)(void *window, void *event, BayBoolSuper call_super, void *thunk);
} BayHostedHooks;

// Installs the hooks on `ns_window`'s class (once per class) and routes this window through them.
bool bay_engine_route_window(void *ns_window, const BayHostedHooks *hooks);

#ifdef __cplusplus
}
#endif

#endif  // BAY_ENGINE_MAC_H_
