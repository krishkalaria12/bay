// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/app_runtime_options.h"

#include "base/command_line.h"
#include "build/build_config.h"

namespace bay {
bool IsAppRuntimeEnabled(const base::CommandLine& command) {
  if (command.HasSwitch("bay-legacy-runtime") ||
      command.HasSwitch("bay-hosting-spike"))
    return false;
#if BUILDFLAG(IS_WIN) || BUILDFLAG(IS_LINUX)
  return true;
#else
  return command.HasSwitch("bay-shared-runtime");
#endif
}
}  // namespace bay
