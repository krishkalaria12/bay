// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/notifications_win.h"

#include <algorithm>
#include <memory>
#include <set>
#include <tuple>
#include <utility>

#include "base/base64.h"
#include "base/base64url.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/bind_post_task.h"
#include "base/task/thread_pool.h"
#include "base/uuid.h"
#include "build/build_config.h"
#include "chrome/browser/bay/webui/host_context.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/notifications/notification_display_service_factory.h"
#include "chrome/browser/notifications/notification_display_service_impl.h"
#include "chrome/browser/notifications/notification_handler.h"
#include "chrome/browser/notifications/notification_platform_bridge.h"
#include "chrome/browser/profiles/profile.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/base/models/image_model.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/image/image_skia.h"
#include "ui/message_center/public/cpp/notification.h"
#include "ui/message_center/public/cpp/notifier_id.h"
#include "url/gurl.h"

#if BUILDFLAG(IS_WIN)
#include <shellapi.h>
#include <windows.h>
#include <windows.ui.notifications.h>
#include <wrl/client.h>
#include "base/win/core_winrt_util.h"
#include "base/win/scoped_hstring.h"
#include "chrome/browser/notifications/notification_platform_bridge_win.h"
#include "chrome/install_static/install_util.h"
#include "chrome/installer/util/install_util.h"
#include "chrome/installer/util/shell_util.h"
#endif

