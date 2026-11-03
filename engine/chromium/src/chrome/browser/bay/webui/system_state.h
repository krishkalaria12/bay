// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_SYSTEM_STATE_H_
#define CHROME_BROWSER_BAY_WEBUI_SYSTEM_STATE_H_

#include <memory>

#include "base/functional/callback.h"
#include "base/memory/memory_pressure_listener.h"
#include "base/no_destructor.h"
#include "base/power_monitor/power_observer.h"
#include "base/values.h"

namespace bay {

// BayCEF.systemState and onSystemState on the web desktop host (macOS: CefModule
// SystemState), what tab sleeping reads. Linux has no portable battery level or
// power-saver signal: those report null and false.
class SystemState : public base::PowerStateObserver,
                    public base::MemoryPressureListener {
 public:
  using Sink = base::RepeatingCallback<void(base::DictValue)>;
  static SystemState& Get();

  SystemState(const SystemState&) = delete;
  SystemState& operator=(const SystemState&) = delete;

  // Watches power and memory from now on. Later calls replace the sink.
  void Start(Sink sink);
  base::DictValue Snapshot() const;

 private:
  friend class base::NoDestructor<SystemState>;
  SystemState();
  ~SystemState() override;

  // base::PowerStateObserver
  void OnBatteryPowerStatusChange(
      base::PowerStateObserver::BatteryPowerStatus status) override;
  // base::MemoryPressureListener
  void OnMemoryPressure(base::MemoryPressureLevel level) override;

  Sink sink_;
  std::unique_ptr<base::MemoryPressureListenerRegistration> memory_;
  bool started_ = false;
  base::MemoryPressureLevel level_ = base::MEMORY_PRESSURE_LEVEL_NONE;
};

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_SYSTEM_STATE_H_
