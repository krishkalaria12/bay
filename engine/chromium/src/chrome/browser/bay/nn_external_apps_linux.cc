// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/nn_external_apps_platform.h"

#include <gio/gio.h>

#include <memory>

#include "base/base64.h"
#include "base/environment.h"
#include "base/files/file_util.h"
#include "base/nix/xdg_util.h"
#include "base/strings/strcat.h"
#include "base/strings/string_split.h"
#include "base/threading/scoped_blocking_call.h"
#include "ui/base/glib/scoped_gobject.h"
#include "url/url_canon.h"

namespace bay {
namespace {
constexpr size_t kMaxIconBytes = 1024 * 1024;

std::vector<base::FilePath> IconDataDirs() {
  auto env = base::Environment::Create();
  std::vector<base::FilePath> dirs = {base::nix::GetXDGDirectory(
      env.get(), "XDG_DATA_HOME", ".local/share")};
  const std::string shared =
      env->GetVar("XDG_DATA_DIRS").value_or("/usr/local/share:/usr/share");
  for (const auto& dir : base::SplitString(
           shared, ":", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    dirs.emplace_back(dir);
  }
  return dirs;
}
// A file icon gives its path; a themed one its names, best first.
std::optional<std::string> AppIcon(GAppInfo* app) {
  GIcon* icon = g_app_info_get_icon(app);
  if (G_IS_FILE_ICON(icon)) {
    char* path = g_file_get_path(g_file_icon_get_file(G_FILE_ICON(icon)));
    if (!path)
      return std::nullopt;
    auto uri = IconDataUri(base::FilePath(path));
    g_free(path);
    return uri;
  }
  if (!G_IS_THEMED_ICON(icon))
    return std::nullopt;
  const auto dirs = IconDataDirs();
  const char* const* names = g_themed_icon_get_names(G_THEMED_ICON(icon));
  for (; names && *names; ++names) {
    const base::FilePath file = FindAppIcon(*names, dirs);
    if (!file.empty())
      return IconDataUri(file);
  }
  return std::nullopt;
}
}  // namespace

base::FilePath FindAppIcon(const std::string& name,
                           const std::vector<base::FilePath>& data_dirs) {
  // A name comes from a .desktop file: it must not walk out of these folders.
  if (name.empty() || name.find('/') != std::string::npos || name == "..")
    return {};
  for (const auto& dir : data_dirs) {
    const base::FilePath hicolor = dir.Append("icons").Append("hicolor");
    for (const char* size : {"64x64", "48x48", "96x96", "128x128", "256x256"}) {
      const base::FilePath png =
          hicolor.Append(size).Append("apps").Append(name + ".png");
      if (base::PathExists(png))
        return png;
    }
    const base::FilePath svg =
        hicolor.Append("scalable").Append("apps").Append(name + ".svg");
    if (base::PathExists(svg))
      return svg;
    for (const char* extension : {".png", ".svg"}) {
      const base::FilePath pixmap =
          dir.Append("pixmaps").Append(name + extension);
      if (base::PathExists(pixmap))
        return pixmap;
    }
  }
  return {};
}

std::optional<std::string> IconDataUri(const base::FilePath& file) {
  const char* type = file.MatchesExtension(".png")   ? "image/png"
                     : file.MatchesExtension(".svg") ? "image/svg+xml"
                                                     : nullptr;
  std::string bytes;
  if (!type ||
      !base::ReadFileToStringWithMaxSize(file, &bytes, kMaxIconBytes)) {
    return std::nullopt;
  }
  return base::StrCat({"data:", type, ";base64,", base::Base64Encode(bytes)});
}

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
  if (const auto icon = AppIcon(app.get()))
    result.Set("icon", *icon);
  return result;
}

}  // namespace bay
