// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/icon_fetch.h"

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
// ImageDataFetcher's kDownloadTimeoutSeconds.
constexpr base::TimeDelta kTimeout = base::Seconds(30);

constexpr net::NetworkTrafficAnnotationTag kTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("bay_icon_fetch", R"(
      semantics {
        sender: "Bay favicons"
        description:
          "Downloads the favicon of a page the browser shows without a live "
          "tab (a restored or unloaded tab, a bookmark, a history entry)."
        trigger: "The sidebar, bookmarks or history list a page with no icon."
        data: "None: no cookies or credentials are sent."
        destination: WEBSITE
      }
      policy {
        cookies_allowed: NO
        setting: "None."
        policy_exception_justification: "Not implemented."
      })");

// An ISO-BMFF File Type Box naming AVIF among its brands (net's sniffer calls
// any "ftyp" video/mp4).
bool IsAvif(std::string_view body) {
  if (body.size() < 16 || body.substr(4, 4) != "ftyp")
    return false;
  const size_t box = std::min<size_t>(
      body.size(), (size_t{static_cast<uint8_t>(body[0])} << 24) |
                       (size_t{static_cast<uint8_t>(body[1])} << 16) |
                       (size_t{static_cast<uint8_t>(body[2])} << 8) |
                       size_t{static_cast<uint8_t>(body[3])});
  for (size_t at = 8; at + 4 <= box; at += at == 8 ? 8 : 4) {
    const std::string_view brand = body.substr(at, 4);
    if (brand == "avif" || brand == "avis")
      return true;
  }
  return false;
}

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

// One fetch. Owns itself: deleted when it finishes, or when its profile goes
// first, which cancels the request and answers null.
class IconDownload : public ProfileObserver {
 public:
  static void Start(Profile* profile, const GURL& url, Reply reply) {
    (new IconDownload(profile, std::move(reply)))->Load(profile, url);
  }

  IconDownload(const IconDownload&) = delete;
  IconDownload& operator=(const IconDownload&) = delete;

 private:
  IconDownload(Profile* profile, Reply reply) : reply_(std::move(reply)) {
    observation_.Observe(profile);
  }
  ~IconDownload() override = default;

  void Load(Profile* profile, const GURL& url) {
    auto request = std::make_unique<network::ResourceRequest>();
    request->url = url;
    request->method = "GET";
    request->credentials_mode = network::mojom::CredentialsMode::kOmit;
    request->destination = network::mojom::RequestDestination::kImage;
    loader_ = network::SimpleURLLoader::Create(std::move(request),
                                               kTrafficAnnotation);
    loader_->SetTimeoutDuration(kTimeout);
    // Unretained: loader_ is ours, and deleting it cancels the callback.
    loader_->DownloadToString(
        profile->GetDefaultStoragePartition()
            ->GetURLLoaderFactoryForBrowserProcess()
            .get(),
        base::BindOnce(&IconDownload::OnLoaded, base::Unretained(this)),
        kMaxBytes);
  }

  void OnLoaded(std::optional<std::string> body) {
    const network::mojom::URLResponseHead* head = loader_->ResponseInfo();
    const bool ok = loader_->NetError() == net::OK && body && head &&
                    head->headers && head->headers->response_code() == 200 &&
                    (IsIconBody(*body) || IsSvgBody(*body));
    Reply reply = std::move(reply_);
    delete this;
    if (ok)
      Decode(*body, std::move(reply));
    else
      std::move(reply).Run(base::Value());
  }

  void OnProfileWillBeDestroyed(Profile*) override {
    // Never inside the profile's teardown.
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(std::move(reply_), base::Value()));
    delete this;
  }

  Reply reply_;
  std::unique_ptr<network::SimpleURLLoader> loader_;
  base::ScopedObservation<Profile, ProfileObserver> observation_{this};
};

}  // namespace

bool IsSvgBody(std::string_view body) {
  // An XML declaration, a doctype or comments may come first; a page with an
  // inline <svg> isn't an icon.
  const std::string_view start = body.substr(0, 4096);
  const size_t svg = start.find("<svg");
  return svg != std::string_view::npos &&
         base::TrimWhitespaceASCII(start, base::TRIM_LEADING)
             .starts_with("<") &&
         start.substr(0, svg).find("<html") == std::string_view::npos &&
         start.substr(0, svg).find("<HTML") == std::string_view::npos;
}

bool IsIconBody(std::string_view body) {
  if (body.empty())
    return false;
  if (IsAvif(body))
    return blink::IsSupportedImageMimeType("image/avif");
  // A cursor (blink decodes .cur as ICO); net's sniffer only knows the icon
  // signature.
  if (body.starts_with(std::string_view("\x00\x00\x02\x00", 4)))
    return true;
  std::string sniffed;
  return net::SniffMimeTypeFromLocalData(body, &sniffed) &&
         (sniffed == "image/png" || sniffed == "image/jpeg" ||
          sniffed == "image/gif" || sniffed == "image/webp" ||
          sniffed == "image/x-icon" || sniffed == "image/bmp");
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
        mime.starts_with("image/") && (IsIconBody(body) || IsSvgBody(body))) {
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
      IconDownload::Start(window->GetProfile(), target, std::move(reply));
    else
      std::move(reply).Run(base::Value());
    return;
  }
  WindowRegistry::Get().LoadProfile(
      profile, base::BindOnce(
                   [](GURL target, Reply reply, Profile* loaded) {
                     if (loaded)
                       IconDownload::Start(loaded, target, std::move(reply));
                     else
                       std::move(reply).Run(base::Value());
                   },
                   target, std::move(reply)));
}

}  // namespace bay
