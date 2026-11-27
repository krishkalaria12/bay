// Copyright 2026 Bay. Apache-2.0.
// An icon the host wants without a tab (a restored or unloaded tab's, a
// bookmark's, a history row's), downloaded as both desktop hosts do: macOS
// (nn_icon_fetch.mm) and Windows and Linux (webui/icon_fetch.cc), which decode
// it their own ways.
#ifndef BAY_CORE_NN_ICON_DOWNLOAD_H_
#define BAY_CORE_NN_ICON_DOWNLOAD_H_

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>

#include "base/functional/callback.h"

class GURL;
class Profile;

namespace nncore {

// What Chrome decodes as a favicon (blink's ImageDecoder::SniffMimeType): a
// raster format sniffed from the bytes whatever the server calls it (a .ico
// served as text/plain works), or SVG, by the response's type or by its bytes.
// Anything else (a PDF, a TIFF, an HTML error page) never reaches a decoder.
bool IsIconBody(std::string_view body, std::string_view mime_type);

// An SVG file, from its first bytes: an XML declaration, a doctype or comments
// may come first; a page with an inline <svg> isn't one.
bool IsSvgBody(std::string_view body);

// Downloads `url` through `profile`'s own network stack as Chrome's
// ImageDataFetcher fetches icons (components/image_fetcher): its proxy, its
// cache (an off-the-record profile's in memory), no cookies or credentials, a
// 200 only, at most `max_bytes` and a time-out. `done` gets the body when it's
// an icon (IsIconBody), else nullopt; when the profile goes first the download
// is cancelled and `done` runs later, never inside the profile's teardown.
void DownloadIcon(Profile* profile,
                  const GURL& url,
                  size_t max_bytes,
                  base::OnceCallback<void(std::optional<std::string>)> done);

}  // namespace nncore

#endif  // BAY_CORE_NN_ICON_DOWNLOAD_H_
