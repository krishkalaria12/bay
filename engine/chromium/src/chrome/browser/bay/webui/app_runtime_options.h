// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_APP_RUNTIME_OPTIONS_H_
#define CHROME_BROWSER_BAY_WEBUI_APP_RUNTIME_OPTIONS_H_

namespace base {
class CommandLine;
}  // namespace base

namespace bay {
bool IsAppRuntimeEnabled(const base::CommandLine& command);
}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_APP_RUNTIME_OPTIONS_H_
