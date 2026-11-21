// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/crash_reports.h"

#include <algorithm>
#include <cstdint>
#include <utility>
#include <vector>

#include "base/compiler_specific.h"
#include "base/functional/bind.h"
#include "base/numerics/byte_conversions.h"
#include "base/task/thread_pool.h"
#include "build/build_config.h"
#include "components/crash/core/app/crashpad.h"
#include "third_party/crashpad/crashpad/client/annotation.h"
#include "third_party/crashpad/crashpad/client/crash_report_database.h"
#include "third_party/crashpad/crashpad/snapshot/cpu_context.h"
#include "third_party/crashpad/crashpad/snapshot/exception_snapshot.h"
#include "third_party/crashpad/crashpad/snapshot/memory_snapshot.h"
#include "third_party/crashpad/crashpad/snapshot/minidump/process_snapshot_minidump.h"
#include "third_party/crashpad/crashpad/snapshot/module_snapshot.h"
#include "third_party/crashpad/crashpad/snapshot/process_snapshot.h"
#include "third_party/crashpad/crashpad/snapshot/thread_snapshot.h"
#include "third_party/crashpad/crashpad/util/file/file_reader.h"

namespace bay {
namespace {
// Reports opened looking for Bay's own, at most; and kept.
constexpr size_t kOpened = 20;
constexpr size_t kKept = 5;
// As many frames as a macOS report sends (nativeFrames in telemetry).
constexpr size_t kMaxFrames = 64;

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

base::DictValue FrameAt(const crashpad::ProcessSnapshot& snapshot,
                        uint64_t address) {
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
  return frame;
}

class StackCopy final : public crashpad::MemorySnapshot::Delegate {
 public:
  bool MemorySnapshotDelegateRead(void* data, size_t size) override {
    const auto* bytes = static_cast<const uint8_t*>(data);
    // SAFETY: the snapshot gives `size` readable bytes at `data`.
    bytes_.assign(bytes, UNSAFE_TODO(bytes + size));
    return true;
  }
  const std::vector<uint8_t>& bytes() const { return bytes_; }

 private:
  std::vector<uint8_t> bytes_;
};

// The crashing thread's frame pointer, where this build's CPU has a fixed one.
std::optional<uint64_t> FramePointer(const crashpad::CPUContext& context) {
  switch (context.architecture) {
    case crashpad::kCPUArchitectureX86_64:
      return context.x86_64->rbp;
    case crashpad::kCPUArchitectureARM64:
      return context.arm64->regs[29];
    default:
      return std::nullopt;
  }
}

std::vector<uint64_t> CallersOf(const crashpad::ProcessSnapshot& snapshot,
                                const crashpad::ExceptionSnapshot& exception) {
  const auto* context = exception.Context();
  const auto frame_pointer =
      context ? FramePointer(*context) : std::optional<uint64_t>();
  if (!frame_pointer)
    return {};
  for (const auto* thread : snapshot.Threads()) {
    const auto* stack = thread->Stack();
    if (thread->ThreadID() != exception.ThreadID() || !stack)
      continue;
    StackCopy copy;
    if (!stack->Read(&copy))
      return {};
    return WalkFramePointers(copy.bytes(), stack->Address(), *frame_pointer,
                             kMaxFrames - 1);
  }
  return {};
}
}  // namespace

std::optional<base::DictValue> CrashReportFor(
    const crashpad::ProcessSnapshot& snapshot,
    const std::string& id,
    time_t created) {
  const auto* exception = snapshot.Exception();
  if (!exception || ProcessType(snapshot) != "browser")
    return std::nullopt;
  base::ListValue frames;
  frames.Append(FrameAt(snapshot, exception->ExceptionAddress()));
  for (uint64_t address : CallersOf(snapshot, *exception))
    frames.Append(FrameAt(snapshot, address));
  return base::DictValue()
      .Set("incidentId", id)
      .Set("time", static_cast<double>(created) * 1000)
      .Set("exceptionType", ExceptionName(exception->Exception()))
      .Set("frames", std::move(frames));
}

std::vector<uint64_t> WalkFramePointers(base::span<const uint8_t> stack,
                                        uint64_t base,
                                        uint64_t frame_pointer,
                                        size_t limit) {
  std::vector<uint64_t> addresses;
  const auto read = [&](uint64_t at) {
    return base::U64FromNativeEndian(
        stack.subspan(static_cast<size_t>(at - base)).first<8u>());
  };
  while (addresses.size() < limit && frame_pointer >= base &&
         frame_pointer % 8 == 0 && frame_pointer - base + 16 <= stack.size()) {
    const uint64_t next = read(frame_pointer);
    const uint64_t caller = read(frame_pointer + 8);
    if (!caller)
      break;
    addresses.push_back(caller);
    // The stack grows down, so a caller's frame is always above: this also
    // ends a corrupted chain that loops.
    if (next <= frame_pointer)
      break;
    frame_pointer = next;
  }
  return addresses;
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
