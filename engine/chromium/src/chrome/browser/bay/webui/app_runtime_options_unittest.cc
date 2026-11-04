// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/app_runtime_options.h"

#include "base/command_line.h"
#include "build/build_config.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
TEST(AppRuntimeOptionsTest, DefaultsToSharedRuntimeOnWebDesktops) {
  base::CommandLine command(base::CommandLine::NO_PROGRAM);
#if BUILDFLAG(IS_WIN) || BUILDFLAG(IS_LINUX)
  EXPECT_TRUE(IsAppRuntimeEnabled(command));
#else
  EXPECT_FALSE(IsAppRuntimeEnabled(command));
#endif
}

TEST(AppRuntimeOptionsTest, AllowsExplicitSharedRuntime) {
  base::CommandLine command(base::CommandLine::NO_PROGRAM);
  command.AppendSwitch("bay-shared-runtime");
  EXPECT_TRUE(IsAppRuntimeEnabled(command));
}

TEST(AppRuntimeOptionsTest, LegacyAndHostingSpikeOverrideDefaultAndOptIn) {
  for (const char* disable : {"bay-legacy-runtime", "bay-hosting-spike"}) {
    base::CommandLine command(base::CommandLine::NO_PROGRAM);
    command.AppendSwitch(disable);
    EXPECT_FALSE(IsAppRuntimeEnabled(command)) << disable;
    command.AppendSwitch("bay-shared-runtime");
    EXPECT_FALSE(IsAppRuntimeEnabled(command)) << disable;
  }
}
}  // namespace bay
