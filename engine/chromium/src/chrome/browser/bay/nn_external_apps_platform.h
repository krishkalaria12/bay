// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_NN_EXTERNAL_APPS_PLATFORM_H_
#define CHROME_BROWSER_BAY_NN_EXTERNAL_APPS_PLATFORM_H_

#include <optional>
#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/values.h"
#include "build/build_config.h"

namespace bay {
// Platform metadata lookup, which reads the disk: {app, icon}, each null when
// the desktop doesn't say. `icon` is a data: URI. Linux calls this on a MayBlock
// worker.
base::DictValue AppForScheme(const std::string& scheme);

#if BUILDFLAG(IS_LINUX)
// Where an application's icon of this name lives, by the freedesktop icon
// theme layout: under each of `data_dirs`, hicolor's sizes nearest what the
// prompt draws, then pixmaps. Empty when it isn't there.
base::FilePath FindAppIcon(const std::string& name,
                           const std::vector<base::FilePath>& data_dirs);
// The file as a data: URI, for a PNG or SVG small enough to be an icon.
std::optional<std::string> IconDataUri(const base::FilePath& file);
#endif
}  // namespace bay

#endif  // CHROME_BROWSER_BAY_NN_EXTERNAL_APPS_PLATFORM_H_
