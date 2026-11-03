// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/crash_reports.h"

#include <algorithm>
#include <cstdint>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/task/thread_pool.h"
#include "build/build_config.h"
#include "components/crash/core/app/crashpad.h"
#include "third_party/crashpad/crashpad/client/annotation.h"
#include "third_party/crashpad/crashpad/client/crash_report_database.h"
#include "third_party/crashpad/crashpad/snapshot/exception_snapshot.h"
#include "third_party/crashpad/crashpad/snapshot/minidump/process_snapshot_minidump.h"
#include "third_party/crashpad/crashpad/snapshot/module_snapshot.h"
#include "third_party/crashpad/crashpad/snapshot/process_snapshot.h"
#include "third_party/crashpad/crashpad/util/file/file_reader.h"

namespace bay {
namespace {
// Reports opened looking for Bay's own, at most; and kept.
constexpr size_t kOpened = 20;
constexpr size_t kKept = 5;

// What the exception code means where the dump was written: a signal on
// Linux, an NTSTATUS on Windows. Names telemetry accepts (SYSTEM_NAME).
const char* ExceptionName(uint32_t code) {
#if BUILDFLAG(IS_WIN)
  switch (code) {
    case 0xC0000005:
      return "EXCEPTION_ACCESS_VIOLATION";
    case 0x80000003:
      return "EXCEPTION_BREAKPOINT";
    case 0xC000001D:
      return "EXCEPTION_ILLEGAL_INSTRUCTION";
    case 0xC0000094:
      return "EXCEPTION_INT_DIVIDE_BY_ZERO";
    case 0xC00000FD:
      return "EXCEPTION_STACK_OVERFLOW";
    case 0xC0000409:
      return "EXCEPTION_STACK_BUFFER_OVERRUN";
    case 0xC0000374:
      return "EXCEPTION_HEAP_CORRUPTION";
  }
#else
  switch (code) {
    case 4:
      return "SIGILL";
    case 5:
      return "SIGTRAP";
    case 6:
      return "SIGABRT";
    case 7:
      return "SIGBUS";
    case 8:
      return "SIGFPE";
    case 11:
      return "SIGSEGV";
  }
#endif
  return "Crash";
}

// Chromium names each process's type ("ptype") in an annotation.
std::optional<std::string> ProcessType(
    const crashpad::ProcessSnapshot& snapshot) {
  const auto& simple = snapshot.AnnotationsSimpleMap();
  if (const auto found = simple.find("ptype"); found != simple.end())
    return found->second;
  for (const auto* module : snapshot.Modules()) {
    for (const auto& annotation : module->AnnotationObjects()) {
      if (annotation.name == "ptype" &&
          annotation.type ==
              static_cast<uint16_t>(crashpad::Annotation::Type::kString)) {
        return std::string(annotation.value.begin(), annotation.value.end());
      }
    }
    for (const auto& [key, value] : module->AnnotationsSimpleMap()) {
      if (key == "ptype")
        return value;
    }
  }
  return std::nullopt;
}

std::string BaseName(const std::string& path) {
  const size_t slash = path.find_last_of("/\\");
  return slash == std::string::npos ? path : path.substr(slash + 1);
}
}  // namespace

std::optional<base::DictValue> CrashReportFor(
    const crashpad::ProcessSnapshot& snapshot,
    const std::string& id,
    time_t created) {
  const auto* exception = snapshot.Exception();
  if (!exception || ProcessType(snapshot) != "browser")
    return std::nullopt;
  const uint64_t address = exception->ExceptionAddress();
  base::DictValue frame;
  frame.Set("image", "???");
  for (const auto* module : snapshot.Modules()) {
    if (address >= module->Address() &&
        address - module->Address() < module->Size()) {
      frame.Set("image", BaseName(module->Name()));
      frame.Set("offset", static_cast<double>(address - module->Address()));
      break;
    }
  }
  return base::DictValue()
      .Set("incidentId", id)
      .Set("time", static_cast<double>(created) * 1000)
      .Set("exceptionType", ExceptionName(exception->Exception()))
      .Set("frames", base::ListValue().Append(std::move(frame)));
}

base::ListValue CrashReportsSince(const base::FilePath& database_path,
                                  double since) {
  base::ListValue result;
  auto database =
      crashpad::CrashReportDatabase::InitializeWithoutCreating(database_path);
  if (!database)
    return result;
  std::vector<crashpad::CrashReportDatabase::Report> reports;
  std::vector<crashpad::CrashReportDatabase::Report> completed;
  database->GetPendingReports(&reports);
  database->GetCompletedReports(&completed);
  reports.insert(reports.end(), completed.begin(), completed.end());
  std::erase_if(reports, [&](const auto& report) {
    return static_cast<double>(report.creation_time) * 1000 <= since;
  });
  std::ranges::sort(reports, std::ranges::greater(),
                    &crashpad::CrashReportDatabase::Report::creation_time);
  std::vector<base::DictValue> kept;
  for (size_t i = 0; i < reports.size() && i < kOpened && kept.size() < kKept;
       ++i) {
    crashpad::FileReader reader;
    crashpad::ProcessSnapshotMinidump snapshot;
    if (!reader.Open(reports[i].file_path) || !snapshot.Initialize(&reader))
      continue;
    if (auto report = CrashReportFor(snapshot, reports[i].uuid.ToString(),
                                     reports[i].creation_time)) {
      kept.push_back(std::move(*report));
    }
  }
  for (auto it = kept.rbegin(); it != kept.rend(); ++it)
    result.Append(std::move(*it));
  return result;
}

void ListCrashReports(double since,
                      base::OnceCallback<void(base::Value)> done) {
  const auto database = crash_reporter::GetCrashpadDatabasePath();
  if (!database) {
    std::move(done).Run(base::Value(base::ListValue()));
    return;
  }
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::BEST_EFFORT},
      base::BindOnce(
          [](base::FilePath database, double since) {
            return base::Value(CrashReportsSince(database, since));
          },
          *database, since),
      std::move(done));
}
}  // namespace bay
