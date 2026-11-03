// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/tracing_session.h"

#include <memory>
#include <string>
#include <utility>

#include "base/containers/span.h"
#include "base/files/file.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/strings/stringprintf.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/threading/sequence_bound.h"
#include "base/time/time.h"
#include "base/trace_event/trace_config.h"
#include "base/uuid.h"
#include "chrome/common/chrome_paths.h"
#include "content/public/browser/tracing_controller.h"

namespace bay {
namespace {
constexpr auto kPollInterval = base::Milliseconds(100);
constexpr int kStartChecks = 100;
constexpr int kStopChecks = 300;

void DeleteTrace(base::FilePath path) {
  if (!path.empty())
    base::ThreadPool::PostTask(
        FROM_HERE, {base::MayBlock()},
        base::BindOnce(base::IgnoreResult(&base::DeleteFile), std::move(path)));
}

// All file operations run on a worker sequence; trace chunks are never joined
// into an in-memory copy. Unfinished and failed output is removed on that same
// sequence, including when StopTracing rejects its endpoint.
class TraceWriter {
 public:
  explicit TraceWriter(base::FilePath path) : path_(std::move(path)) {
    if (base::CreateDirectory(path_.DirName()))
      file_.Initialize(path_, base::File::FLAG_CREATE | base::File::FLAG_WRITE);
    ok_ = file_.IsValid();
    owns_file_ = ok_;
  }
  ~TraceWriter() {
    file_.Close();
    if (owns_file_ && !finished_)
      base::DeleteFile(path_);
  }
  void Write(std::string chunk) {
    if (ok_)
      ok_ = file_.WriteAtCurrentPosAndCheck(base::as_byte_span(chunk));
  }
  bool Finish() {
    finished_ = ok_ && file_.GetLength() > 0 && file_.Flush();
    file_.Close();
    if (owns_file_ && !finished_)
      base::DeleteFile(path_);
    return finished_;
  }

 private:
  base::FilePath path_;
  base::File file_;
  bool owns_file_ = false;
  bool ok_ = false;
  bool finished_ = false;
};

class TraceEndpoint : public content::TracingController::TraceDataEndpoint {
 public:
  TraceEndpoint(base::FilePath path, base::OnceCallback<void(bool)> done)
      : done_(std::move(done)) {
    if (!path.empty())
      writer_.emplace(base::ThreadPool::CreateSequencedTaskRunner(
                          {base::MayBlock(), base::TaskPriority::USER_VISIBLE}),
                      std::move(path));
  }
  void ReceiveTraceChunk(std::unique_ptr<std::string> chunk) override {
    if (writer_ && done_)
      writer_->AsyncCall(&TraceWriter::Write).WithArgs(std::move(*chunk));
  }
  void ReceivedTraceFinalContents() override {
    if (!done_)
      return;
    if (writer_)
      writer_->AsyncCall(&TraceWriter::Finish).Then(std::move(done_));
    else
      // Chrome resets its own tracing state after calling this endpoint.
      base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(std::move(done_), true));
  }

 private:
  ~TraceEndpoint() override = default;
  base::OnceCallback<void(bool)> done_;
  std::optional<base::SequenceBound<TraceWriter>> writer_;
};

base::FilePath TracePath() {
  base::FilePath downloads;
  if (!base::PathService::Get(chrome::DIR_DEFAULT_DOWNLOADS, &downloads) ||
      downloads.empty())
    return {};
  base::Time::Exploded now;
  base::Time::Now().LocalExplode(&now);
  return downloads.AppendASCII(base::StringPrintf(
      "Bay Trace %04d-%02d-%02d at %02d.%02d.%02d-%s.json", now.year, now.month,
      now.day_of_month, now.hour, now.minute, now.second,
      base::Uuid::GenerateRandomV4().AsLowercaseString().c_str()));
}
}  // namespace

TracingSession& TracingSession::Get() {
  static base::NoDestructor<TracingSession> session;
  return *session;
}
TracingSession::TracingSession(content::TracingController* controller)
    : controller_(controller) {}
