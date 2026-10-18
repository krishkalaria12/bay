// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/page_services.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
#include <utility>
#include <vector>

#include "base/base64.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/memory/ref_counted.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/bind_post_task.h"
#include "base/task/single_thread_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "bay/core/nn_devtools_call.h"
#include "chrome/app/chrome_command_ids.h"
#include "chrome/browser/resource_coordinator/tab_lifecycle_unit_external.h"
#include "chrome/browser/ui/browser_commands.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/viz/common/frame_sinks/copy_output_result.h"
#include "content/public/browser/media_session.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/ssl_status.h"
#include "content/public/browser/web_contents.h"
#include "net/cert/cert_status_flags.h"
#include "net/cert/x509_certificate.h"
#include "net/ssl/ssl_connection_status_flags.h"
#include "services/media_session/public/mojom/media_session.mojom.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/gfx/codec/jpeg_codec.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/views/widget/widget.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace bay {
namespace {
std::string Success(base::Value value = base::Value()) {
  return base::WriteJson(base::DictValue().Set("value", std::move(value)))
      .value_or("{}");
}
std::string Failure(const std::string& message) {
  return base::WriteJson(base::DictValue().Set(
                             "error", base::DictValue()
                                          .Set("code", "page_command_failed")
                                          .Set("message", message)))
      .value_or("{}");
}
std::string Text(const base::ListValue& params, size_t index) {
  return index < params.size() && params[index].is_string()
             ? params[index].GetString()
             : std::string();
}
double Number(const base::ListValue& params,
              size_t index,
              double fallback = 0) {
  return index < params.size() && params[index].is_double()
             ? params[index].GetDouble()
         : index < params.size() && params[index].is_int()
             ? params[index].GetInt()
             : fallback;
}
std::string Hex(base::span<const uint8_t> bytes) {
  std::string result;
  for (uint8_t byte : bytes) {
    if (!result.empty())
      result += ':';
    result += base::HexEncode(base::span_from_ref(byte));
  }
  return result;
}
base::DictValue Principal(const net::CertPrincipal& principal) {
  base::ListValue organizations;
  for (const auto& name : principal.organization_names)
    organizations.Append(name);
  return base::DictValue()
      .Set("commonName", principal.common_name)
      .Set("displayName", principal.GetDisplayName())
      .Set("organizations", std::move(organizations))
      .Set("country", principal.country_name);
}
base::DictValue SecurityInfo(content::WebContents* contents) {
  auto* entry = contents->GetController().GetVisibleEntry();
  const GURL url = entry ? entry->GetURL() : contents->GetVisibleURL();
  base::DictValue info;
  info.Set("url", url.spec());
  info.Set("origin", url.SchemeIsHTTPOrHTTPS()
                         ? base::Value(url::Origin::Create(url).Serialize())
                         : base::Value());
  if (url.SchemeIs("http") || url.SchemeIs("ws")) {
    info.Set("level", "insecure");
    return info;
  }
  if (!url.SchemeIs("https") && !url.SchemeIs("wss")) {
    info.Set("level",
             !url.is_empty() && url != GURL("about:blank") ? "local" : "none");
    return info;
  }
  if (!entry) {
    info.Set("level", "none");
    return info;
  }
  const auto& ssl = entry->GetSSL();
  const auto errors = ssl.cert_status & net::CERT_STATUS_ALL_ERRORS &
                      ~(net::CERT_STATUS_NO_REVOCATION_MECHANISM |
                        net::CERT_STATUS_UNABLE_TO_CHECK_REVOCATION);
  const bool ran =
      ssl.content_status & (content::SSLStatus::RAN_INSECURE_CONTENT |
                            content::SSLStatus::RAN_CONTENT_WITH_CERT_ERRORS);
  const bool displayed =
      ssl.content_status &
      (content::SSLStatus::DISPLAYED_INSECURE_CONTENT |
       content::SSLStatus::DISPLAYED_CONTENT_WITH_CERT_ERRORS);
  info.Set("level", errors || !ssl.certificate ? "certificateError"
                    : ran || displayed         ? "mixed"
                                               : "secure");
  base::ListValue names;
  static constexpr std::pair<net::CertStatus, const char*> kErrors[] = {
      {net::CERT_STATUS_COMMON_NAME_INVALID, "nameMismatch"},
      {net::CERT_STATUS_DATE_INVALID, "dateInvalid"},
      {net::CERT_STATUS_AUTHORITY_INVALID, "authorityInvalid"},
      {net::CERT_STATUS_REVOKED, "revoked"},
      {net::CERT_STATUS_INVALID, "invalid"},
      {net::CERT_STATUS_WEAK_SIGNATURE_ALGORITHM, "weakSignature"},
      {net::CERT_STATUS_NON_UNIQUE_NAME, "nonUniqueName"},
      {net::CERT_STATUS_WEAK_KEY, "weakKey"},
      {net::CERT_STATUS_PINNED_KEY_MISSING, "pinnedKeyMissing"},
      {net::CERT_STATUS_NAME_CONSTRAINT_VIOLATION, "nameConstraint"},
      {net::CERT_STATUS_VALIDITY_TOO_LONG, "validityTooLong"},
      {net::CERT_STATUS_CERTIFICATE_TRANSPARENCY_REQUIRED,
       "certificateTransparency"},
  };
  for (const auto& [bit, name] : kErrors) {
    if (errors & bit)
      names.Append(name);
  }
  info.Set("certificateErrors", std::move(names));
  info.Set("mixedContent", ran         ? base::Value("ran")
                           : displayed ? base::Value("displayed")
                                       : base::Value());
  info.Set("isEV", (ssl.cert_status & net::CERT_STATUS_IS_EV) != 0);
  switch (net::SSLConnectionStatusToVersion(ssl.connection_status)) {
    case net::SSL_CONNECTION_VERSION_TLS1:
      info.Set("protocol", "TLS 1.0");
      break;
    case net::SSL_CONNECTION_VERSION_TLS1_1:
      info.Set("protocol", "TLS 1.1");
      break;
    case net::SSL_CONNECTION_VERSION_TLS1_2:
      info.Set("protocol", "TLS 1.2");
      break;
    case net::SSL_CONNECTION_VERSION_TLS1_3:
      info.Set("protocol", "TLS 1.3");
      break;
    case net::SSL_CONNECTION_VERSION_QUIC:
      info.Set("protocol", "QUIC");
      break;
    default:
      break;
  }
  if (const auto* cert = ssl.certificate.get()) {
    info.Set(
        "certificate",
        base::DictValue()
            .Set("subject", Principal(cert->subject()))
            .Set("issuer", Principal(cert->issuer()))
            .Set("validFrom",
                 cert->valid_start().InMillisecondsFSinceUnixEpoch())
            .Set("validUntil",
                 cert->valid_expiry().InMillisecondsFSinceUnixEpoch())
            .Set("chainLength",
                 static_cast<int>(cert->intermediate_buffers().size() + 1))
            .Set("serialNumber", Hex(cert->serial_number()))
            .Set("sha256", Hex(net::X509Certificate::CalculateFingerprint256(
                               cert->cert_buffer()))));
  }
  return info;
}

using PendingReply = base::RefCountedData<PageResponse>;
void ReplyOnce(scoped_refptr<PendingReply> pending, base::Value value) {
  if (pending->data)
    std::move(pending->data).Run(Success(std::move(value)));
}

void CapturePicture(content::WebContents* contents,
                    double scale,
                    PageResponse callback) {
  auto* view = contents->GetRenderWidgetHostView();
  if (!std::isfinite(scale) || scale <= 0) {
    std::move(callback).Run(
        Failure("Picture scale must be finite and positive"));
    return;
  }
  if (!view || contents->GetVisibility() != content::Visibility::VISIBLE ||
      view->GetViewBounds().IsEmpty()) {
    std::move(callback).Run(Success());
    return;
  }
  // Copy the painted compositor viewport, so page zoom, scroll and pinch are
  // already represented in the pixels. Output dimensions honor the requested
  // scale in device pixels without resizing or emulating the live page.
  const gfx::Size viewport = view->GetViewBounds().size();
  const double factor =
      std::min(scale * view->GetDeviceScaleFactor(),
               4096.0 / std::max(viewport.width(), viewport.height()));
  const gfx::Size output(
      std::max(1, static_cast<int>(std::round(viewport.width() * factor))),
      std::max(1, static_cast<int>(std::round(viewport.height() * factor))));
  gfx::Rect bounds = view->GetViewBounds();
  if (auto* widget = views::Widget::GetWidgetForNativeWindow(
          contents->GetTopLevelNativeWindow())) {
    const auto origin = widget->GetClientAreaBoundsInScreen().origin();
    bounds.Offset(-origin.x(), -origin.y());
  }
  base::ListValue frame;
  frame.Append(bounds.x());
  frame.Append(bounds.y());
  frame.Append(bounds.width());
  frame.Append(bounds.height());
  auto pending = base::MakeRefCounted<PendingReply>(std::move(callback));
  // The deadline includes compositor capture and off-thread JPEG encoding.
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE, base::BindOnce(&ReplyOnce, pending, base::Value()),
      base::Seconds(1));
  view->CopyFromSurface(
      gfx::Rect(), output, base::Seconds(1),
      base::BindPostTaskToCurrentDefault(base::BindOnce(
          [](scoped_refptr<PendingReply> pending, base::ListValue frame,
             int quality, const content::CopyFromSurfaceResult& result) {
            if (!pending->data)
              return;
            if (!result.has_value() || result->bitmap.drawsNothing()) {
              ReplyOnce(std::move(pending), base::Value());
              return;
            }
            base::ThreadPool::PostTaskAndReplyWithResult(
                FROM_HERE, {base::TaskPriority::USER_VISIBLE},
                base::BindOnce(
                    [](SkBitmap bitmap,
                       int quality) -> std::optional<std::string> {
                      auto jpeg = gfx::JPEGCodec::Encode(bitmap, quality);
                      return jpeg
                                 ? std::make_optional(base::Base64Encode(*jpeg))
                                 : std::nullopt;
                    },
                    result->bitmap, quality),
                base::BindOnce(
                    [](scoped_refptr<PendingReply> pending,
                       base::ListValue frame, std::optional<std::string> data) {
                      base::Value value;
                      if (data)
                        value =
                            base::Value(base::DictValue()
                                            .Set("data", std::move(*data))
                                            .Set("frame", std::move(frame)));
                      ReplyOnce(std::move(pending), std::move(value));
                    },
                    std::move(pending), std::move(frame)));
          },
          std::move(pending), std::move(frame), scale < 0.5 ? 55 : 75)));
}

