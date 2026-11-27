// The content blocker's filter lists on the desktops (packages/rust/bay-lists/src/ffi.rs), linked through
// bay-desktop. Returned strings belong to the library: release them with bay_string_free (bay_adblock.h). JSON goes
// in and out as text.
//
// A BayLists holds the catalogue and settings behind a lock, so any thread may call it; only bay_lists_open and
// bay_lists_save touch the disk. The functions taking a directory work on the list files and block on the disk.

#ifndef BAY_LISTS_H_
#define BAY_LISTS_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "bay_adblock.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct BayLists BayLists;
typedef struct BayListsBuilt BayListsBuilt;

// Opens the settings in `directory` (<data>/Content Blocker) with the catalogue file `catalogue`
// (filter_lists.json, may be null); `languages` is a JSON array of the person's languages, or null. Null only when
// `directory` is. Free with bay_lists_free.
BayLists *bay_lists_open(const char *directory, const char *catalogue, const char *languages);
void bay_lists_free(BayLists *lists);

// How many lists the catalogue has (0 when filter_lists.json was missing or unreadable).
size_t bay_lists_catalogue_size(const BayLists *lists);
bool bay_lists_known(const BayLists *lists, const char *id);
// The chosen lists in catalogue order, for bay_lists_build: [{"id": "...", "hosts": bool}].
char *bay_lists_selected(const BayLists *lists);
// Their ids, a JSON array, for bay_lists_seed, bay_lists_absent and bay_lists_due.
char *bay_lists_selected_ids(const BayLists *lists);
// The URLs to download list `id` from, first choice first (a JSON array); null for a list the catalogue lacks.
char *bay_lists_urls(const BayLists *lists, const char *id);
// What the request filter needs: {"enabled": bool, "allowed": [hosts], "pages": [hosts]}.
char *bay_lists_live(const BayLists *lists);
bool bay_lists_enabled(const BayLists *lists);

// Turns the blocker on or off; true when that turned it back on (update its lists).
bool bay_lists_set_enabled(const BayLists *lists, bool enabled);
// Turns list `id` on or off: 1 changed, 0 already so, -1 a list the catalogue lacks.
int32_t bay_lists_set_list(const BayLists *lists, const char *id, bool enabled);
bool bay_lists_is_allowed(const BayLists *lists, const char *host);
// Pauses the blocker on a site, or blocks there again (ending every pause covering it). False when `host` has no host.
bool bay_lists_set_allowed(const BayLists *lists, const char *host, bool allowed);
// Visit Anyway, for this session or always (`remember`); taking it back ends both. False when `host` has no host.
bool bay_lists_set_page_allowed(const BayLists *lists, const char *host, bool allowed, bool remember);
// The person's own lists (Settings › Privacy): added by URL (http or https; `title` may be null) and turned on, its id
// or null for a URL that isn't one; removed with its file. My Filters, the person's own rules in adblock syntax: read,
// and written (turned on, or off when blank; false when the file couldn't be written). Save and rebuild after each.
char *bay_lists_add_custom(const BayLists *lists, const char *url, const char *title);
bool bay_lists_remove_custom(const BayLists *lists, const char *id);
char *bay_lists_user_filters(const BayLists *lists);
bool bay_lists_set_user_filters(const BayLists *lists, const char *text);
// Writes settings.json. Blocks on the disk.
bool bay_lists_save(const BayLists *lists);

// `timing`: the host's request-filter timing, {"lookups", "averageLookupMicros", "maxLookupMicros"}, or null.
// Stats: {"ready", "enabled", "networkFilters", "cosmeticFilters", "parseMs", "lookups", "averageLookupMicros",
// "maxLookupMicros"}.
char *bay_lists_stats(const BayLists *lists, const char *timing);
// Settings › Privacy: {"enabled", "version", "lists": [{"id", "title", "category", "enabled", "defaultOn",
// "filters"}], "allowedHosts", "allowedPages", "stats"}.
char *bay_lists_state(const BayLists *lists, const char *timing);

double bay_lists_first_update_seconds(void);
double bay_lists_update_every_seconds(void);

// The list files. Each blocks on the disk; `ids` are JSON arrays.
// Copies bundled lists (bundled/<id>.txt; `bundled` may be null) in for ids without a file; the ids still without one.
char *bay_lists_seed(const char *directory, const char *bundled, const char *ids);
char *bay_lists_absent(const char *directory, const char *ids);
// The ids stale by `now` (seconds since 1970), or never fetched.
char *bay_lists_due(const char *directory, const char *ids, double now);
// Keeps a downloaded list when it is one: 1 changed, 0 the same, -1 not a list (try the next URL), -2 not written.
int32_t bay_lists_store(const char *directory, const char *id, const uint8_t *body, size_t length, double now);

// Builds the engine for `lists` (bay_lists_selected's JSON) from the cache when `use_cache` and the files are the
// same, else compiles and caches it; `resources` is the scriptlet and redirect resources file, or null. Blocks on the
// disk and the CPU. Apply it with bay_lists_apply or free it with bay_lists_built_free.
BayListsBuilt *bay_lists_build(const char *directory, const char *lists, const char *resources, bool use_cache);
// {"lists": n, "ms": n, "cached": bool, "resources": bool}.
char *bay_lists_built_report(const BayListsBuilt *built);
// Takes the build as the current engine (its counts and timing go into the stats) and gives the engine to the
// caller, who frees it with bay_blocker_free. Consumes `built`.
BayBlocker *bay_lists_apply(const BayLists *lists, BayListsBuilt *built);
void bay_lists_built_free(BayListsBuilt *built);

// WebKit content rules (macOS's WebKit pages): `lists` as for bay_lists_build, `extra` the person's own rules in
// adblock syntax, or null. The key changes with the list files and `extra`; a host keeps its compiled rule lists while
// it's the same. The rules are WKContentRuleList JSON (one array; network and element-hiding rules, no scriptlets).
// The rules block on the disk and the CPU.
char *bay_lists_webkit_key(const char *directory, const char *lists, const char *extra);
char *bay_lists_webkit_rules(const char *directory, const char *lists, const char *extra);

#ifdef __cplusplus
}
#endif

#endif  // BAY_LISTS_H_
