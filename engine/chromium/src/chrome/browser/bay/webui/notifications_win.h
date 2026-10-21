// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_NOTIFICATIONS_WIN_H_
#define CHROME_BROWSER_BAY_WEBUI_NOTIFICATIONS_WIN_H_

#include <deque>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/functional/callback.h"
#include "base/values.h"

class NotificationDisplayServiceImpl;
namespace base {
template <typename T>
class NoDestructor;
}
namespace bay {
class HostContext;

namespace notifications {
// Only response fields are encoded in the native ID. No profile paths,
// notification text, icons or origin URLs are copied into activation arguments.
std::optional<std::string> EncodeResponse(const base::DictValue& response,
                                          bool dismissible);
std::optional<base::DictValue> DecodeResponse(std::string_view native_id,
                                              std::string_view action);
}  // namespace notifications

// App-lifetime notification routing survives the coordinator renderer's reload.
// Chrome owns the native toast, activation COM server, history and close
// events.
class NotificationsWin {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  using EventSink = base::RepeatingCallback<void(base::DictValue)>;
  static NotificationsWin& Get();
  static void InstallHandler(NotificationDisplayServiceImpl* service);

  void SetEventSink(EventSink sink);
  bool Dispatch(const HostContext& context,
                const std::string& method,
                const base::ListValue& args,
                Response& callback);
  void Respond(std::string_view native_id, std::string_view action);

 private:
  friend class base::NoDestructor<NotificationsWin>;
  NotificationsWin() = default;
  ~NotificationsWin() = default;
  bool DispatchNow(const HostContext& context,
                   const std::string& method,
                   const base::ListValue& args,
                   Response& callback);
  void StartNextOperation();
  void OperationFinished();
  EventSink event_sink_;
  std::vector<base::DictValue> pending_;
  std::deque<base::OnceClosure> operations_;
  bool operation_active_ = false;
};
}  // namespace bay
#endif
