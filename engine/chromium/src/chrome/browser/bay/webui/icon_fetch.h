// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_ICON_FETCH_H_
#define CHROME_BROWSER_BAY_WEBUI_ICON_FETCH_H_

#include <string>
#include <string_view>

#include "base/functional/callback.h"
#include "base/values.h"

namespace bay {

// BayCEF.fetchFavicon on the web desktop host, as macOS nn_icon_fetch and
// NNCoreFavicons: an icon the app wants without a tab (a bookmark, a history
// row), through the profile's own network stack without cookies or credentials,
// a 200 only, with a size cap and a time-out. A private window's profile is used
// only while its window is open; a fetch never makes one. Replies
// {uri: "data:image/png;base64,…", width, height}, or null. SVG icons need a
// renderer to rasterize and come back null, as a live tab's still show them.
void FetchIcon(const std::string& url,
               const std::string& profile,
               base::OnceCallback<void(base::Value)> reply);

// What Chrome decodes as a favicon, sniffed from the bytes whatever the server
// calls them: a .ico served as text/plain works, an HTML error page doesn't.
bool IsIconBody(std::string_view body);

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_ICON_FETCH_H_
