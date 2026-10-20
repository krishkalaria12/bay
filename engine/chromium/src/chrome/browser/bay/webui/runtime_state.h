// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_RUNTIME_STATE_H_
#define CHROME_BROWSER_BAY_WEBUI_RUNTIME_STATE_H_

#include <optional>
#include <string>
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
enum class RuntimeResultKind { kNone, kRequiredId, kOptionalId };
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
}  // namespace bay
#endif
