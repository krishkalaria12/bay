// Copyright 2026 Bay. Apache-2.0.
#include "data_services.h"
#include <algorithm>
#include <mutex>
#include <utility>
#include "packages/import/windows/ImportCore.h"
#include "packages/sync/windows/SyncService.h"

namespace bay::data {
namespace {
using Json = importer::Json;
std::mutex configuration_mutex;
ProfileResolver profile_resolver;
ProfilePaths ResolveProfile(const std::string& profile) {
  ProfileResolver resolve;
  {
    std::lock_guard<std::mutex> lock(configuration_mutex);
    resolve = profile_resolver;
  }
  if (!resolve)
    throw sync::Failure("profile_unavailable",
                        "This browser profile is not loaded");
  auto paths = resolve(profile);
  if (paths.user_data_directory.empty() || paths.profile_directory.empty())
    throw sync::Failure("profile_unavailable",
                        "This browser profile is not loaded");
  return paths;
}
std::string Error(const std::string& code, const std::string& message) {
  return Json{{"error", {{"code", code}, {"message", message}}}}.dump();
}
struct PrivateJSON {
  Json& value;
  ~PrivateJSON() { importer::wipeJson(value); }
};
struct PrivateString {
  std::string& value;
  ~PrivateString() {
    volatile char* bytes = value.data();
    for (std::size_t i = 0; i < value.size(); ++i)
      bytes[i] = 0;
  }
};
Json WriteImported(const EngineCall& call,
                   const std::string& profile,
                   const std::vector<std::string>& kinds,
                   const importer::SensitiveImport& data) {
  // A stale identifier must never fall back to Chrome's default profile.
  ResolveProfile(profile);
  Json totals = {{"cookies", 0},
                 {"cookiesRejected", 0},
                 {"cookiesExisting", 0},
                 {"addresses", 0},
                 {"cards", 0}};
  auto wanted = [&](const char* kind) {
    return std::find(kinds.begin(), kinds.end(), kind) != kinds.end();
  };
  auto invoke = [&](const char* service, Json& arguments,
                    const char* failure_field) -> Json {
    try {
      auto encoded = arguments.dump();
      PrivateString clean{encoded};
      auto result = Json::parse(call(service, profile, encoded));
      if (!result.is_object())
        throw sync::Failure("invalid_result", "Invalid engine import reply");
      if (result.contains("error")) {
        auto& error = result["error"];
        totals["error"] = error.is_string()
                              ? error
                              : Json("The browser engine refused this import");
        totals[failure_field] = 1;
        return nullptr;
      }
      return result;
    } catch (const std::exception&) {
      totals[failure_field] = 1;
      totals["error"] = "The browser engine could not finish the import";
      return nullptr;
    }
  };
  if (wanted("cookies")) {
    for (std::size_t start = 0; start < data.cookies.size(); start += 500) {
      Json arguments = {{"cookies", Json::array()}};
      PrivateJSON clean{arguments};
      for (std::size_t i = start;
           i < std::min(start + 500, data.cookies.size()); ++i)
        arguments["cookies"].push_back(data.cookies[i]);
      auto result = invoke("nn_cookies_import", arguments, "cookiesFailed");
      if (result.is_null())
        break;
      totals["cookies"] =
          totals["cookies"].get<int>() + result.value("imported", 0);
      totals["cookiesRejected"] =
          totals["cookiesRejected"].get<int>() + result.value("rejected", 0);
      totals["cookiesExisting"] =
          totals["cookiesExisting"].get<int>() + result.value("existing", 0);
    }
  }
  if (wanted("autofill")) {
    for (std::size_t start = 0;
         start < std::max(data.addresses.size(), data.cards.size());
         start += 500) {
      Json arguments = {{"addresses", Json::array()}, {"cards", Json::array()}};
      PrivateJSON clean{arguments};
      for (std::size_t i = start;
           i < std::min(start + 500, data.addresses.size()); ++i)
        arguments["addresses"].push_back(data.addresses[i]);
      for (std::size_t i = start; i < std::min(start + 500, data.cards.size());
           ++i)
        arguments["cards"].push_back(data.cards[i]);
      auto result = invoke("nn_autofill_import", arguments, "autofillFailed");
      if (result.is_null())
        break;
      totals["addresses"] =
          totals["addresses"].get<int>() + result.value("addresses", 0);
      totals["cards"] = totals["cards"].get<int>() + result.value("cards", 0);
    }
  }
  return totals;
}
}  // namespace

void Configure(std::string directory, ProfileResolver resolve_profile) {
  sync::SetDataDirectory(std::move(directory));
  {
    std::lock_guard<std::mutex> lock(configuration_mutex);
    profile_resolver = std::move(resolve_profile);
  }
  sync::SetProfileResolver([](const std::string& profile) {
    auto paths = ResolveProfile(profile);
    return std::pair{std::filesystem::u8path(paths.user_data_directory),
                     std::filesystem::u8path(paths.profile_directory)};
  });
}
void SetEventSink(EventSink sink) {
  importer::SetEventSink(std::move(sink));
}
void SetEngineCall(EngineCall engine_call) {
  if (!engine_call) {
    importer::SetImportWriter({});
    return;
  }
  importer::SetImportWriter(
      [call = std::move(engine_call)](const std::string& profile,
                                      const std::vector<std::string>& kinds,
                                      const importer::SensitiveImport& data) {
        return WriteImported(call, profile, kinds, data);
      });
}
const std::vector<std::string>& ModuleNames() {
  static const std::vector<std::string> modules{importer::kModuleName,
                                                sync::kModuleName};
  return modules;
}
const std::vector<std::string>& MethodNames(const std::string& module) {
  if (module == importer::kModuleName)
    return importer::MethodNames();
  if (module == sync::kModuleName)
    return sync::MethodNames();
  static const std::vector<std::string> empty;
  return empty;
}
bool RequiresUIThread(const std::string& module, const std::string& method) {
  return module == importer::kModuleName
             ? importer::RequiresUIThread(method)
             : module == sync::kModuleName && sync::RequiresUIThread(method);
}
std::string Invoke(const std::string& module,
                   const std::string& method,
                   const std::string& arguments) {
  try {
    if (module == importer::kModuleName)
      return importer::InvokeEnvelope(method, arguments);
    if (module == sync::kModuleName)
      return sync::InvokeEnvelope(method, arguments);
    return Error("unsupported", "This native module is unavailable");
  } catch (const std::exception&) {
    return Error("native_failure", "The native data service failed");
  } catch (...) {
    return Error("native_failure", "The native data service failed");
  }
}
}  // namespace bay::data