TracingSession::~TracingSession() {
  watch_.Stop();
  if (phase_ == Phase::kStarting || phase_ == Phase::kRecording)
    Controller()->StopTracing(nullptr);
  if (started_reply_)
    std::move(started_reply_).Run(false);
  if (saved_reply_)
    std::move(saved_reply_).Run(std::nullopt);
}
content::TracingController* TracingSession::Controller() {
  return controller_ ? controller_.get()
                     : content::TracingController::GetInstance();
}
bool TracingSession::IsTracing() {
  const bool active = Controller()->IsTracing();
  if (!active && phase_ == Phase::kRecording)
    Reset();
  return active;
}
void TracingSession::Begin(const void* owner, Started reply) {
  const bool active = IsTracing();
  if (!owner || phase_ != Phase::kIdle || active) {
    std::move(reply).Run(false);
    return;
  }
  phase_ = Phase::kStarting;
  owner_ = owner;
  const auto generation = ++generation_;
  started_reply_ = std::move(reply);
  const auto alive = weak_factory_.GetWeakPtr();
  const bool accepted = Controller()->StartTracing(
      base::trace_event::TraceConfig(),
      base::BindOnce(&TracingSession::StartedTracing, alive, generation));
  if (!alive)
    return;
  if (!accepted) {
    auto failed = std::move(started_reply_);
    Reset();
    if (failed)
      std::move(failed).Run(false);
  } else if (phase_ == Phase::kStarting) {
    checks_ = kStartChecks;
    watch_.Start(
        FROM_HERE, kPollInterval,
        base::BindRepeating(&TracingSession::Watch, alive, generation));
  }
}
void TracingSession::StartedTracing(uint64_t generation) {
  if (generation != generation_ || phase_ != Phase::kStarting)
    return;
  watch_.Stop();
  phase_ = Phase::kRecording;
  std::move(started_reply_).Run(true);
}
void TracingSession::End(const void* owner, bool keep, Saved reply) {
  if (!owner || owner != owner_ ||
      (phase_ != Phase::kStarting && phase_ != Phase::kRecording)) {
    std::move(reply).Run(std::nullopt);
    return;
  }
  watch_.Stop();
  phase_ = Phase::kStopping;
  keep_ = keep;
  saved_reply_ = std::move(reply);
  const auto generation = generation_;
  const auto alive = weak_factory_.GetWeakPtr();
  if (started_reply_)
    std::move(started_reply_).Run(false);
  if (!alive)
    return;
  const base::FilePath path = keep ? TracePath() : base::FilePath();
  if (keep && path.empty())
    keep_ = false;
  auto endpoint = base::MakeRefCounted<TraceEndpoint>(
      path, base::BindOnce(
                [](base::WeakPtr<TracingSession> session, uint64_t generation,
                   base::FilePath path, bool success) {
                  if (session)
                    session->StoppedTracing(generation, std::move(path),
                                            success);
                  else if (success)
                    DeleteTrace(std::move(path));
                },
                alive, generation, path));
  if (!Controller()->StopTracing(endpoint)) {
    StoppedTracing(generation, path, false);
    return;
  }
  if (phase_ == Phase::kStopping) {
    checks_ = kStopChecks;
    watch_.Start(
        FROM_HERE, kPollInterval,
        base::BindRepeating(&TracingSession::Watch, alive, generation));
  }
}
void TracingSession::StoppedTracing(uint64_t generation,
                                    base::FilePath path,
                                    bool success) {
  if (generation != generation_ || phase_ != Phase::kStopping) {
    if (success)
      DeleteTrace(std::move(path));
    return;
  }
  const bool saved = success && keep_ && !path.empty();
  auto reply = std::move(saved_reply_);
  Reset();
  if (!saved && success)
    DeleteTrace(std::move(path));
  std::move(reply).Run(saved ? std::make_optional(path) : std::nullopt);
}
void TracingSession::Watch(uint64_t generation) {
  if (generation != generation_)
    return;
  if (phase_ == Phase::kStarting &&
      (!Controller()->IsTracing() || --checks_ == 0)) {
    auto reply = std::move(started_reply_);
    Reset();
    // Only stop our accepted start, never a newer or external session.
    if (Controller()->IsTracing())
      Controller()->StopTracing(nullptr);
    std::move(reply).Run(false);
  } else if (phase_ == Phase::kStopping && --checks_ == 0) {
    auto reply = std::move(saved_reply_);
    Reset();
    // A late endpoint still cleans its own file; Begin also checks Chrome's
    // state, so the timeout cannot overlap a still-flushing recording.
    std::move(reply).Run(std::nullopt);
  }
}
void TracingSession::OwnerGone(const void* owner) {
  if (owner_ != owner || !owner)
    return;
  if (phase_ == Phase::kStarting || phase_ == Phase::kRecording)
    End(owner, false, base::DoNothing());
  keep_ = false;
  owner_ = nullptr;
}
void TracingSession::Reset() {
  watch_.Stop();
  phase_ = Phase::kIdle;
  owner_ = nullptr;
  keep_ = false;
}
}  // namespace bay
