// Copyright 2026 Bay. Apache-2.0.
// The subprocess executable is CEF's unmodified sandbox bootstrap; this DLL is
// loaded after the bootstrap creates the process sandbox.
#include "cef/include/cef_app.h"
#include "cef/include/cef_sandbox_win.h"
#include <windows.h>

CEF_BOOTSTRAP_EXPORT int RunWinMain(HINSTANCE instance, LPWSTR command_line,
                                    int show_command, void *sandbox_info,
                                    cef_version_info_t *version_info) {
  return CefExecuteProcess(CefMainArgs(instance), nullptr, sandbox_info);
}
