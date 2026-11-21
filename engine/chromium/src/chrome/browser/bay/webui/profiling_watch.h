// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_PROFILING_WATCH_H_
#define CHROME_BROWSER_BAY_WEBUI_PROFILING_WATCH_H_

#include "base/functional/callback.h"
#include "base/trace_event/trace_session_observer.h"

namespace bay {
// Whether a trace that records the documents' timings is running: Help ›
// Record Performance Issue, DevTools or a CDP client (the bay command), or a
// --trace-startup launch. The Bay documents add their User Timing measures
// only meanwhile (packages/platform/src/profiling.ts), so they cost nothing
// otherwise. Observes on the sequence that creates it, the UI thread.
class ProfilingWatch final : public base::trace_event::TraceSessionObserver {
 public:
  using Changed = base::RepeatingCallback<void(bool)>;
  static ProfilingWatch& Get();
  ProfilingWatch();
  ~ProfilingWatch() override;
  ProfilingWatch(const ProfilingWatch&) = delete;
  ProfilingWatch& operator=(const ProfilingWatch&) = delete;

  // The trace records the documents' timings now.
  static bool Recording();
  bool active() const { return active_; }
  // Called with the new state whenever it changes.
  void SetChanged(Changed changed);

  // base::trace_event::TraceSessionObserver:
  void OnStart(const perfetto::DataSourceBase::StartArgs& args) override;
  void OnStop(const perfetto::DataSourceBase::StopArgs& args) override;

 private:
  void Set(bool active);

  bool active_ = false;
  Changed changed_;
};
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_PROFILING_WATCH_H_
