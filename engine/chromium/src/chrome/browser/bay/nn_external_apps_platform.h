// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_NN_EXTERNAL_APPS_PLATFORM_H_
#define CHROME_BROWSER_BAY_NN_EXTERNAL_APPS_PLATFORM_H_

#include <string>

#include "base/values.h"

namespace bay {
// Platform metadata lookup. Linux calls this on a MayBlock worker.
base::DictValue AppForScheme(const std::string& scheme);
}  // namespace bay

#endif  // CHROME_BROWSER_BAY_NN_EXTERNAL_APPS_PLATFORM_H_
