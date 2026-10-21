// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_RUNTIME_STATE_H_
#define CHROME_BROWSER_BAY_WEBUI_RUNTIME_STATE_H_

#include <map>
#include <optional>
#include <string>
#include <vector>
#include "base/values.h"

namespace bay {
// A complete, versioned BrowserProjection. Unknown top-level fields fail closed
// so new private state cannot silently bypass the per-window projection.
bool IsRuntimeState(const base::DictValue& state);
std::optional<double> RuntimeInteger(const base::DictValue& value,
                                     const char* key);
enum class RuntimeRequestStatus { kAccepted, kInvalid, kStaleEpoch, kExpired };
RuntimeRequestStatus ValidateRuntimeRequest(const base::DictValue& request,
                                            const std::string& epoch,
                                            double last_request_id);
bool IsRuntimeCommit(const base::DictValue& commit,
                     const std::string& epoch,
                     double expected_revision);
enum class RuntimeResultKind { kNone, kRequiredId, kOptionalId, kBoolean, kGithub, kSync, kFolder, kImport };
RuntimeResultKind RuntimeCommandResultKind(const base::DictValue& command);
bool IsRuntimeReply(const base::DictValue& reply,
                    const std::string& epoch,
                    double minimum_revision,
                    double accepted_revision,
                    RuntimeResultKind result_kind);
std::optional<base::DictValue> ProjectRuntimeState(
    const base::DictValue& state,
    const std::string& window_id);
// Checks an authenticated window's command against the accepted full state.
// Reducer-level validation still runs inside the coordinator.
bool CanDispatchRuntimeCommand(const base::DictValue& state,
                               const std::string& window_id,
                               const base::DictValue& command);
// Native page identity is checked against accepted state independently of a
// renderer mount lease or the tab's current public-window owner.
bool CanAcceptRuntimePageEvent(const base::DictValue& state,
                               const std::string& tab_id,
                               const std::string& profile);

bool CanMountRuntimePage(const base::DictValue& state,
                         const std::string& window_id,
                         const std::string& tab_id,
                         const std::string& profile);

// A native offer can name one accepted, owned destination only. Public profile
// names are Chrome profile ids; private profiles receive the target window id.
struct RuntimePageOpenTarget {
  std::string tab_id;
  std::string window_id;
  std::string profile;
};
std::optional<RuntimePageOpenTarget> FindRuntimePageOpenTarget(
    const base::DictValue& state,
    const std::string& offer_id,
    const std::string& profile,
    bool incognito);
bool CanMountRuntimePageOffer(const base::DictValue& state,
                              const std::string& tab_id,
                              const std::string& adopt_id);

// Bounded latest facts survive coordinator replacement. Sequence numbers are
// browser-owned and remain monotonic across epochs and page remounts.
class RuntimePageEventCache {
 public:
  static constexpr size_t kMaximumTabs = 2048;
  std::optional<base::DictValue> Record(const base::DictValue& state,
                                        const std::string& tab_id,
                                        const std::string& profile,
                                        int browser_id,
                                        const char* event,
                                        base::DictValue payload);
  std::vector<base::DictValue> Replay(const base::DictValue& state);
  void Prune(const base::DictValue& state);
  void Remove(const std::string& tab_id);

 private:
  struct Fact {
    base::DictValue envelope;
    size_t bytes = 0;
  };
  std::map<std::string, std::map<std::string, Fact>> facts_;
  size_t bytes_ = 0;
  double sequence_ = 0;
};
}  // namespace bay
#endif
