// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/nn_external_apps.h"

#include <utility>

#include "build/build_config.h"
#include "chrome/browser/bay/nn_external_apps_platform.h"
#include "chrome/common/pref_names.h"
#include "components/prefs/pref_service.h"
#include "components/prefs/scoped_user_pref_update.h"

#if BUILDFLAG(IS_LINUX)
#include "base/functional/bind.h"
#include "base/task/thread_pool.h"
#endif

namespace bay {
namespace {
const char* const kPairs = prefs::kProtocolHandlerPerOriginAllowedProtocols;

base::ListValue ResolveAllowances(base::ListValue allowances) {
  for (auto& allowance : allowances) {
    auto& entry = allowance.GetDict();
    entry.Merge(AppForScheme(*entry.FindString("scheme")));
  }
  return allowances;
}

void SendAllowances(Reply reply, base::ListValue allowances) {
  reply.Send(base::DictValue().Set("allowances", std::move(allowances)));
}
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
        allowances.Append(base::DictValue().Set("origin", origin)
                              .Set("scheme", scheme));
      }
    }
  }
#if BUILDFLAG(IS_LINUX)
  // Only copied values cross the worker boundary. Reply::Send and its
  // destruction remain on UI, even if the profile goes away in the meantime.
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&bay::ResolveAllowances, std::move(allowances)),
      base::BindOnce(&bay::SendAllowances, call.TakeReply()));
#else
  bay::SendAllowances(call.TakeReply(),
                       bay::ResolveAllowances(std::move(allowances)));
#endif
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
