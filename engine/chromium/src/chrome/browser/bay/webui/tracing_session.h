// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_TRACING_SESSION_H_
#define CHROME_BROWSER_BAY_WEBUI_TRACING_SESSION_H_

#include <cstdint>
#include <optional>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/timer/timer.h"

namespace content {
class TracingController;
}
namespace bay {
// One browser-process recorder, shared by all trusted hosts. A host may stop
// only the recording it began; an unrelated DevTools trace is never stopped.
class TracingSession {
 public:
  using Started = base::OnceCallback<void(bool)>;
  using Saved = base::OnceCallback<void(std::optional<base::FilePath>)>;
  static TracingSession& Get();
  // Controller injection exercises the real lifecycle and streaming endpoint.
  explicit TracingSession(content::TracingController* controller = nullptr);
  ~TracingSession();
  void Begin(const void* owner, Started reply);
  void End(const void* owner, bool keep, Saved reply);
  bool IsTracing();
  void OwnerGone(const void* owner);

 private:
  enum class Phase { kIdle, kStarting, kRecording, kStopping };
  content::TracingController* Controller();
  void StartedTracing(uint64_t generation);
  void StoppedTracing(uint64_t generation, base::FilePath path, bool success);
  void Watch(uint64_t generation);
  void Reset();

  raw_ptr<content::TracingController> controller_;
  raw_ptr<const void> owner_ = nullptr;
  Phase phase_ = Phase::kIdle;
  uint64_t generation_ = 0;
  int checks_ = 0;
  bool keep_ = false;
  Started started_reply_;
  Saved saved_reply_;
  base::RepeatingTimer watch_;
  base::WeakPtrFactory<TracingSession> weak_factory_{this};
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_TRACING_SESSION_H_
