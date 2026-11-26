// Copyright 2026 Bay. Apache-2.0.

#include "chrome/browser/bay/nn_spare.h"

#include "chrome/browser/performance_manager/public/user_tuning/battery_saver_mode_manager.h"
#include "content/public/browser/spare_render_process_host_manager.h"

NN_ENGINE_CALL(nn_spare_warmup) {
  bay::Call call(profile_dir, args_json, reply, context);
  if (!call) {
    return;
  }
  using performance_manager::user_tuning::BatterySaverModeManager;
  if (BatterySaverModeManager::HasInstance() &&
      BatterySaverModeManager::GetInstance()->IsBatterySaverActive()) {
    return call.TakeReply().Send(
        base::DictValue().Set("warmed", false).Set("reason", "batterySaver"));
  }
  const bool warmed = content::SpareRenderProcessHostManager::Get().WarmupSpare(
                          call.profile()) != nullptr;
  base::DictValue result;
  result.Set("warmed", warmed);
  if (!warmed) {
    result.Set("reason", "failed");
  }
  call.TakeReply().Send(std::move(result));
}
