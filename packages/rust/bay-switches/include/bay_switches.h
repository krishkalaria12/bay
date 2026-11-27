// Remote kill switches on the desktops (packages/rust/bay-switches/src/ffi.rs), linked through bay-desktop: Bay's
// signed feed (https://baybrowser.in/switches.json), checked and matched to this platform and release. Returned
// strings belong to the library: release them with bay_switches_string_free.

#ifndef BAY_SWITCHES_H_
#define BAY_SWITCHES_H_

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// The switches in `feed` (the feed's exact text) that apply here, as JSON:
// {"ok":true,"issued":N,"switches":[{"id","feature","reason","until"?}]} or {"ok":false,"error":"signature"|"format"|"stale"}.
// `signature` is the feed's .sig (base64 Ed25519); `platform` is "macos", "windows" or "linux"; `now` and
// `last_issued` are seconds since 1970, `last_issued` the issue time of the feed the host kept (0 for none).
char *bay_switches_check(const char *feed, const char *signature, const char *platform, const char *version, int64_t now,
                         int64_t last_issued);
void bay_switches_string_free(char *text);

#ifdef __cplusplus
}
#endif

#endif  // BAY_SWITCHES_H_
