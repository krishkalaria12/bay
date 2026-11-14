// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/tracing_session.h"

#include <memory>
#include <string>
#include <utility>

#include "base/files/file_util.h"
#include "base/path_service.h"
#include "base/test/scoped_path_override.h"
#include "base/test/task_environment.h"
#include "base/test/test_future.h"
#include "base/trace_event/trace_config.h"
#include "chrome/common/chrome_paths.h"
#include "content/public/browser/tracing_controller.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
namespace {
class FakeTracingController : public content::TracingController {
 public:
  bool GetCategories(GetCategoriesDoneCallback) override { return false; }
  bool GetTrackEventDescriptor(GetTrackEventDescriptorDoneCallback) override {
    return false;
  }
  bool GetTraceBufferUsage(GetTraceBufferUsageCallback) override {
    return false;
  }
  bool IsTracing() override { return active; }
  bool StopTracing(const scoped_refptr<TraceDataEndpoint>& result) override {
    ++stops;
    if (!accept_stop)
      return false;
    endpoint = result;
    if (!endpoint)
      active = false;
    return true;
  }
  bool StopTracing(const scoped_refptr<TraceDataEndpoint>& result,
                   const std::string&) override {
    return StopTracing(result);
  }
  void Started() { std::move(started).Run(); }
  void Complete(std::string data = R"({"traceEvents":[]})") {
    auto result = std::move(endpoint);
    if (result) {
      result->ReceiveTraceChunk(std::make_unique<std::string>(std::move(data)));
      result->ReceivedTraceFinalContents();
    }
    active = false;
  }
  bool active = false;
  bool accept_start = true;
  bool accept_stop = true;
  int starts = 0;
  int stops = 0;
  base::OnceClosure started;
  scoped_refptr<TraceDataEndpoint> endpoint;

