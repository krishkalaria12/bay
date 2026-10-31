// Bay's Rust content blocker (modules/bay-engine/rust/src/ffi.rs). Returned strings belong to the library: release
// them with bay_string_free.
#pragma once
#include <stdbool.h>

char *bay_content_blocking_rules(const char *lists);
bool bay_tracking_set(const char *json);
char *bay_tracking_clean(const char *url);
void bay_string_free(char *text);
