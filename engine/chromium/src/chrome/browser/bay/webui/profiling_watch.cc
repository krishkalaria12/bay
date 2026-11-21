// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/profiling_watch.h"

#include <utility>

#include "base/no_destructor.h"
#include "base/trace_event/trace_event.h"

namespace bay {
namespace {
// What the documents' measures are written as.
constexpr char kCategory[] = "blink.user_timing";
}  // namespace

ProfilingWatch& ProfilingWatch::Get() {
  static base::NoDestructor<ProfilingWatch> watch;
  return *watch;
}
ProfilingWatch::ProfilingWatch() {
  base::trace_event::TraceSessionObserverList::AddObserver(this);
  // A startup trace began before this observer.
  active_ = Recording();
}
ProfilingWatch::~ProfilingWatch() {
  base::trace_event::TraceSessionObserverList::RemoveObserver(this);
}
// static
bool ProfilingWatch::Recording() {
  return TRACE_EVENT_CATEGORY_ENABLED(kCategory);
}
void ProfilingWatch::SetChanged(Changed changed) {
  changed_ = std::move(changed);
}
void ProfilingWatch::OnStart(const perfetto::DataSourceBase::StartArgs&) {
  Set(Recording());
}
void ProfilingWatch::OnStop(const perfetto::DataSourceBase::StopArgs& args) {
  // Another session may still record the category.
  Set(base::trace_event::IsCategoryEnabledOnStop(
      PERFETTO_GET_CATEGORY_INDEX(kCategory), args));
}
void ProfilingWatch::Set(bool active) {
  if (active == active_)
    return;
  active_ = active;
  if (changed_)
    changed_.Run(active);
}
}  // namespace bay
