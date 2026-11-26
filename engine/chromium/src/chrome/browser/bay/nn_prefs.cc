// Copyright 2026 Bay. Apache-2.0.

#include "chrome/browser/bay/nn_prefs.h"

#include <cmath>
#include <optional>
#include <string>
#include <string_view>

#include "chrome/browser/browser_process.h"
#include "components/prefs/pref_service.h"

namespace bay {
namespace {

// Where a pref lives: the profile's prefs, or the browser's local state.
enum class Scope { kProfile, kLocal };

constexpr struct {
  const char* name;
  base::Value::Type type;
  Scope scope = Scope::kProfile;
} kAllowed[] = {
    {"credentials_enable_service", base::Value::Type::BOOLEAN},
    {"autofill.profile_enabled", base::Value::Type::BOOLEAN},
    {"autofill.credit_card_enabled", base::Value::Type::BOOLEAN},
    {"session.restore_on_startup", base::Value::Type::INTEGER},
    {"download_bubble.partial_view_enabled", base::Value::Type::BOOLEAN},
    {"download.prompt_for_download", base::Value::Type::BOOLEAN},
    {"browser.enable_spellchecking", base::Value::Type::BOOLEAN},
    {"spellcheck.dictionaries", base::Value::Type::LIST},
    {"dns_over_https.mode", base::Value::Type::STRING, Scope::kLocal},
    {"dns_over_https.templates", base::Value::Type::STRING, Scope::kLocal},
};

constexpr size_t kMaxStringBytes = 4096;
constexpr size_t kMaxListItems = 64;

// The prefs a pref of |scope| lives in.
PrefService* PrefsFor(Call& call, Scope scope) {
  return scope == Scope::kLocal ? g_browser_process->local_state()
                                : call.profile()->GetPrefs();
}

// The allowed, registered pref the call names, or replies with an error.
// |prefs| gets the service it's in.
const PrefService::Preference* PrefFor(Call& call, PrefService** prefs) {
  const std::string name = call.String("name");
  for (const auto& allowed : kAllowed) {
    if (name != allowed.name) {
      continue;
    }
    *prefs = PrefsFor(call, allowed.scope);
    const PrefService::Preference* pref =
        *prefs ? (*prefs)->FindPreference(name) : nullptr;
    if (!pref || pref->GetType() != allowed.type) {
      call.TakeReply().Error("not registered");
      return nullptr;
    }
    return pref;
  }
  call.TakeReply().Error("not allowed");
  return nullptr;
}

}  // namespace
}  // namespace bay

NN_ENGINE_CALL(nn_prefs_get) {
  bay::Call call(profile_dir, args_json, reply, context);
  if (!call) {
    return;
  }
  PrefService* prefs = nullptr;
  if (const PrefService::Preference* pref = bay::PrefFor(call, &prefs)) {
    call.TakeReply().Send(base::DictValue()
                              .Set("value", pref->GetValue()->Clone())
                              .Set("managed", pref->IsManaged()));
  }
}

NN_ENGINE_CALL(nn_prefs_set) {
  bay::Call call(profile_dir, args_json, reply, context);
  if (!call) {
    return;
  }
  PrefService* prefs = nullptr;
  const PrefService::Preference* pref = bay::PrefFor(call, &prefs);
  if (!pref) {
    return;
  }
  const base::Value* value = call.args().Find("value");
  if (!value) {
    return call.TakeReply().Error("value required");
  }
  if (!pref->IsUserModifiable()) {
    return call.TakeReply().Error("managed");
  }
  if (pref->GetType() == base::Value::Type::INTEGER) {
    // JSON numbers may arrive as doubles.
    const std::optional<double> number = value->GetIfDouble();
    if (!number || !std::isfinite(*number) || *number != std::trunc(*number)) {
      return call.TakeReply().Error("value must be an integer");
    }
    prefs->SetInteger(pref->name(), static_cast<int>(*number));
  } else if (pref->GetType() == base::Value::Type::BOOLEAN) {
    if (!value->is_bool()) {
      return call.TakeReply().Error("value must be a boolean");
    }
    prefs->SetBoolean(pref->name(), value->GetBool());
  } else if (pref->GetType() == base::Value::Type::STRING) {
    if (!value->is_string() || value->GetString().size() > bay::kMaxStringBytes) {
      return call.TakeReply().Error("value must be a string");
    }
    prefs->SetString(pref->name(), value->GetString());
  } else if (pref->GetType() == base::Value::Type::LIST) {
    const base::ListValue* list = value->GetIfList();
    if (!list || list->size() > bay::kMaxListItems) {
      return call.TakeReply().Error("value must be a list of strings");
    }
    for (const base::Value& item : *list) {
      if (!item.is_string() || item.GetString().size() > bay::kMaxStringBytes) {
        return call.TakeReply().Error("value must be a list of strings");
      }
    }
    prefs->SetList(pref->name(), list->Clone());
  } else {
    return call.TakeReply().Error("unsupported type");
  }
  call.TakeReply().Ok();
}
