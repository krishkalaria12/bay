// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#ifndef BAY_MOBILE_COMMON_BAY_ISOLATED_WORLD_H_
#define BAY_MOBILE_COMMON_BAY_ISOLATED_WORLD_H_

#include <cstdint>

#include "content/public/common/isolated_world_ids.h"

namespace bay {

// The world Bay's page tools run in (reader, find, inspector, media…): the page's DOM, with a JavaScript global scope
// of its own that page scripts can't see. Blocker scriptlets are the deliberate exception and run in the main world.
inline constexpr int32_t kPageToolsWorldId = content::ISOLATED_WORLD_ID_CONTENT_END + 1;

// The object page tools post through, present only in kPageToolsWorldId.
inline constexpr char16_t kPageToolsMessenger[] = u"__bayPage";

}  // namespace bay

#endif  // BAY_MOBILE_COMMON_BAY_ISOLATED_WORLD_H_
