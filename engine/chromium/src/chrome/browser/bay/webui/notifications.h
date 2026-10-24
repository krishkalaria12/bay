// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_NOTIFICATIONS_H_
#define CHROME_BROWSER_BAY_WEBUI_NOTIFICATIONS_H_

#include <deque>
#include <optional>
#include <string>
#include <string_view>

#include "base/functional/callback.h"
#include "base/values.h"
#include "build/build_config.h"

class NotificationDisplayServiceImpl;
class PrefService;
namespace base {
template <typename T>
class NoDestructor;
}
namespace bay {
class HostContext;

namespace notifications {
#if BUILDFLAG(IS_LINUX)
// Match Chromium's per-profile native-route policy, independently of readiness.
bool NativeRouteEnabled(const PrefService& prefs);
#endif
// Only response fields are encoded in the native ID. No profile paths,
// notification text, icons or origin URLs are copied into activation arguments.
std::optional<std::string> EncodeResponse(const base::DictValue& response,
                                          bool dismissible);
std::optional<base::DictValue> DecodeResponse(std::string_view native_id,
                                              std::string_view action);
}  // namespace notifications

// App-lifetime notification routing survives the coordinator renderer's reload.
// Chromium owns the platform notification and its click/close callbacks.
// Linux post results indicate local submission, and remove results indicate a
// local close request. Neither acknowledges the notification daemon. Portal
// mode is unavailable because it cannot synchronize the IDs used for removal.
// Linux callbacks survive renderer reconnect, not browser restart; close events
// reflect Chromium's signal and do not prove a user dismissal.
class Notifications {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  using EventSink = base::RepeatingCallback<void(base::DictValue)>;
  static Notifications& Get();
  static base::ListValue SupportedMethods();
  static bool SupportsMethod(std::string_view method);
  static void InstallHandler(NotificationDisplayServiceImpl* service);

  void SetEventSink(EventSink sink);
  bool Dispatch(const HostContext& context,
                const std::string& method,
                const base::ListValue& args,
                Response& callback);
  void Respond(std::string_view native_id, std::string_view action);

 private:
  friend class base::NoDestructor<Notifications>;
  Notifications() = default;
  ~Notifications() = default;
  bool DispatchNow(const HostContext& context,
                   const std::string& method,
                   const base::ListValue& args,
                   Response& callback);
  void DrainResponses();
  void StartNextOperation();
  void OperationFinished();
  EventSink event_sink_;
  std::deque<base::DictValue> pending_;
  bool draining_responses_ = false;
  std::deque<base::OnceClosure> operations_;
  bool operation_active_ = false;
};
}  // namespace bay
#endif
