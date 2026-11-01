// Bay's Rust content blocker (packages/adblock/src/ffi.rs). Returned strings belong to the library: release them
// with bay_string_free, and serialized bytes with bay_bytes_free.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

char *bay_content_blocking_rules(const char *lists);
bool bay_tracking_set(const char *json);
char *bay_tracking_clean(const char *url);
void bay_string_free(char *text);

// A network and cosmetic filter engine (desktop). Thread-safe: every call below may run on any thread at once, except
// bay_blocker_free, which must come after the last.
typedef struct BayBlocker BayBlocker;

// From `count` filter lists: lists[i] is a list's text, hosts[i] true for a hosts file (hosts may be NULL). Never NULL.
BayBlocker *bay_blocker_new(const char *const *lists, const bool *hosts, size_t count);
// From bay_blocker_serialize's bytes; NULL when they're damaged or from another adblock-rust.
BayBlocker *bay_blocker_deserialize(const uint8_t *data, size_t length);
uint8_t *bay_blocker_serialize(const BayBlocker *blocker, size_t *length);
void bay_bytes_free(uint8_t *data, size_t length);
void bay_blocker_free(BayBlocker *blocker);
// source_url: the document's (or worker's) URL or origin. type: script, image, stylesheet, font, media, subdocument,
// xmlhttprequest, ping, websocket, object, other.
bool bay_blocker_should_block(const BayBlocker *blocker, const char *url, const char *source_url, const char *type);
// {"hide": [selector], "exceptions": [selector], "generichide": bool, "script": scriptlet code}
char *bay_blocker_cosmetic(const BayBlocker *blocker, const char *url);
// query {"classes": [name], "ids": [name], "exceptions": [selector]} → [selector]
char *bay_blocker_hidden_selectors(const BayBlocker *blocker, const char *query);
// [{"networkFilters": n, "cosmeticFilters": n}] in bay_blocker_new's list order
char *bay_blocker_list_counts(const BayBlocker *blocker);
// adblock-rust Resource JSON array (redirects, scriptlets); false when unreadable
bool bay_blocker_use_resources(const BayBlocker *blocker, const char *json);

// Mobile: the engine cached at `cache` for `version`, or built from `count` list files and cached, with the resources
// file (may be NULL) loaded. platform: 0 desktop, 1 Android, 2 iOS. NULL when the lists can't be read.
BayBlocker *bay_blocker_load(const char *const *files, size_t count, const char *cache, const char *version,
                             const char *resources, uint8_t platform);
// The page's scriptlets as one script for its main world at document start ("" when none).
char *bay_blocker_scriptlets(const BayBlocker *blocker, const char *url);

#ifdef __cplusplus
}
#endif
