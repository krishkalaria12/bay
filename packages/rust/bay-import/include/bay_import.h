// Bay's browser import readers on the desktops (packages/rust/bay-import/src/ffi.rs), linked through bay-desktop.
//
// bay_import_read takes a JSON request naming a reader and answers {"value": ...} or {"error": {"code", "message"}}:
//   {"reader": "passwordsCsv", "text": "..."}                  a password CSV export, as credentials
//   {"reader": "netscapeBookmarks", "text": "..."}             a bookmarks HTML export, as a bookmark tree
//   {"reader": "chromiumBookmarks", "profile": "..."}          a Chromium profile's bookmarks
//   {"reader": "firefoxBookmarks", "profile": "..."}           a Firefox profile's bookmarks
//   {"reader": "history", "profile": "...", "firefox": bool, "limit": n, "since": ms, "chunkSize": n, "stream": bool}
//                                                              {"entries": [...], "count": n}; events go to the observer
//   {"reader": "chromiumTabs" | "firefoxTabs", "profile": "..."}  {"tabs": [...], "groups": [...]}
//   {"reader": "zenSpaces", "profile": "...", "profileId": "..."}
//   {"reader": "arcSidebar", "file": ".../StorableSidebar.json"}
//   {"reader": "extensions", "profile": "..."}

#ifndef BAY_IMPORT_H_
#define BAY_IMPORT_H_

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// Hears a reader's events as JSON, on the reading thread.
typedef void (*BayImportObserver)(void *context, const char *event);

// `cancelled` is the host's stop flag (a C++ std::atomic_bool) or null; `observer` may be null. Free the answer with
// bay_import_string_free.
char *bay_import_read(const char *request, const bool *cancelled, BayImportObserver observer, void *context);
void bay_import_string_free(char *text);

#ifdef __cplusplus
}
#endif

#endif  // BAY_IMPORT_H_
