// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/nn_external_apps_platform.h"

#include <gio/gio.h>

#include "base/threading/scoped_blocking_call.h"
#include "ui/base/glib/scoped_gobject.h"
#include "url/url_canon.h"

namespace bay {

base::DictValue AppForScheme(const std::string& scheme) {
  base::DictValue result;
  result.Set("app", base::Value());
  result.Set("icon", base::Value());
  // Validate the scheme itself. A complete URL such as ftp: needs a host,
  // but that does not make ftp an invalid protocol association.
  url::RawCanonOutput<64> output;
  url::Component component;
  if (!url::CanonicalizeScheme(std::string_view(scheme), &output, &component))
    return result;
  const std::string canonical_scheme(output.data() + component.begin,
                                      component.len);

  // GIO can read the desktop's application database. Resolve the copied
  // scheme on a MayBlock worker, never against live profile prefs on UI.
  base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
  auto app = TakeGObject(
      g_app_info_get_default_for_uri_scheme(canonical_scheme.c_str()));
  if (!app.get())
    return result;
  const char* name = g_app_info_get_display_name(app.get());
  if (!name || !*name)
    name = g_app_info_get_name(app.get());
  if (name && *name)
    result.Set("app", name);
  return result;
}

}  // namespace bay
