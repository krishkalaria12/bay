// Copyright 2026 Bay authors. The filter callbacks follow packages/chromium/ios/NNCoreContentBlocker.mm, desktop's.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#ifndef BAY_MOBILE_BROWSER_BAY_CONTENT_BLOCKER_H_
#define BAY_MOBILE_BROWSER_BAY_CONTENT_BLOCKER_H_

#include <string>
#include <vector>

#include "base/functional/callback.h"

namespace bay {

// Bay's content blocker in the engine: the shared Rust blocker (packages/adblock) behind the request filter every
// engine shares (//bay/filter, nn_request_filter.h), which sees every request, response and WebSocket of every page in
// every profile, plus document-start scriptlets and cosmetic CSS. The app picks the filter lists; the engine compiles and caches them.
class BayContentBlocker {
 public:
  // Installs the filter callbacks. Once, at browser startup; they filter nothing until lists are set.
  static void Install();

  // Blocks with these filter list files (paths), or stops blocking with an empty list. The compiled engine is cached
  // at `cache_path` for `version` and loaded from there next time. On a background thread; `done` gets whether the
  // lists loaded, on the calling sequence.
  static void SetLists(std::vector<std::string> files,
                       std::string version,
                       std::string cache_path,
                       std::string resources_path,
                       base::OnceCallback<void(bool)> done);

  // Sites (hosts, matching their subdomains) where blocking is paused.
  static void SetPausedHosts(std::vector<std::string> hosts);

  // The tracking-parameter table (@bay/core TRACKING_PARAMS as JSON) and the URL without them; "" when unchanged.
  static bool SetTrackingParameters(const std::string& json);
  static std::string CleanUrl(const std::string& url);

  // CSS hiding a page's ad slots: its site rules when `site_rules` (the page's first pass), plus the generic rules
  // for these classes and ids (JSON arrays). "" for none.
  static std::string CosmeticCss(const std::string& page_url,
                                 const std::string& classes_json,
                                 const std::string& ids_json,
                                 bool site_rules);
};

}  // namespace bay

#endif  // BAY_MOBILE_BROWSER_BAY_CONTENT_BLOCKER_H_
