// Plugins on the desktops (packages/rust/bay-plugins/src/ffi.rs), linked through bay-desktop: the manifest, the
// plugins folder, and the files a plugin's sandbox may read. Returned strings and files belong to the library:
// release them with bay_plugins_string_free and bay_plugins_file_free. Paths are UTF-8.

#ifndef BAY_PLUGINS_H_
#define BAY_PLUGINS_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Every plugin in the plugins folder `root`: {"plugins":[manifest…],"problems":[{"folder","error"}]}.
char *bay_plugins_list(const char *root);
// Copies the plugin folder `source` (one the person picked) into `root`, replacing an older copy:
// {"ok":true,"manifest":{…}} or {"ok":false,"error":"…"}.
char *bay_plugins_install(const char *root, const char *source);
// Deletes plugin `id` from `root`; true once it's gone.
bool bay_plugins_remove(const char *root, const char *id);

typedef struct BayPluginFile {
  uint8_t *data;
  size_t len;
  // Static: never freed.
  const char *mime;
} BayPluginFile;

// The file at `path` (relative, a leading / allowed) for plugin `id`'s sandbox: __bay/host.html, __bay/runtime.js or
// a plain file in the plugin's folder. Null for anything else.
BayPluginFile *bay_plugins_file(const char *root, const char *id, const char *path);
void bay_plugins_file_free(BayPluginFile *file);
// The sandbox's content security policy. Static: never freed.
const char *bay_plugins_csp(void);
void bay_plugins_string_free(char *text);

#ifdef __cplusplus
}
#endif

#endif  // BAY_PLUGINS_H_