namespace bay {
namespace {
constexpr std::string_view kPrefix = "bay-v1:";
constexpr size_t kMaxResponseBytes = 4096;
constexpr size_t kMaxNativeIdBytes = 5500;
constexpr size_t kMaxPendingResponses = 128;
using Response = NotificationsWin::Response;

std::string Success(base::Value value = base::Value()) {
  return base::WriteJson(base::DictValue().Set("value", std::move(value)))
      .value_or("{}");
}
std::string Failure(std::string_view code, std::string_view message) {
  return base::WriteJson(
             base::DictValue().Set(
                 "error",
                 base::DictValue().Set("code", code).Set("message", message)))
      .value_or("{}");
}

bool ValidResponse(const base::DictValue& response) {
  const auto* id = response.FindString("id");
  if (!id || id->empty() || id->size() > 512 || !base::IsStringUTF8(*id))
    return false;
  for (const char* field : {"tabId", "windowId"}) {
    const auto* value = response.Find(field);
    if (!value || (!value->is_none() &&
                   (!value->is_string() || value->GetString().size() > 256 ||
                    !base::IsStringUTF8(value->GetString()))))
      return false;
  }
  const auto* data = response.Find("data");
  return data && (data->is_none() || data->is_dict());
}

#if BUILDFLAG(IS_WIN)
constexpr auto kNotificationType = NotificationHandler::Type::BAY;
#else
// Allows the portable codec and service API to be checked on the Mac host.
// The notification enum addition is applied only to Windows Chromium builds.
constexpr auto kNotificationType = static_cast<NotificationHandler::Type>(13);
#endif

struct Request {
  std::string id;
  std::string native_id;
  std::string title;
  std::string body;
  std::string subtitle;
  std::string icon;
  bool silent = false;
};

std::optional<Request> ParseRequest(const base::DictValue& options) {
  Request request;
  for (auto [field, output, limit] :
       {std::tuple{"title", &request.title, 4096u},
        std::tuple{"body", &request.body, 8192u},
        std::tuple{"subtitle", &request.subtitle, 512u},
        std::tuple{"icon", &request.icon, 256 * 1024u}}) {
    const auto* value = options.Find(field);
    if (!value) {
      if (std::string_view(field) == "title")
        return std::nullopt;
      continue;
    }
    if (!value->is_string() || value->GetString().size() > limit ||
        !base::IsStringUTF8(value->GetString()))
      return std::nullopt;
    *output = value->GetString();
  }
  const auto* id = options.Find("id");
  if (id && !id->is_string())
    return std::nullopt;
  request.id =
      id ? id->GetString() : base::Uuid::GenerateRandomV4().AsLowercaseString();
  for (const char* field : {"silent", "dismissible"}) {
    if (const auto* value = options.Find(field); value && !value->is_bool())
      return std::nullopt;
  }
  request.silent = options.FindBool("silent").value_or(false);
  base::DictValue response;
  response.Set("id", request.id);
  for (const char* field : {"tabId", "windowId", "data"}) {
    const auto* value = options.Find(field);
    response.Set(field, value ? value->Clone() : base::Value());
  }
  auto native_id = notifications::EncodeResponse(
      response, options.FindBool("dismissible").value_or(false));
  if (!native_id)
    return std::nullopt;
  request.native_id = std::move(*native_id);
  return request;
}

ui::ImageModel Icon(const std::string& uri) {
  // Page icons already arrive through their tab's authenticated request
  // context. Never fetch a renderer-provided URL or read an arbitrary file
  // here.
  constexpr std::string_view prefix = "data:image/png;base64,";
  if (!base::StartsWith(uri, prefix))
    return {};
  std::string bytes;
  if (!base::Base64Decode(std::string_view(uri).substr(prefix.size()), &bytes))
    return {};
  // Bound decoded image dimensions before asking Skia to allocate the bitmap.
  if (bytes.size() < 24 || bytes.substr(0, 8) != "\x89PNG\r\n\x1a\n")
    return {};
  auto dimension = [&bytes](size_t at) {
    uint32_t value = 0;
    for (size_t i = at; i < at + 4; ++i)
      value = (value << 8) | static_cast<unsigned char>(bytes[i]);
    return value;
  };
  if (dimension(16) > 512 || dimension(20) > 512)
    return {};
  SkBitmap bitmap = gfx::PNGCodec::Decode(base::as_byte_span(bytes));
  return bitmap.drawsNothing()
             ? ui::ImageModel()
             : ui::ImageModel::FromImageSkia(
                   gfx::ImageSkia::CreateFrom1xBitmap(bitmap));
}

class Handler final : public NotificationHandler {
 public:
  void OnClick(Profile*,
               const GURL&,
               const std::string& id,
               const std::optional<int>&,
               const std::optional<std::u16string>&,
               base::OnceClosure completed) override {
    NotificationsWin::Get().Respond(id, "click");
    std::move(completed).Run();
  }
  void OnClose(Profile*,
               const GURL&,
               const std::string& id,
               bool by_user,
               base::OnceClosure completed) override {
    if (by_user)
      NotificationsWin::Get().Respond(id, "close");
    std::move(completed).Run();
  }
};

std::optional<bool> ReadPermission() {
#if BUILDFLAG(IS_WIN)
  // Chrome's ThreadPool workers initialize WinRT for their thread lifetime.
  // Match the exact notifier identity used by NotificationPlatformBridgeWin.
  if (!InstallUtil::IsStartMenuShortcutWithActivatorGuidInstalled())
    return std::nullopt;
  Microsoft::WRL::ComPtr<
      ABI::Windows::UI::Notifications::IToastNotificationManagerStatics>
      manager;
  HRESULT hr = base::win::GetActivationFactory<
      ABI::Windows::UI::Notifications::IToastNotificationManagerStatics,
      RuntimeClass_Windows_UI_Notifications_ToastNotificationManager>(
      manager.GetAddressOf());
  if (FAILED(hr))
    return std::nullopt;
  const auto app_id = base::win::ScopedHString::Create(
      ShellUtil::GetBrowserModelId(InstallUtil::IsPerUserInstall()));
  Microsoft::WRL::ComPtr<ABI::Windows::UI::Notifications::IToastNotifier>
      notifier;
  if (FAILED(manager->CreateToastNotifierWithId(app_id.get(), &notifier)))
    return std::nullopt;
  ABI::Windows::UI::Notifications::NotificationSetting setting;
  if (FAILED(notifier->get_Setting(&setting)))
    return std::nullopt;
  return setting ==
         ABI::Windows::UI::Notifications::NotificationSetting_Enabled;
#else
  return std::nullopt;
#endif
}

void WithNativeService(
    base::WeakPtr<Profile> profile,
    base::OnceCallback<void(NotificationDisplayServiceImpl*, Response)> ready,
    Response callback) {
  auto* bridge = g_browser_process
                     ? g_browser_process->notification_platform_bridge()
                     : nullptr;
#if BUILDFLAG(IS_WIN)
  if (!NotificationPlatformBridgeWin::SystemNotificationEnabled())
    bridge = nullptr;
#endif
  if (!profile || profile->IsOffTheRecord() || !bridge) {
    std::move(callback).Run(
        Failure("unavailable", "Native notifications are unavailable"));
    return;
  }
  bridge->SetReadyCallback(base::BindOnce(
      [](base::WeakPtr<Profile> profile,
         base::OnceCallback<void(NotificationDisplayServiceImpl*, Response)>
             ready,
         Response callback, bool available) {
        if (!profile || !available) {
          std::move(callback).Run(Failure(
              "unavailable", "Install Bay to enable native notifications"));
          return;
        }
        std::move(ready).Run(
            NotificationDisplayServiceImpl::GetForProfile(profile.get()),
            std::move(callback));
      },
      profile, std::move(ready), std::move(callback)));
}
}  // namespace

namespace notifications {
std::optional<std::string> EncodeResponse(const base::DictValue& response,
                                          bool dismissible) {
  if (!ValidResponse(response))
    return std::nullopt;
  // Rebuild the allowlist so no caller can add origin or profile information.
  base::DictValue payload;
  for (const char* field : {"id", "tabId", "windowId", "data"})
    payload.Set(field, response.Find(field)->Clone());
  payload.Set("dismissible", dismissible);
  const auto json = base::WriteJson(payload);
  if (!json || json->size() > kMaxResponseBytes)
    return std::nullopt;
  std::string encoded;
  base::Base64UrlEncode(*json, base::Base64UrlEncodePolicy::OMIT_PADDING,
                        &encoded);
  return std::string(kPrefix) + encoded;
}

std::optional<base::DictValue> DecodeResponse(std::string_view native_id,
                                              std::string_view action) {
  if ((action != "click" && action != "close") ||
      native_id.size() > kMaxNativeIdBytes ||
      !base::StartsWith(native_id, kPrefix))
    return std::nullopt;
  std::string json;
  if (!base::Base64UrlDecode(native_id.substr(kPrefix.size()),
                             base::Base64UrlDecodePolicy::DISALLOW_PADDING,
                             &json) ||
      json.size() > kMaxResponseBytes)
    return std::nullopt;
  auto payload = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
  if (!payload || !ValidResponse(*payload) ||
      !payload->FindBool("dismissible").has_value() ||
      (action == "close" && !*payload->FindBool("dismissible")))
    return std::nullopt;
  base::DictValue response;
  for (const char* field : {"id", "tabId", "windowId", "data"})
    response.Set(field, payload->Find(field)->Clone());
  response.Set("action", action);
  return response;
}
}  // namespace notifications

NotificationsWin& NotificationsWin::Get() {
  static base::NoDestructor<NotificationsWin> instance;
  return *instance;
}
void NotificationsWin::InstallHandler(NotificationDisplayServiceImpl* service) {
  if (!service->GetNotificationHandler(kNotificationType))
    service->AddNotificationHandler(kNotificationType,
                                    std::make_unique<Handler>());
}
void NotificationsWin::SetEventSink(EventSink sink) {
  event_sink_ = std::move(sink);
  if (!event_sink_)
    return;
  auto pending = std::move(pending_);
  pending_.clear();
  for (auto& response : pending)
    event_sink_.Run(std::move(response));
}
void NotificationsWin::Respond(std::string_view native_id,
                               std::string_view action) {
  auto response = notifications::DecodeResponse(native_id, action);
  if (!response)
    return;
  if (event_sink_)
    event_sink_.Run(std::move(*response));
  else {
    if (pending_.size() == kMaxPendingResponses)
      pending_.erase(pending_.begin());
    pending_.push_back(std::move(*response));
  }
}

bool NotificationsWin::Dispatch(const HostContext& context,
                                const std::string& method,
                                const base::ListValue& args,
                                Response& callback) {
  if (method != "postNotification" && method != "removeNotifications")
    return DispatchNow(context, method, args, callback);
  // Replacement IDs carry fresh response metadata. Serialize history/display
  // transactions so two simultaneous updates of one logical ID cannot leave
  // two native toasts, or race an explicit removal.
  if (operations_.size() >= 128) {
    std::move(callback).Run(Failure("busy", "Too many notification requests"));
    return true;
  }
  operations_.push_back(base::BindOnce(
      [](NotificationsWin* owner, HostContext context, std::string method,
         base::ListValue args, Response response) {
        // Also advance if Chrome destroys the callback with its profile. The
        // completion always posts back to this UI sequence.
        base::ScopedClosureRunner done(base::BindPostTaskToCurrentDefault(
            base::BindOnce(&NotificationsWin::OperationFinished,
                           base::Unretained(owner))));
        Response completed = base::BindOnce(
            [](Response response, base::ScopedClosureRunner done,
               const std::string& result) { std::move(response).Run(result); },
            std::move(response), std::move(done));
        owner->DispatchNow(context, method, args, completed);
      },
      base::Unretained(this), context, method, args.Clone(),
      std::move(callback)));
  StartNextOperation();
  return true;
}

void NotificationsWin::StartNextOperation() {
  if (operation_active_ || operations_.empty())
    return;
  operation_active_ = true;
  auto next = std::move(operations_.front());
  operations_.pop_front();
  std::move(next).Run();
}
void NotificationsWin::OperationFinished() {
  operation_active_ = false;
  StartNextOperation();
}

bool NotificationsWin::DispatchNow(const HostContext& context,
                                   const std::string& method,
                                   const base::ListValue& args,
                                   Response& callback) {
  if (method != "notificationPermission" &&
      method != "requestNotificationPermission" &&
      method != "postNotification" && method != "removeNotifications" &&
      method != "openNotificationSettings")
    return false;
  auto fail = [&](std::string_view message) {
    std::move(callback).Run(Failure("invalid_argument", message));
  };
  Profile* profile = context.profile();
  if (!profile || profile->IsOffTheRecord()) {
    std::move(callback).Run(
        Failure("unavailable", "Notification profile is unavailable"));
    return true;
  }
  if (method == "openNotificationSettings") {
    if (!args.empty()) {
      fail("Expected no notification settings arguments");
      return true;
    }
#if BUILDFLAG(IS_WIN)
    const auto result = reinterpret_cast<intptr_t>(
        ShellExecuteW(nullptr, L"open", L"ms-settings:notifications", nullptr,
                      nullptr, SW_SHOWNORMAL));
    std::move(callback).Run(
        result > 32
            ? Success()
            : Failure("unavailable", "Couldn't open notification settings"));
#else
    std::move(callback).Run(Failure(
        "unavailable", "Windows notification settings are unavailable"));
#endif
    return true;
  }
  if (method == "notificationPermission" ||
      method == "requestNotificationPermission") {
    if (!args.empty()) {
      fail("Expected no notification permission arguments");
      return true;
    }
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
        base::BindOnce(&ReadPermission),
        base::BindOnce(
            [](bool request, Response callback, std::optional<bool> allowed) {
              std::move(callback).Run(
                  !allowed
                      ? Failure("unavailable",
                                "Couldn't query Windows notification settings")
                      : Success(request ? base::Value(*allowed)
                                        : base::Value(*allowed ? "granted"
                                                               : "denied")));
            },
            method == "requestNotificationPermission", std::move(callback)));
    return true;
  }
  if (method == "postNotification") {
    if (args.size() != 1 || !args[0].is_dict()) {
      fail("Expected notification options");
      return true;
    }
    auto request = ParseRequest(args[0].GetDict());
    if (!request) {
      fail("Invalid or oversized notification options");
      return true;
    }
    WithNativeService(
        profile->GetWeakPtr(),
        base::BindOnce(
            [](Request request, base::WeakPtr<Profile> profile,
               NotificationDisplayServiceImpl* service, Response response) {
              service->GetDisplayed(base::BindOnce(
                  [](Response response, Request request,
                     base::WeakPtr<Profile> profile,
                     std::set<std::string> displayed, bool supported) {
                    if (!profile || !supported) {
                      std::move(response).Run(Failure(
                          "unavailable",
                          "Couldn't query native notification history"));
                      return;
                    }
                    auto* service =
                        NotificationDisplayServiceImpl::GetForProfile(
                            profile.get());
                    for (const auto& id : displayed) {
                      auto previous =
                          notifications::DecodeResponse(id, "click");
                      if (previous &&
                          *previous->FindString("id") == request.id &&
                          id != request.native_id)
                        service->Close(kNotificationType, id);
                    }
                    message_center::RichNotificationData fields;
                    fields.silent = request.silent;
                    message_center::Notification notification(
                        message_center::NOTIFICATION_TYPE_SIMPLE,
                        request.native_id, base::UTF8ToUTF16(request.title),
                        base::UTF8ToUTF16(request.body), Icon(request.icon),
                        base::UTF8ToUTF16(request.subtitle), GURL(),
                        message_center::NotifierId(
                            message_center::NotifierType::APPLICATION,
                            "Bay.Browser"),
                        fields, nullptr);
                    service->Display(kNotificationType, notification, nullptr);
                    service->GetDisplayed(base::BindOnce(
                        [](Response response, std::string native_id,
                           std::string id, std::set<std::string> displayed,
                           bool supported) {
                          std::move(response).Run(
                              Success(supported && displayed.contains(native_id)
                                          ? base::Value(id)
                                          : base::Value()));
                        },
                        std::move(response), request.native_id, request.id));
                  },
                  std::move(response), std::move(request), profile));
            },
            std::move(*request), profile->GetWeakPtr()),
        std::move(callback));
    return true;
  }
  if (args.size() != 1 || !args[0].is_list() ||
      args[0].GetList().size() > 1000 ||
      !std::ranges::all_of(args[0].GetList(), [](const base::Value& id) {
        return id.is_string() && !id.GetString().empty() &&
               id.GetString().size() <= 512;
      })) {
    fail("Expected notification IDs");
    return true;
  }
  std::set<std::string> ids;
  for (const auto& id : args[0].GetList())
    ids.insert(id.GetString());
  WithNativeService(
      profile->GetWeakPtr(),
      base::BindOnce(
          [](std::set<std::string> ids, base::WeakPtr<Profile> profile,
             NotificationDisplayServiceImpl* service, Response response) {
            service->GetDisplayed(base::BindOnce(
                [](Response response, std::set<std::string> ids,
                   base::WeakPtr<Profile> profile,
                   std::set<std::string> displayed, bool supported) {
                  if (!profile || !supported) {
                    std::move(response).Run(
                        Failure("unavailable",
                                "Couldn't query native notification history"));
                    return;
                  }
                  std::set<std::string> closing;
                  auto* service = NotificationDisplayServiceImpl::GetForProfile(
                      profile.get());
                  for (const auto& id : displayed) {
                    auto previous = notifications::DecodeResponse(id, "click");
                    if (previous && ids.contains(*previous->FindString("id"))) {
                      closing.insert(id);
                      service->Close(kNotificationType, id);
                    }
                  }
                  service->GetDisplayed(base::BindOnce(
                      [](Response response, std::set<std::string> closing,
                         std::set<std::string> displayed, bool supported) {
                        const bool removed =
                            supported &&
                            std::ranges::none_of(
                                closing, [&](const std::string& id) {
                                  return displayed.contains(id);
                                });
                        std::move(response).Run(
                            removed
                                ? Success()
                                : Failure(
                                      "io_error",
                                      "Couldn't remove native notifications"));
                      },
                      std::move(response), std::move(closing)));
                },
                std::move(response), std::move(ids), profile));
          },
          std::move(ids), profile->GetWeakPtr()),
      std::move(callback));
  return true;
}
}  // namespace bay
