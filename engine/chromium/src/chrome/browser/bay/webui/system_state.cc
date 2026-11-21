// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/system_state.h"

#include <utility>

#include "base/byte_size.h"
#include "base/power_monitor/power_monitor.h"
#include "base/system/sys_info.h"
#include "build/build_config.h"

#if BUILDFLAG(IS_WIN)
#include <windows.h>
#endif

namespace bay {
namespace {

const char* LevelName(base::MemoryPressureLevel level) {
  switch (level) {
    case base::MEMORY_PRESSURE_LEVEL_CRITICAL:
      return "critical";
    case base::MEMORY_PRESSURE_LEVEL_MODERATE:
      return "warning";
    case base::MEMORY_PRESSURE_LEVEL_NONE:
      return "normal";
  }
  return "normal";
}

}  // namespace

SystemState& SystemState::Get() {
  static base::NoDestructor<SystemState> state;
  return *state;
}

SystemState::SystemState() = default;
SystemState::~SystemState() = default;

void SystemState::Start(Sink sink) {
  sink_ = std::move(sink);
  if (started_)
    return;
  started_ = true;
  base::PowerMonitor::GetInstance()->AddPowerStateObserver(this);
  // The tag only labels the registration in traces; none is Bay's.
  memory_ = std::make_unique<base::MemoryPressureListenerRegistration>(
      base::MemoryPressureListenerTag::kTest, this);
}

base::DictValue SystemState::Snapshot() const {
  base::Value battery_level;
  bool low_power = false;
#if BUILDFLAG(IS_WIN)
  SYSTEM_POWER_STATUS power = {};
  if (::GetSystemPowerStatus(&power)) {
    if (power.BatteryLifePercent <= 100)
      battery_level = base::Value(power.BatteryLifePercent / 100.0);
    low_power = power.SystemStatusFlag == 1;
  }
#endif
  return base::DictValue()
      .Set("onBattery", base::PowerMonitor::GetInstance()->IsOnBatteryPower())
      .Set("batteryLevel", std::move(battery_level))
      .Set("lowPowerMode", low_power)
      .Set("memoryPressure", LevelName(level_))
      .Set("physicalMemory",
           static_cast<double>(
               base::SysInfo::AmountOfTotalPhysicalMemory().InBytes()));
}

void SystemState::OnBatteryPowerStatusChange(
    base::PowerStateObserver::BatteryPowerStatus status) {
  if (sink_)
    sink_.Run(Snapshot());
}

void SystemState::OnMemoryPressure(base::MemoryPressureLevel level) {
  level_ = level;
  if (sink_)
    sink_.Run(Snapshot());
}

}  // namespace bay
