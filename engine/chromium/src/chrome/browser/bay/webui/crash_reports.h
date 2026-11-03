// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_CRASH_REPORTS_H_
#define CHROME_BROWSER_BAY_WEBUI_CRASH_REPORTS_H_

#include <ctime>
#include <optional>
#include <string>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/values.h"

namespace crashpad {
class ProcessSnapshot;
}

namespace bay {
// BayApp.crashReports (CrashReports in AppModule.swift): Bay's own crashes,
// as telemetry reads them. Only the browser process's: a page or GPU crash
// isn't Bay's. A minidump has no symbols, so a report names what crashed (the
// signal or exception) and the module it crashed in, by offset.
std::optional<base::DictValue> CrashReportFor(
    const crashpad::ProcessSnapshot& snapshot,
    const std::string& id,
    time_t created);

// The last five browser-process crashes after `since` (ms since the epoch),
// oldest first, from Crashpad's database at `database`. Blocking.
base::ListValue CrashReportsSince(const base::FilePath& database, double since);

// The same off the UI thread, from this process's Crashpad database; empty
// when Crashpad isn't running.
void ListCrashReports(double since,
                      base::OnceCallback<void(base::Value)> done);
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_CRASH_REPORTS_H_