void CaptureScreenshot(content::WebContents* contents, PageResponse callback) {
  if (contents->GetVisibility() != content::Visibility::VISIBLE) {
    std::move(callback).Run(Success());
    return;
  }
  base::DictValue request;
  request.Set("format", "png");
  nncore::CallDevTools(
      contents, "Page.captureScreenshot", std::move(request), base::Seconds(3),
      base::BindOnce(
          [](PageResponse callback, std::optional<base::DictValue> result,
             std::optional<std::string> error) {
            const auto* data =
                result && !error ? result->FindString("data") : nullptr;
            std::move(callback).Run(
                Success(data ? base::Value(*data) : base::Value()));
          },
          std::move(callback)));
}
}  // namespace

bool DispatchPageMethod(content::WebContents* contents,
                        const std::string& command,
                        const base::ListValue& params,
                        PageResponse& callback) {
  if (command == "getSecurityInfo") {
    std::move(callback).Run(Success(base::Value(SecurityInfo(contents))));
  } else if (command == "captureScreenshot") {
    CaptureScreenshot(contents, std::move(callback));
  } else if (command == "capturePicture") {
    CapturePicture(contents, Number(params, 0, 1), std::move(callback));
  } else if (command == "downloadImage" || command == "downloadFavicon") {
    const GURL url(Text(params, 0));
    if (!url.is_valid() ||
        !(url.SchemeIsHTTPOrHTTPS() || url.SchemeIs("data"))) {
      std::move(callback).Run(Failure("Invalid image URL"));
      return true;
    }
    const bool favicon = command == "downloadFavicon";
    const double requested = Number(params, 1, favicon ? 64 : 1024);
    if (!std::isfinite(requested) || requested <= 0) {
      std::move(callback).Run(Failure("Image size must be positive"));
      return true;
    }
    const int max_size = static_cast<int>(std::clamp(requested, 1.0, 4096.0));
    // The renderer can disappear without an image reply. Keep only the reply,
    // never the WebContents, alive until the bounded operation finishes.
    auto pending = base::MakeRefCounted<PendingReply>(std::move(callback));
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE, base::BindOnce(&ReplyOnce, pending, base::Value()),
        base::Seconds(10));
    contents->DownloadImage(
        url, favicon, gfx::Size(), max_size, false,
        base::BindOnce(
            [](scoped_refptr<PendingReply> pending, int max_size, int,
               int status, const GURL&, const std::vector<SkBitmap>& bitmaps,
               const std::vector<gfx::Size>&) {
              if (!pending->data)
                return;
              if (bitmaps.empty() ||
                  (status != 0 && (status < 200 || status >= 300))) {
                ReplyOnce(std::move(pending), base::Value());
                return;
              }
              // Apply the caller's limit even if a renderer returns several
              // sizes. Encoding a large icon must not block the UI sequence.
              SkBitmap best;
              for (const auto& bitmap : bitmaps) {
                if (bitmap.width() <= max_size && bitmap.height() <= max_size &&
                    int64_t{bitmap.width()} * bitmap.height() >
                        int64_t{best.width()} * best.height())
                  best = bitmap;
              }
              base::ThreadPool::PostTaskAndReplyWithResult(
                  FROM_HERE, {base::TaskPriority::USER_VISIBLE},
                  base::BindOnce(
                      [](SkBitmap bitmap) {
                        base::Value value;
                        if (!bitmap.drawsNothing()) {
                          if (auto png = gfx::PNGCodec::EncodeBGRASkBitmap(
                                  bitmap, false)) {
                            value = base::Value(
                                base::DictValue()
                                    .Set("uri", "data:image/png;base64," +
                                                    base::Base64Encode(*png))
                                    .Set("width", bitmap.width())
                                    .Set("height", bitmap.height()));
                          }
                        }
                        return value;
                      },
                      std::move(best)),
                  base::BindOnce(&ReplyOnce, std::move(pending)));
            },
            std::move(pending), max_size));
  } else if (command == "print" || command == "runPageCommand") {
    const auto name = command == "print" ? "print" : Text(params, 0);
    const int id = name == "print"           ? IDC_PRINT
                   : name == "savePage"      ? IDC_SAVE_PAGE
                   : name == "systemPrint"   ? IDC_BASIC_PRINT
                   : name == "caretBrowsing" ? IDC_CARET_BROWSING_TOGGLE
                                             : 0;
    auto* browser =
        GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(contents);
    if (!id || !browser ||
        (id != IDC_CARET_BROWSING_TOGGLE &&
         browser->GetTabStripModel()->GetActiveWebContents() != contents) ||
        !chrome::ExecuteCommand(browser, id)) {
      std::move(callback).Run(Failure("Chrome cannot run this page command"));
      return true;
    }
    std::move(callback).Run(Success());
  } else if (command == "discard") {
    // The native handle receives the boolean, not the public JS options object.
    const bool unload =
        !params.empty() && params[0].is_bool() && params[0].GetBool();
    auto* unit =
        resource_coordinator::TabLifecycleUnitExternal::FromWebContents(
            contents);
    const char* result =
        unload                     ? "unsupported"
        : contents->WasDiscarded() ? "already"
        : unit &&
                unit->DiscardTab(::mojom::LifecycleUnitDiscardReason::EXTERNAL)
            ? "discarded"
            : "refused";
    std::move(callback).Run(Success(base::Value(result)));
  } else if (command == "mediaCommand" || command == "exitPictureInPicture") {
    auto* session = content::MediaSession::Get(contents);
    const auto action = Text(params, 0);
    using SuspendType = content::MediaSession::SuspendType;
    const double seconds = Number(params, 1);
    if (!std::isfinite(seconds)) {
      std::move(callback).Run(Failure("Media time must be finite"));
      return true;
    }
    if (command == "exitPictureInPicture")
      session->ExitPictureInPicture();
    else if (action == "play")
      session->Resume(SuspendType::kUI);
    else if (action == "pause")
      session->Suspend(SuspendType::kUI);
    else if (action == "toggle") {
      if (session->GetMediaSessionInfoSync()->playback_state ==
          media_session::mojom::MediaPlaybackState::kPlaying)
        session->Suspend(SuspendType::kUI);
      else
        session->Resume(SuspendType::kUI);
    } else if (action == "next")
      session->NextTrack();
    else if (action == "previous")
      session->PreviousTrack();
    else if (action == "stop") {
      if (session->GetMediaSessionInfoSync()->state !=
          media_session::mojom::MediaSessionInfo::SessionState::kInactive)
        session->Stop(SuspendType::kUI);
    } else if (action == "seekBy") {
      if (seconds != 0)
        session->Seek(base::Seconds(seconds));
    } else if (action == "seekTo" && seconds >= 0)
      session->SeekTo(base::Seconds(seconds));
    else {
      std::move(callback).Run(Failure("Invalid media action"));
      return true;
    }
    std::move(callback).Run(Success());
  } else if (command == "requestPictureInPicture") {
    base::DictValue request;
    request.Set("expression",
                "(async()=>{const v=[...document.querySelectorAll('video')]"
                ".filter(v=>v.readyState>0&&!v.disablePictureInPicture);"
                "v.sort((a,b)=>Number(!b.paused)-Number(!a.paused)||"
                "b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight);"
                "if(!v.length)return false;"
                "if(document.pictureInPictureElement===v[0])return true;"
                "try{await v[0].requestPictureInPicture();return true;}"
                "catch{return false;}})()");
    request.Set("userGesture", true);
    request.Set("awaitPromise", true);
    request.Set("returnByValue", true);
    nncore::CallDevTools(
        contents, "Runtime.evaluate", std::move(request), base::Seconds(5),
        base::BindOnce(
            [](PageResponse callback, std::optional<base::DictValue> result,
               std::optional<std::string> error) {
              const auto* remote =
                  result && !error ? result->FindDict("result") : nullptr;
              std::move(callback).Run(Success(base::Value(
                  remote && remote->FindBool("value").value_or(false))));
            },
            std::move(callback)));
  } else {
    return false;
  }
  return true;
}
}  // namespace bay
