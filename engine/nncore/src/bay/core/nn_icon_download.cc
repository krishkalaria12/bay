// Copyright 2026 Bay. Apache-2.0.
#include "bay/core/nn_icon_download.h"

#include <algorithm>
#include <cstdint>
#include <memory>
#include <utility>

#include "base/functional/bind.h"
#include "base/scoped_observation.h"
#include "base/strings/string_util.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_observer.h"
#include "content/public/browser/storage_partition.h"
#include "net/base/mime_sniffer.h"
#include "net/base/net_errors.h"
#include "net/http/http_response_headers.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "third_party/blink/public/common/mime_util/mime_util.h"
#include "url/gurl.h"

namespace nncore {
namespace {

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

// An ISO-BMFF File Type Box naming AVIF among its brands (blink's
// AVIFImageDecoder::MatchesAVIFSignature; net's sniffer calls any "ftyp"
// video/mp4).
bool IsAvif(std::string_view body) {
  if (body.size() < 16 || body.substr(4, 4) != "ftyp")
    return false;
  const size_t box = std::min<size_t>(
      body.size(), (size_t{static_cast<uint8_t>(body[0])} << 24) |
                       (size_t{static_cast<uint8_t>(body[1])} << 16) |
                       (size_t{static_cast<uint8_t>(body[2])} << 8) |
                       size_t{static_cast<uint8_t>(body[3])});
  // The major brand, then (past the minor version) the compatible ones.
  for (size_t at = 8; at + 4 <= box; at += at == 8 ? 8 : 4) {
    const std::string_view brand = body.substr(at, 4);
    if (brand == "avif" || brand == "avis")
      return true;
  }
  return false;
}

// One download. Owns itself: deleted when it finishes, or when its profile goes
// first, which cancels the request.
class IconDownload : public ProfileObserver {
 public:
  using Done = base::OnceCallback<void(std::optional<std::string>)>;

  static void Start(Profile* profile,
                    const GURL& url,
                    size_t max_bytes,
                    Done done) {
    (new IconDownload(profile, std::move(done)))->Load(profile, url, max_bytes);
  }

  IconDownload(const IconDownload&) = delete;
  IconDownload& operator=(const IconDownload&) = delete;

 private:
  IconDownload(Profile* profile, Done done) : done_(std::move(done)) {
    observation_.Observe(profile);
  }
  ~IconDownload() override = default;

  void Load(Profile* profile, const GURL& url, size_t max_bytes) {
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
        std::min(max_bytes,
                 network::SimpleURLLoader::kMaxBoundedStringDownloadSize));
  }

  void OnLoaded(std::optional<std::string> body) {
    const network::mojom::URLResponseHead* head = loader_->ResponseInfo();
    const bool ok = loader_->NetError() == net::OK && body && head &&
                    head->headers && head->headers->response_code() == 200 &&
                    IsIconBody(*body, head->mime_type);
    Done done = std::move(done_);
    delete this;
    std::move(done).Run(ok ? std::move(body) : std::nullopt);
  }

  void OnProfileWillBeDestroyed(Profile*) override {
    // Never inside the profile's teardown.
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(std::move(done_), std::nullopt));
    delete this;
  }

  Done done_;
  std::unique_ptr<network::SimpleURLLoader> loader_;
  base::ScopedObservation<Profile, ProfileObserver> observation_{this};
};

}  // namespace

bool IsSvgBody(std::string_view body) {
  const std::string_view start = body.substr(0, 4096);
  const size_t svg = start.find("<svg");
  return svg != std::string_view::npos &&
         base::TrimWhitespaceASCII(start, base::TRIM_LEADING)
             .starts_with("<") &&
         start.substr(0, svg).find("<html") == std::string_view::npos &&
         start.substr(0, svg).find("<HTML") == std::string_view::npos;
}

bool IsIconBody(std::string_view body, std::string_view mime_type) {
  if (body.empty())
    return false;
  if (mime_type == "image/svg+xml" || IsSvgBody(body))
    return true;
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

void DownloadIcon(Profile* profile,
                  const GURL& url,
                  size_t max_bytes,
                  base::OnceCallback<void(std::optional<std::string>)> done) {
  IconDownload::Start(profile, url, max_bytes, std::move(done));
}

}  // namespace nncore
