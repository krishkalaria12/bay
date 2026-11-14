// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_CRASH_REPORTS_H_
#define CHROME_BROWSER_BAY_WEBUI_CRASH_REPORTS_H_

#include <cstdint>
#include <ctime>
#include <optional>
#include <string>
#include <vector>

#include "base/containers/span.h"
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
// signal or exception) and each frame by module and offset, which the release's
// symbols turn into names (docs/releasing.md). Linux builds keep frame pointers,
// so a report has its stack; Windows x64 builds don't, so one has the crashing
// frame alone.
std::optional<base::DictValue> CrashReportFor(
    const crashpad::ProcessSnapshot& snapshot,
    const std::string& id,
    time_t created);

// The last five browser-process crashes after `since` (ms since the epoch),
// oldest first, from Crashpad's database at `database`. Blocking.
// The return addresses a frame-pointer chain leaves in `stack`, the memory
// copied from `base` upwards, starting at `frame_pointer`, innermost first and
// at most `limit`. Stops wherever the chain leaves the stack or doesn't climb.
std::vector<uint64_t> WalkFramePointers(base::span<const uint8_t> stack,
                                        uint64_t base,
                                        uint64_t frame_pointer,
                                        size_t limit);

base::ListValue CrashReportsSince(const base::FilePath& database, double since);

// The same off the UI thread, from this process's Crashpad database; empty
// when Crashpad isn't running.
void ListCrashReports(double since,
                      base::OnceCallback<void(base::Value)> done);
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_CRASH_REPORTS_H_
