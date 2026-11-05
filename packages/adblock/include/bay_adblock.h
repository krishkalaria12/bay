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
// Per-list permissions: bit 1 allows trusted uBO scriptlets. NULL grants none.
BayBlocker *bay_blocker_new_with_permissions(const char *const *lists, const bool *hosts, const uint8_t *permissions,
                                           size_t count);
// From bay_blocker_serialize's bytes; NULL when they're damaged or from another adblock-rust.
BayBlocker *bay_blocker_deserialize(const uint8_t *data, size_t length);
uint8_t *bay_blocker_serialize(const BayBlocker *blocker, size_t *length);
void bay_bytes_free(uint8_t *data, size_t length);
void bay_blocker_free(BayBlocker *blocker);
// source_url: the document's (or worker's) URL or origin. type: script, image, stylesheet, font, media, subdocument,
// xmlhttprequest, ping, websocket, object, other; through bay_blocker_match also popup, for a page a page opens
// (source_url the opener). method: the HTTP request method.
bool bay_blocker_should_block(const BayBlocker *blocker, const char *url, const char *source_url, const char *type,
                              const char *method);
typedef struct {
  bool blocked;
  // Replacement data URL, only for blocked requests. Free with bay_string_free; NULL means cancel outright.
  char *redirect;
  // The URL to load instead, without the parameters $removeparam rules strip: only for allowed requests. Free with
  // bay_string_free; NULL for none.
  char *rewrite;
  // True when `rewrite` may load from another origin (a $urlskip extracted a URL from a redirect tracker).
  bool rewrite_any_origin;
} BayBlockerMatch;
BayBlockerMatch bay_blocker_match(const BayBlocker *blocker, const char *url, const char *source_url, const char *type,
                                 const char *method);
// The Content-Security-Policy $csp rules add to a document's response, or NULL for none. type: document or subdocument.
// Free with bay_string_free.
char *bay_blocker_content_security_policy(const BayBlocker *blocker, const char *url, const char *source_url,
                                          const char *type);
// Whether bay_blocker_response can change a response ($header, $ipaddress, $permissions, ##^responseheader).
bool bay_blocker_has_response_modifiers(const BayBlocker *blocker);
// The response rules for a request. headers_json is [["Name","value"], ...]; ip is the response's remote address or
// NULL. Returns {"blocked": bool, "add": [[name, value]], "remove": [name]} as JSON, or NULL when there is nothing.
// Free with bay_string_free.
char *bay_blocker_response(const BayBlocker *blocker, const char *url, const char *source_url, const char *type,
                           const char *method, const char *ip, const char *headers_json);
// Whether a response body can be rewritten ($replace, HTML ##^ filtering).
bool bay_blocker_has_body_modifiers(const BayBlocker *blocker);
// Whether the host should buffer a response for bay_blocker_body_filter: uBO's MIME/method/disposition gates plus a
// body rule matching the request. status is 0 when there is no response.
bool bay_blocker_body_filter_applies(const BayBlocker *blocker, const char *url, const char *source_url, const char *type,
                                     const char *method, int32_t status, const char *content_type,
                                     const char *content_disposition);
// The response body after $replace and HTML filtering, or NULL when it is unchanged (then *out_length is 0). The body
// has no Content-Encoding left: the network service removes it. Free the returned bytes with
// bay_bytes_free(body, *out_length).
uint8_t *bay_blocker_body_filter(const BayBlocker *blocker, const char *url, const char *source_url, const char *type,
                                 const char *method, const char *content_type, const uint8_t *body, size_t length,
                                 size_t *out_length);
// Whether any $requestheader rule exists; only then need a host ask about each request.
bool bay_blocker_has_request_header_modifiers(const BayBlocker *blocker);
// The request headers $requestheader rules would look at, as a JSON array of lowercase names, or NULL for none (most
// requests). Free with bay_string_free.
char *bay_blocker_request_header_names(const BayBlocker *blocker, const char *url, const char *source_url,
                                       const char *type, const char *method);
// Whether $requestheader blocks a request with these headers ([["Name","value"], ...]).
bool bay_blocker_request_headers_blocked(const BayBlocker *blocker, const char *url, const char *source_url,
                                         const char *type, const char *method, const char *headers_json);
// Whether a response is blocked by alias, a CNAME of its URL's hostname (uBO's uncloaking).
bool bay_blocker_cname_blocked(const BayBlocker *blocker, const char *url, const char *alias, const char *source_url,
                               const char *type, const char *method);
// The page's scriptlet code for its main world, or NULL for none. Free with bay_string_free.
char *bay_blocker_scriptlets(const BayBlocker *blocker, const char *url);
// {"hide": [selector], "exceptions": [selector], "generichide": bool, "script": scriptlet code,
//  "procedural": [parsed adblock-rust procedural/action AST]}
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

#ifdef __cplusplus
}
#endif
