// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/icon_fetch.h"

#include "bay/core/nn_icon_download.h"

#include <algorithm>
#include <cstdint>
#include <memory>
#include <optional>
#include <utility>

#include "base/base64.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/scoped_observation.h"
#include "base/strings/string_util.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_observer.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "content/public/browser/storage_partition.h"
#include "net/base/data_url.h"
#include "net/base/mime_sniffer.h"
#include "net/base/net_errors.h"
#include "net/http/http_response_headers.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/data_decoder/public/cpp/decode_image.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "skia/ext/image_operations.h"
#include "third_party/blink/public/common/mime_util/mime_util.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/geometry/size.h"
#include "url/gurl.h"

namespace bay {
namespace {

using Reply = base::OnceCallback<void(base::Value)>;

// macOS's sizes: twice the sidebar's 32-point icon, and its download cap.
constexpr int kMaxSide = 64;
constexpr size_t kMaxBytes = 2 * 1024 * 1024;
base::Value Encode(SkBitmap bitmap) {
  if (bitmap.drawsNothing())
    return base::Value();
  const int longest = std::max(bitmap.width(), bitmap.height());
  if (longest > kMaxSide) {
    bitmap = skia::ImageOperations::Resize(
        bitmap, skia::ImageOperations::RESIZE_LANCZOS3,
        std::max(1, bitmap.width() * kMaxSide / longest),
        std::max(1, bitmap.height() * kMaxSide / longest));
  }
  const auto png = gfx::PNGCodec::EncodeBGRASkBitmap(bitmap, false);
  if (!png)
    return base::Value();
  return base::Value(base::DictValue()
                         .Set("uri", "data:image/png;base64," +
                                         base::Base64Encode(*png))
                         .Set("width", bitmap.width())
                         .Set("height", bitmap.height()));
}

void Decode(std::string_view body, Reply reply) {
  // No decoder here reads SVG. The document does, as an image, where it can't
  // run script or load anything.
  if (IsSvgBody(body)) {
    std::move(reply).Run(base::Value(
        base::DictValue().Set("svg", base::Base64Encode(body))));
    return;
  }
  // In the sandboxed decoder: an icon is untrusted web data.
  data_decoder::DecodeImageIsolated(
      base::as_byte_span(body), data_decoder::mojom::ImageCodec::kDefault,
      /*shrink_to_fit=*/false, data_decoder::kDefaultMaxSizeInBytes,
      gfx::Size(),
      base::BindOnce(
          [](Reply reply, const SkBitmap& bitmap) {
            // Scaling and encoding a large icon must not block the UI sequence.
            base::ThreadPool::PostTaskAndReplyWithResult(
                FROM_HERE,
                {base::TaskPriority::USER_VISIBLE,
                 base::TaskShutdownBehavior::CONTINUE_ON_SHUTDOWN},
                base::BindOnce(&Encode, bitmap), std::move(reply));
          },
          std::move(reply)));
}

// Downloads through the shared fetch (bay/core/nn_icon_download, as macOS) and
// decodes here.
void Download(Profile* profile, const GURL& url, Reply reply) {
  nncore::DownloadIcon(profile, url, kMaxBytes,
                       base::BindOnce(
                           [](Reply reply, std::optional<std::string> body) {
                             if (body)
                               Decode(*body, std::move(reply));
                             else
                               std::move(reply).Run(base::Value());
                           },
                           std::move(reply)));
}

}  // namespace

bool IsSvgBody(std::string_view body) {
  return nncore::IsSvgBody(body);
}

bool IsIconBody(std::string_view body) {
  return nncore::IsIconBody(body, "");
}

void FetchIcon(const std::string& url,
               const std::string& profile,
               Reply reply) {
  const GURL target(url);
  if (target.SchemeIs("data")) {
    std::string mime;
    std::string charset;
    std::string body;
    if (net::DataURL::Parse(target, &mime, &charset, &body) &&
        mime.starts_with("image/") && nncore::IsIconBody(body, mime)) {
      Decode(body, std::move(reply));
    } else {
      std::move(reply).Run(base::Value());
    }
    return;
  }
  if (!target.SchemeIsHTTPOrHTTPS()) {
    std::move(reply).Run(base::Value());
    return;
  }
  constexpr std::string_view kPrivate = "incognito:";
  if (profile.starts_with(kPrivate)) {
    auto* window =
        WindowRegistry::Get().Find(profile.substr(kPrivate.size()));
    if (window && window->GetProfile()->IsOffTheRecord())
      Download(window->GetProfile(), target, std::move(reply));
    else
      std::move(reply).Run(base::Value());
    return;
  }
  WindowRegistry::Get().LoadProfile(
      profile, base::BindOnce(
                   [](GURL target, Reply reply, Profile* loaded) {
                     if (loaded)
                       Download(loaded, target, std::move(reply));
                     else
                       std::move(reply).Run(base::Value());
                   },
                   target, std::move(reply)));
}

}  // namespace bay
