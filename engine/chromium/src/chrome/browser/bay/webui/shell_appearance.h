// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_SHELL_APPEARANCE_H_
#define CHROME_BROWSER_BAY_WEBUI_SHELL_APPEARANCE_H_

#include <optional>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_multi_source_observation.h"
#include "base/scoped_observation.h"
#include "base/values.h"
#include "chrome/browser/bay/webui/host_context.h"
#include "chrome/browser/profiles/profile_observer.h"
#include "chrome/browser/themes/theme_service_observer.h"
#include "components/prefs/pref_change_registrar.h"
#include "ui/native_theme/native_theme_observer.h"

class ThemeService;

namespace bay {
// UI-sequence operations. The caller owns readiness, profile and contract arity
// checks, including Windows' initialization-error gate.
class ShellAppearance final : public ThemeServiceObserver,
                              public ui::NativeThemeObserver,
                              public ProfileObserver {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  using EventSink = base::RepeatingCallback<void(bool)>;
  explicit ShellAppearance(HostContext context);
  ~ShellAppearance() override;

  // A document owns the observer. Each connection gets a current-state event;
  // replacing/clearing the sink cancels old queued delivery. Profile teardown
  // detaches before keyed services shut down, including original/OTR profiles.
  void SetEventSink(EventSink sink);
  static base::ListValue SupportedMethods();
  // An unhandled method leaves callback untouched.
  static bool Dispatch(const HostContext& context,
                       const std::string& module,
                       const std::string& method,
                       const base::ListValue& args,
                       Response& callback);

 private:
  void OnThemeChanged() override;
  void OnNativeThemeUpdated(ui::NativeTheme* theme) override;
  void OnProfileWillBeDestroyed(Profile* profile) override;
  void ScheduleEvent();
  void DeliverEvent();

  const HostContext context_;
  EventSink event_sink_;
  PrefChangeRegistrar scheme_pref_;
  std::optional<bool> last_dark_;
  bool event_pending_ = false;
  bool profile_destroyed_ = false;
  base::ScopedMultiSourceObservation<Profile, ProfileObserver>
      profile_observations_{this};
  base::ScopedObservation<ThemeService, ThemeServiceObserver>
      theme_observation_{this};
  base::ScopedObservation<ui::NativeTheme, ui::NativeThemeObserver>
      native_observation_{this};
  base::WeakPtrFactory<ShellAppearance> weak_factory_{this};
};
}  // namespace bay
#endif
