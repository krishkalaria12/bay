// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/nn_external_apps.h"

#include <utility>

#include "chrome/common/pref_names.h"
#include "components/prefs/pref_service.h"
#include "components/prefs/scoped_user_pref_update.h"

namespace bay {
base::DictValue AppForScheme(const std::string& scheme);
namespace {
const char* const kPairs = prefs::kProtocolHandlerPerOriginAllowedProtocols;
}  // namespace
}  // namespace bay

NN_ENGINE_CALL(nn_external_apps_allowances) {
  bay::Call call(profile_dir, args_json, reply, context);
  if (!call) return;
  base::ListValue allowances;
  for (const auto [origin, schemes] : call.profile()->GetPrefs()->GetDict(bay::kPairs)) {
    if (!schemes.is_dict()) continue;
    for (const auto [scheme, allowed] : schemes.GetDict()) {
      if (allowed.is_bool() && allowed.GetBool()) {
        allowances.Append(bay::AppForScheme(scheme)
                              .Set("origin", origin).Set("scheme", scheme));
      }
    }
  }
  call.TakeReply().Send(base::DictValue().Set("allowances", std::move(allowances)));
}

NN_ENGINE_CALL(nn_external_apps_remove) {
  bay::Call call(profile_dir, args_json, reply, context);
  if (!call) return;
  const std::string origin = call.String("origin");
  const std::string scheme = call.String("scheme");
  if (origin.empty() || scheme.empty()) {
    return call.TakeReply().Error("origin and scheme required");
  }
  ScopedDictPrefUpdate pairs(call.profile()->GetPrefs(), bay::kPairs);
  if (base::DictValue* schemes = pairs->FindDict(origin)) {
    schemes->Remove(scheme);
    if (schemes->empty()) pairs->Remove(origin);
  }
  call.TakeReply().Ok();
}