 private:
  bool StartTracingImpl(const base::trace_event::TraceConfig&,
                        StartTracingDoneCallback callback,
                        bool) override {
    ++starts;
    if (!accept_start)
      return false;
    active = true;
    started = std::move(callback);
    return true;
  }
};

class TracingSessionTest : public testing::Test {
 protected:
  void Start() {
    base::test::TestFuture<bool> start;
    session.Begin(&owner, start.GetCallback());
    ASSERT_FALSE(start.IsReady());
    controller.Started();
    EXPECT_TRUE(start.Get());
  }
  base::test::TaskEnvironment tasks{
      base::test::TaskEnvironment::TimeSource::MOCK_TIME};
  base::ScopedPathOverride downloads{chrome::DIR_DEFAULT_DOWNLOADS};
  FakeTracingController controller;
  TracingSession session{&controller};
  int owner = 1;
  int other = 2;
};

TEST_F(TracingSessionTest,
       StartAndDiscardWaitForCompletionWithoutWritingAFile) {
  Start();
  EXPECT_TRUE(session.IsTracing());
  base::test::TestFuture<bool> duplicate;
  session.Begin(&other, duplicate.GetCallback());
  EXPECT_FALSE(duplicate.Get());
  base::test::TestFuture<std::optional<base::FilePath>> stop;
  session.End(&owner, false, stop.GetCallback());
  EXPECT_FALSE(stop.IsReady());
  controller.Complete();
  tasks.RunUntilIdle();
  EXPECT_FALSE(stop.Get().has_value());
  EXPECT_FALSE(session.IsTracing());
  EXPECT_TRUE(base::IsDirectoryEmpty(
      base::PathService::CheckedGet(chrome::DIR_DEFAULT_DOWNLOADS)));
}

TEST_F(TracingSessionTest, SavedTraceContainsEveryChunkInDownloads) {
  Start();
  base::test::TestFuture<std::optional<base::FilePath>> stop;
  session.End(&owner, true, stop.GetCallback());
  controller.endpoint->ReceiveTraceChunk(
      std::make_unique<std::string>("{\"traceEvents\":["));
  controller.Complete("{\"name\":\"work\"}]}");
  tasks.RunUntilIdle();
  ASSERT_TRUE(stop.Get().has_value());
  const auto path = *stop.Get();
  EXPECT_EQ(path.DirName(),
            base::PathService::CheckedGet(chrome::DIR_DEFAULT_DOWNLOADS));
  EXPECT_EQ(path.Extension(), FILE_PATH_LITERAL(".json"));
  std::string data;
  ASSERT_TRUE(base::ReadFileToString(path, &data));
  EXPECT_EQ(data, R"({"traceEvents":[{"name":"work"}]})");
}

TEST_F(TracingSessionTest, OtherHostAndForeignTracingCannotBeStopped) {
  controller.active = true;
  base::test::TestFuture<bool> foreign;
  session.Begin(&owner, foreign.GetCallback());
  EXPECT_FALSE(foreign.Get());
  base::test::TestFuture<std::optional<base::FilePath>> no_owner;
  session.End(&owner, false, no_owner.GetCallback());
  EXPECT_FALSE(no_owner.Get().has_value());
  EXPECT_EQ(controller.stops, 0);
  controller.active = false;
  Start();
  base::test::TestFuture<std::optional<base::FilePath>> wrong_owner;
  session.End(&other, false, wrong_owner.GetCallback());
  EXPECT_FALSE(wrong_owner.Get().has_value());
  EXPECT_EQ(controller.stops, 0);
}

TEST_F(TracingSessionTest, FailedStartAndTimeoutAllowAnotherAttempt) {
  controller.accept_start = false;
  base::test::TestFuture<bool> rejected;
  session.Begin(&owner, rejected.GetCallback());
  EXPECT_FALSE(rejected.Get());
  controller.accept_start = true;
  base::test::TestFuture<bool> timed_out;
  session.Begin(&owner, timed_out.GetCallback());
  auto old_ack = std::move(controller.started);
  tasks.FastForwardBy(base::Seconds(11));
  EXPECT_FALSE(timed_out.Get());
  EXPECT_EQ(controller.stops, 1);
  Start();
  std::move(old_ack).Run();
  EXPECT_TRUE(session.IsTracing());
  EXPECT_EQ(controller.stops, 1);
}

TEST_F(TracingSessionTest, EndingDuringStartupAnswersStartExactlyOnce) {
  base::test::TestFuture<bool> starting;
  session.Begin(&owner, starting.GetCallback());
  base::test::TestFuture<std::optional<base::FilePath>> stop;
  session.End(&owner, false, stop.GetCallback());
  EXPECT_FALSE(starting.Get());
  controller.Started();
  controller.Complete();
  tasks.RunUntilIdle();
  EXPECT_FALSE(stop.Get().has_value());
  EXPECT_FALSE(session.IsTracing());
}

TEST_F(TracingSessionTest, ClosingOwnerDiscardsAnOutputAlreadyBeingWritten) {
  Start();
  base::test::TestFuture<std::optional<base::FilePath>> stop;
  session.End(&owner, true, stop.GetCallback());
  session.OwnerGone(&owner);
  controller.Complete();
  tasks.RunUntilIdle();
  EXPECT_FALSE(stop.Get().has_value());
  EXPECT_TRUE(base::IsDirectoryEmpty(
      base::PathService::CheckedGet(chrome::DIR_DEFAULT_DOWNLOADS)));
}

TEST_F(TracingSessionTest, WriteFailureAndStopFailureNeverReturnAPath) {
  Start();
  // The directory override points at a file, so output creation fails.
  const auto folder =
      base::PathService::CheckedGet(chrome::DIR_DEFAULT_DOWNLOADS);
  ASSERT_TRUE(base::DeletePathRecursively(folder));
  ASSERT_TRUE(base::WriteFile(folder, "blocked"));
  base::test::TestFuture<std::optional<base::FilePath>> failed;
  session.End(&owner, true, failed.GetCallback());
  controller.Complete();
  tasks.RunUntilIdle();
  EXPECT_FALSE(failed.Get().has_value());
  Start();
  controller.accept_stop = false;
  base::test::TestFuture<std::optional<base::FilePath>> rejected;
  session.End(&owner, true, rejected.GetCallback());
  EXPECT_FALSE(rejected.Get().has_value());
  tasks.RunUntilIdle();
}

TEST_F(TracingSessionTest, StopTimeoutCleansLateFileAndProtectsNextRecording) {
  Start();
  base::test::TestFuture<std::optional<base::FilePath>> stop;
  session.End(&owner, true, stop.GetCallback());
  tasks.FastForwardBy(base::Seconds(31));
  EXPECT_FALSE(stop.Get().has_value());
  base::test::TestFuture<bool> busy;
  session.Begin(&other, busy.GetCallback());
  EXPECT_FALSE(busy.Get());
  controller.Complete();
  tasks.RunUntilIdle();
  EXPECT_TRUE(base::IsDirectoryEmpty(
      base::PathService::CheckedGet(chrome::DIR_DEFAULT_DOWNLOADS)));
  Start();
}
}  // namespace
}  // namespace bay
