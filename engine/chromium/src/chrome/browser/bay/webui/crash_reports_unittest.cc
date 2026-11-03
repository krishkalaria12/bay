// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/crash_reports.h"

#include <memory>
#include <utility>

#include "base/files/scoped_temp_dir.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/crashpad/crashpad/client/annotation.h"
#include "third_party/crashpad/crashpad/snapshot/test/test_exception_snapshot.h"
#include "third_party/crashpad/crashpad/snapshot/test/test_module_snapshot.h"
#include "third_party/crashpad/crashpad/snapshot/test/test_process_snapshot.h"

namespace bay {
namespace {
std::unique_ptr<crashpad::test::TestProcessSnapshot> Crash(
    const std::string& process_type,
    uint32_t code,
    uint64_t address) {
  auto snapshot = std::make_unique<crashpad::test::TestProcessSnapshot>();
  auto module = std::make_unique<crashpad::test::TestModuleSnapshot>();
  module->SetName("/opt/bay/libbay_core.so");
  module->SetAddressAndSize(0x1000, 0x500);
  const std::string type = process_type;
  module->SetAnnotationObjects(
      {crashpad::AnnotationSnapshot(
          "ptype", static_cast<uint16_t>(crashpad::Annotation::Type::kString),
          std::vector<uint8_t>(type.begin(), type.end()))});
  snapshot->AddModule(std::move(module));
  auto exception = std::make_unique<crashpad::test::TestExceptionSnapshot>();
  exception->SetException(code);
  exception->SetExceptionAddress(address);
  snapshot->SetException(std::move(exception));
  return snapshot;
}

TEST(CrashReportsTest, ABrowserCrashNamesItsExceptionAndModule) {
#if BUILDFLAG(IS_WIN)
  const uint32_t code = 0xC0000005;
  const char* name = "EXCEPTION_ACCESS_VIOLATION";
#else
  const uint32_t code = 11;
  const char* name = "SIGSEGV";
#endif
  const auto report = CrashReportFor(*Crash("browser", code, 0x1234), "id", 7);
  ASSERT_TRUE(report);
  EXPECT_EQ(*report->FindString("incidentId"), "id");
  EXPECT_EQ(*report->FindDouble("time"), 7000);
  EXPECT_EQ(*report->FindString("exceptionType"), name);
  const auto* frames = report->FindList("frames");
  ASSERT_TRUE(frames && frames->size() == 1u);
  EXPECT_EQ(*(*frames)[0].GetDict().FindString("image"), "libbay_core.so");
  EXPECT_EQ(*(*frames)[0].GetDict().FindDouble("offset"), 0x234);
}
TEST(CrashReportsTest, AnUnknownAddressOrCodeStillReports) {
  const auto report =
      CrashReportFor(*Crash("browser", 0x12345, 0x9000), "id", 1);
  ASSERT_TRUE(report);
  EXPECT_EQ(*report->FindString("exceptionType"), "Crash");
  const auto& frame = (*report->FindList("frames"))[0].GetDict();
  EXPECT_EQ(*frame.FindString("image"), "???");
  EXPECT_FALSE(frame.FindDouble("offset"));
}
TEST(CrashReportsTest, OnlyTheBrowserProcessCounts) {
  EXPECT_FALSE(CrashReportFor(*Crash("renderer", 11, 0x1234), "id", 1));
  EXPECT_FALSE(CrashReportFor(*Crash("gpu-process", 11, 0x1234), "id", 1));
  crashpad::test::TestProcessSnapshot no_exception;
  EXPECT_FALSE(CrashReportFor(no_exception, "id", 1));
}
TEST(CrashReportsTest, AMissingDatabaseHasNoReports) {
  base::ScopedTempDir temp;
  ASSERT_TRUE(temp.CreateUniqueTempDir());
  EXPECT_TRUE(
      CrashReportsSince(temp.GetPath().Append("missing"), 0).empty());
}
}  // namespace
}  // namespace bay
