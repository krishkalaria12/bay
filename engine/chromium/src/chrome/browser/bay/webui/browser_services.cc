// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/browser_services.h"

#include <optional>
#include <string_view>
#include <utility>
#include <vector>

#include "base/base64.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/path_service.h"
#include "base/scoped_observation.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/stringprintf.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/extensions/api/side_panel/side_panel_service.h"
#include "chrome/browser/media/router/media_router_feature.h"
#include "chrome/browser/media/webrtc/media_capture_devices_dispatcher.h"
#include "chrome/browser/media/webrtc/media_stream_capture_indicator.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/profiles/profile_observer.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/common/chrome_paths.h"
#include "components/media_router/browser/media_router.h"
#include "components/media_router/browser/media_router_dialog_controller.h"
#include "components/media_router/browser/media_router_factory.h"
#include "components/media_router/browser/media_router_metrics.h"
#include "components/media_router/browser/media_routes_observer.h"
#include "components/media_router/common/media_route.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/web_contents.h"
#include "extensions/browser/extension_action.h"
#include "extensions/browser/extension_action_manager.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/common/api/extension_action/action_info.h"
#include "extensions/common/extension.h"
#include "extensions/common/extension_resource.h"
#include "extensions/common/file_util.h"
#include "extensions/common/manifest.h"
#include "extensions/common/manifest_handlers/options_page_info.h"
#include "extensions/common/manifest_handlers/permissions_parser.h"
#include "extensions/common/mojom/manifest.mojom.h"
#include "extensions/common/permissions/permission_set.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/base/base_window.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/image/image.h"
#include "ui/gfx/image/image_skia.h"
#include "ui/gfx/image/image_skia_rep.h"
#include "ui/shell_dialogs/select_file_dialog.h"
#include "ui/shell_dialogs/select_file_policy.h"
#include "ui/shell_dialogs/selected_file_info.h"

namespace bay {
namespace {
using Response = BrowserServices::Response;
using EventSink = BrowserServices::EventSink;
constexpr const char* kExtensionMethods[] = {
    "list",   "inspectUnpacked", "install",          "setEnabled",  "uninstall",
    "reload", "configure",       "searchEngineList", "chooseFolder"};
constexpr const char* kChromeMethods[] = {
    "actionStates",    "sidePanelURL",       "showCastDialog",
    "watchCastRoutes", "terminateCastRoute", "stopCapture"};

template <size_t N>
bool Contains(const char* const (&methods)[N], const std::string& method) {
  for (const char* candidate : methods)
    if (candidate == method)
      return true;
  return false;
}
std::string JSON(const base::DictValue& value) {
  return base::WriteJson(value).value_or("{}");
}
std::string Success(base::Value value = base::Value()) {
  return JSON(base::DictValue().Set("value", std::move(value)));
}
std::string Failure(std::string_view code, std::string_view message) {
  return JSON(base::DictValue().Set(
      "error", base::DictValue().Set("code", code).Set("message", message)));
}
const base::Value* At(const base::ListValue& args, size_t index) {
  return index < args.size() ? &args[index] : nullptr;
}
const std::string* Text(const base::ListValue& args, size_t index) {
  const auto* value = At(args, index);
  return value ? value->GetIfString() : nullptr;
}
bool ValidPath(const std::string& text) {
  return text.find('\0') == std::string::npos &&
         base::FilePath::FromUTF8Unsafe(text).IsAbsolute();
}
Profile* ResolveCastProfile(BrowserWindowInterface* browser,
                            const std::string& logical_id) {
  if (logical_id.starts_with("incognito:")) {
    const auto window_id = WindowRegistry::Get().IdFor(browser);
    return !window_id.empty() && browser->GetProfile()->IsOffTheRecord() &&
                   logical_id == "incognito:" + window_id
               ? browser->GetProfile()
               : nullptr;
  }
  if (logical_id.size() > 128 || !base::IsStringASCII(logical_id) ||
      logical_id.find_first_not_of(
          "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") !=
          std::string::npos)
    return nullptr;
  base::FilePath root;
  auto* profiles = g_browser_process->profile_manager();
  if (!profiles || !base::PathService::Get(chrome::DIR_USER_DATA, &root))
    return nullptr;
  // An empty logical profile always means Default, including when the caller
  // happens to be a named-profile or private window.
  return profiles->GetProfileByPath(
      root.AppendASCII(logical_id.empty() ? "Default" : logical_id));
}
content::WebContents* FindTab(BrowserWindowInterface* browser, int id) {
  auto* tabs = browser->GetTabStripModel();
  for (int i = 0; tabs && i < tabs->count(); ++i) {
    auto* contents = tabs->GetWebContentsAt(i);
    if (sessions::SessionTabHelper::IdForTab(contents).id() == id)
      return contents;
  }
  return nullptr;
}
base::Value HexColor(SkColor color) {
  if (!SkColorGetA(color))
    return base::Value();
  return base::Value(base::StringPrintf("#%02x%02x%02x", SkColorGetR(color),
                                        SkColorGetG(color),
                                        SkColorGetB(color)));
}
std::string IconDataURL(const gfx::Image& image) {
  if (image.IsEmpty())
    return {};
  const auto& bitmap = image.ToImageSkia()->GetRepresentation(2.0f).GetBitmap();
  auto png = gfx::PNGCodec::EncodeBGRASkBitmap(bitmap, false);
  return png ? "data:image/png;base64," + base::Base64Encode(*png)
             : std::string();
}
base::DictValue ActionStates(content::WebContents* contents,
                             const base::ListValue& ids) {
  auto* context = contents->GetBrowserContext();
  auto* registry = extensions::ExtensionRegistry::Get(context);
  auto* actions = extensions::ExtensionActionManager::Get(context);
  const int tab_id = sessions::SessionTabHelper::IdForTab(contents).id();
  base::DictValue states;
  for (const auto& value : ids) {
    const auto* id = value.GetIfString();
    if (!id)
      continue;
    const auto* extension = registry->enabled_extensions().GetByID(*id);
    auto* action =
        extension ? actions->GetExtensionAction(*extension) : nullptr;
    if (!action)
      continue;
    gfx::Image icon = action->GetExplicitlySetIcon(tab_id);
    if (icon.IsEmpty())
      icon = action->GetDeclarativeIcon(tab_id);
    if (icon.IsEmpty())
      icon = action->GetDefaultIconImage();
    std::string badge = action->GetDisplayBadgeText(tab_id);
    if (badge.starts_with("<<"))
      badge.clear();
    states.Set(*id, base::DictValue()
                        .Set("title", action->GetTitle(tab_id))
                        .Set("badgeText", badge)
                        .Set("badgeColor",
                             HexColor(action->GetBadgeBackgroundColor(tab_id)))
                        .Set("badgeTextColor",
                             HexColor(action->GetBadgeTextColor(tab_id)))
                        .Set("popup", action->GetPopupUrl(tab_id).spec())
                        .Set("enabled", action->GetIsVisible(tab_id))
                        .Set("icon", IconDataURL(icon)));
  }
  return states;
}

std::string InspectPackage(base::FilePath path) {
  std::u16string error;
  auto extension = extensions::file_util::LoadExtension(
      path, extensions::mojom::ManifestLocation::kUnpacked,
      extensions::Extension::NO_FLAGS, &error);
  if (!extension)
    return Failure("invalid_extension", base::UTF16ToUTF8(error));
  const auto& manifest = *extension->manifest()->value();
  const auto& required =
      extensions::PermissionsParser::GetRequiredPermissions(extension.get());
  const auto& optional =
      extensions::PermissionsParser::GetOptionalPermissions(extension.get());
  base::ListValue permissions;
  for (const auto& api : required.GetAPIsAsStrings())
    permissions.Append(api);
  base::ListValue optional_permissions;
  for (const auto& api : optional.GetAPIsAsStrings())
    optional_permissions.Append(api);
  base::ListValue hosts;
  // Include both explicit host permissions and content-script matches. Using
  // Chrome's parsed set also covers Manifest V2 patterns in "permissions".
  for (const auto& pattern : required.effective_hosts())
    hosts.Append(pattern.GetAsString());
  auto string_or_null = [&manifest](const char* name) {
    const auto* value = manifest.FindStringByDottedPath(name);
    return value ? base::Value(*value) : base::Value();
  };
  const auto* action =
      extensions::ActionInfo::GetExtensionActionInfo(extension.get());
  base::Value icon;
  if (const auto* icons = manifest.FindDict("icons")) {
    int chosen_size = 0;
    std::string resource;
    for (const auto entry : *icons) {
      int size = 0;
      if (base::StringToInt(entry.first, &size) && size > chosen_size &&
          entry.second.is_string()) {
        resource = entry.second.GetString();
        chosen_size = size;
      }
    }
    if (!resource.empty()) {
      const auto resource_path = base::FilePath::FromUTF8Unsafe(resource);
      std::string bytes;
      if (!resource_path.IsAbsolute() && !resource_path.ReferencesParent() &&
          base::ReadFileToStringWithMaxSize(
              extension->GetResource(resource).GetFilePath(), &bytes,
              4 * 1024 * 1024))
        icon =
            base::Value("data:image/png;base64," + base::Base64Encode(bytes));
    }
  }
  return Success(base::Value(
      base::DictValue()
          .Set("id", extension->id())
          .Set("name", extension->name())
          .Set("shortName", extension->short_name())
          .Set("version", extension->version().GetString())
          .Set("description", manifest.FindString("description")
                                  ? *manifest.FindString("description")
                                  : std::string())
          .Set("manifestVersion", extension->manifest_version())
          .Set("icon", std::move(icon))
          .Set("permissions", std::move(permissions))
          .Set("optionalPermissions", std::move(optional_permissions))
          .Set("hostPermissions", std::move(hosts))
          .Set("hasAction", action != nullptr)
          .Set("popup", action && !action->default_popup_url.is_empty()
                            ? base::Value(action->default_popup_url.spec())
                            : base::Value())
          .Set("optionsPage",
               extensions::OptionsPageInfo::HasOptionsPage(extension.get())
                   ? base::Value(extensions::OptionsPageInfo::GetOptionsPage(
                                     extension.get())
                                     .spec())
                   : base::Value())
          .Set("sidePanel", string_or_null("side_panel.default_path"))
          .Set("path", path.AsUTF8Unsafe())));
}

void EngineFinished(std::string method,
                    std::string profile,
                    std::string id,
                    std::string event,
                    EventSink events,
                    Response response,
                    const std::string& envelope) {
  auto parsed = base::JSONReader::ReadDict(envelope, base::JSON_PARSE_RFC);
  if (!parsed) {
    std::move(response).Run(Failure("invalid_result", "Invalid engine reply"));
    return;
  }
  auto* value = parsed->FindDict("value");
  if (value && !value->contains("error")) {
    if (method == "searchEngineList") {
      // NN engine returns {engines}; the shared extensions facade expects
      // {list:{engines}}, including the loaded service's real engine list.
      std::move(response).Run(
          Success(base::Value(base::DictValue().Set("list", value->Clone()))));
      return;
    }
    if (method == "install") {
      if (const auto* installed_id = value->FindString("id"))
        id = *installed_id;
    }
    if (events && !event.empty() && !id.empty())
      events.Run("BayExtensions", "onChanged",
                 base::DictValue()
                     .Set("profile", profile)
                     .Set("id", id)
                     .Set("event", event));
  }
  std::move(response).Run(envelope);
}
}  // namespace

class BrowserServices::FolderPicker final
    : public ui::SelectFileDialog::Listener {
 public:
  FolderPicker(Response response, base::OnceClosure done)
      : response_(std::move(response)),
        done_(std::move(done)),
        dialog_(ui::SelectFileDialog::Create(this, nullptr)) {}
  ~FolderPicker() override { dialog_->ListenerDestroyed(); }
  void Show(gfx::NativeWindow parent) {
    dialog_->SelectFile(ui::SelectFileDialog::SELECT_FOLDER,
                        u"Choose an extension folder", base::FilePath(),
                        nullptr, 0, base::FilePath::StringType(), parent,
                        nullptr);
  }
  void FileSelected(const ui::SelectedFileInfo& file, int) override {
    Complete(base::Value(file.path().AsUTF8Unsafe()));
  }
  void FileSelectionCanceled() override { Complete(base::Value()); }

 private:
  void Complete(base::Value result) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE,
                                                             std::move(done_));
    if (response_)
      std::move(response_).Run(Success(std::move(result)));
  }
  Response response_;
  base::OnceClosure done_;
  scoped_refptr<ui::SelectFileDialog> dialog_;
};

class BrowserServices::RoutesWatcher final
    : public media_router::MediaRoutesObserver,
      public ProfileObserver {
 public:
  RoutesWatcher(media_router::MediaRouter* router,
                Profile* profile,
                std::string logical_profile,
                EventSink events,
                base::RepeatingCallback<void(Profile*)> gone)
      : media_router::MediaRoutesObserver(router),
        logical_profile_(std::move(logical_profile)),
        events_(std::move(events)),
        gone_(std::move(gone)) {
    observation_.Observe(profile);
  }
  void OnRoutesUpdated(
      const std::vector<media_router::MediaRoute>& routes) override {
    base::ListValue result;
    for (const auto& route : routes)
      result.Append(base::DictValue()
                        .Set("id", route.media_route_id())
                        .Set("sink", route.media_sink_id())
                        .Set("description", route.description())
                        .Set("source", route.media_source().id()));
    if (events_)
      events_.Run("BayChromeUI", "onCastRoutes",
                  base::DictValue()
                      .Set("profile", logical_profile_)
                      .Set("routes", std::move(result)));
  }
  void OnProfileWillBeDestroyed(Profile* profile) override {
    observation_.Reset();
    // The owner destroys this watcher before the profile's router shuts down.
    auto gone = gone_;
    gone.Run(profile);
  }

 private:
  std::string logical_profile_;
  EventSink events_;
  base::RepeatingCallback<void(Profile*)> gone_;
  base::ScopedObservation<Profile, ProfileObserver> observation_{this};
};

BrowserServices::BrowserServices(BrowserWindowInterface* browser,
                                 EngineInvoker engine,
                                 EventSink events)
    : browser_(browser),
      engine_(std::move(engine)),
      events_(std::move(events)) {}
BrowserServices::~BrowserServices() = default;
base::ListValue BrowserServices::Modules() const {
  return base::ListValue().Append("BayExtensions").Append("BayChromeUI");
}
base::ListValue BrowserServices::SupportedMethods() const {
  base::ListValue methods;
  for (const char* name : kExtensionMethods)
    methods.Append(std::string("BayExtensions.") + name);
  for (const char* name : kChromeMethods)
    methods.Append(std::string("BayChromeUI.") + name);
  return methods;
}
void BrowserServices::FolderPickerFinished() {
  folder_picker_.reset();
}
void BrowserServices::RouteProfileGone(Profile* profile) {
  route_watchers_.erase(profile);
}
bool BrowserServices::DispatchBrowserModule(const std::string& module,
                                            const std::string& method,
                                            const base::ListValue& args,
                                            Response& response) {
  if (module == "BayExtensions" && Contains(kExtensionMethods, method))
    return DispatchExtensions(method, args, response);
  if (module == "BayChromeUI" && Contains(kChromeMethods, method))
    return DispatchChromeUI(method, args, response);
  return false;
}

bool BrowserServices::DispatchExtensions(const std::string& method,
                                         const base::ListValue& args,
                                         Response& response) {
  auto invalid = [&] {
    std::move(response).Run(
        Failure("invalid_args", "Invalid extension arguments"));
  };
  if (method == "chooseFolder") {
    if (folder_picker_) {
      std::move(response).Run(
          Failure("dialog_busy", "An extension picker is already open"));
      return true;
    }
    folder_picker_ = std::make_unique<FolderPicker>(
        std::move(response),
        base::BindOnce(&BrowserServices::FolderPickerFinished,
                       weak_factory_.GetWeakPtr()));
    folder_picker_->Show(browser_->GetWindow()->GetNativeWindow());
    return true;
  }
  if (method == "inspectUnpacked") {
    const auto* path = Text(args, 0);
    if (!path || !ValidPath(*path)) {
      invalid();
      return true;
    }
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
        base::BindOnce(&InspectPackage, base::FilePath::FromUTF8Unsafe(*path)),
        std::move(response));
    return true;
  }
  const bool profile_only = method == "list" || method == "searchEngineList";
  const auto* profile = Text(args, profile_only ? 0 : 1);
  const auto* first = profile_only ? nullptr : Text(args, 0);
  if (!profile || (!profile_only && !first)) {
    invalid();
    return true;
  }
  base::DictValue values;
  std::string call;
  std::string event;
  std::string id;
  if (method == "list")
    call = "nn_extensions_list";
  else if (method == "searchEngineList")
    call = "nn_search_engines_list";
  else if (method == "install") {
    if (!ValidPath(*first)) {
      invalid();
      return true;
    }
    call = "nn_extensions_install";
    values.Set("path", *first);
    event = "installed";
  } else {
    id = *first;
    values.Set("id", id);
    if (method == "setEnabled") {
      const auto* enabled = At(args, 2);
      if (!enabled || !enabled->is_bool()) {
        invalid();
        return true;
      }
      values.Set("enabled", enabled->GetBool());
      call = "nn_extensions_set_enabled";
      event = enabled->GetBool() ? "enabled" : "disabled";
    } else if (method == "uninstall") {
      call = "nn_extensions_uninstall";
      event = "uninstalled";
    } else if (method == "reload") {
      call = "nn_extensions_reload";
      event = "reloaded";
    } else if (method == "configure") {
      const auto* options = At(args, 2);
      if (!options || !options->is_dict()) {
        invalid();
        return true;
      }
      for (const char* key : {"pinned", "incognito", "fileAccess"}) {
        if (const auto* value = options->GetDict().Find(key)) {
          if (!value->is_bool()) {
            invalid();
            return true;
          }
          values.Set(key, value->Clone());
        }
      }
      if (const auto* access = options->GetDict().Find("siteAccess")) {
        if (!access->is_string() || (access->GetString() != "allSites" &&
                                     access->GetString() != "specificSites" &&
                                     access->GetString() != "onClick")) {
          invalid();
          return true;
        }
        values.Set("siteAccess", access->Clone());
      }
      call = "nn_extensions_configure";
      event = "configured";
    }
  }
  engine_.Run(call, *profile, std::move(values),
              base::BindOnce(&EngineFinished, method, *profile, std::move(id),
                             std::move(event), events_, std::move(response)));
  return true;
}

bool BrowserServices::DispatchChromeUI(const std::string& method,
                                       const base::ListValue& args,
                                       Response& response) {
  if (method == "watchCastRoutes") {
    const auto* profile = Text(args, 0);
    auto* native_profile =
        profile ? ResolveCastProfile(browser_, *profile) : nullptr;
    if (!native_profile) {
      std::move(response).Run(
          Failure("profile_unavailable",
                  "The requested cast profile is not available"));
      return true;
    }
    if (!media_router::MediaRouterEnabled(native_profile)) {
      if (events_)
        events_.Run("BayChromeUI", "onCastRoutes",
                    base::DictValue()
                        .Set("profile", *profile)
                        .Set("routes", base::ListValue()));
      std::move(response).Run(Success());
      return true;
    }
    auto* router = media_router::MediaRouterFactory::GetApiForBrowserContext(
        native_profile);
    if (!router) {
      std::move(response).Run(
          Failure("unavailable", "Media routing is unavailable"));
      return true;
    }
    auto it = route_watchers_.find(native_profile);
    if (it == route_watchers_.end()) {
      auto watcher = std::make_unique<RoutesWatcher>(
          router, native_profile, *profile, events_,
          base::BindRepeating(&BrowserServices::RouteProfileGone,
                              weak_factory_.GetWeakPtr()));
      it = route_watchers_.emplace(native_profile, std::move(watcher)).first;
    }
    it->second->OnRoutesUpdated(router->GetCurrentRoutes());
    std::move(response).Run(Success());
    return true;
  }
  if (method == "terminateCastRoute") {
    const auto* id = Text(args, 0);
    if (!id) {
      std::move(response).Run(Failure("invalid_args", "Invalid route ID"));
      return true;
    }
    for (const auto& entry : route_watchers_) {
      auto* router = entry.second->router();
      for (const auto& route : router->GetCurrentRoutes()) {
        if (route.media_route_id() == *id) {
          router->TerminateRoute(*id);
          std::move(response).Run(Success());
          return true;
        }
      }
    }
    std::move(response).Run(
        Failure("route_unavailable", "The cast route no longer exists"));
    return true;
  }
  const auto* browser_id = At(args, 0);
  auto* contents = browser_id && browser_id->is_int()
                       ? FindTab(browser_, browser_id->GetInt())
                       : nullptr;
  if (!contents) {
    std::move(response).Run(
        Failure("tab_unavailable", "This window does not own that tab"));
    return true;
  }
  if (method == "actionStates") {
    const auto* ids = At(args, 1);
    if (!ids || !ids->is_list() || ids->GetList().size() > 1024) {
      std::move(response).Run(Failure("invalid_args", "Invalid extension IDs"));
      return true;
    }
    for (const auto& id : ids->GetList()) {
      if (!id.is_string()) {
        std::move(response).Run(
            Failure("invalid_args", "Invalid extension IDs"));
        return true;
      }
    }
    std::move(response).Run(
        Success(base::Value(ActionStates(contents, ids->GetList()))));
  } else if (method == "sidePanelURL") {
    const auto* id = Text(args, 1);
    if (!id) {
      std::move(response).Run(Failure("invalid_args", "Invalid extension ID"));
      return true;
    }
    auto* context = contents->GetBrowserContext();
    const auto* extension = extensions::ExtensionRegistry::Get(context)
                                ->enabled_extensions()
                                .GetByID(*id);
    auto* service =
        extension ? extensions::SidePanelService::Get(context) : nullptr;
    base::Value url;
    if (service) {
      auto options = service->GetOptions(*extension, browser_id->GetInt());
      if (options.path && options.enabled.value_or(false))
        url = base::Value(extension->GetResourceURL(*options.path).spec());
    }
    std::move(response).Run(Success(std::move(url)));
  } else if (method == "showCastDialog") {
    bool shown = false;
    if (media_router::MediaRouterEnabled(contents->GetBrowserContext())) {
      auto* controller =
          media_router::MediaRouterDialogController::GetOrCreateForWebContents(
              contents);
      controller->ShowMediaRouterDialog(
          media_router::MediaRouterDialogActivationLocation::TOOLBAR);
      shown = controller->IsShowingMediaRouterDialog();
    }
    std::move(response).Run(Success(base::Value(shown)));
  } else if (method == "stopCapture") {
    auto indicator = MediaCaptureDevicesDispatcher::GetInstance()
                         ->GetMediaStreamCaptureIndicator();
    const bool capturing = indicator->IsCapturingTab(contents) ||
                           indicator->IsCapturingWindow(contents) ||
                           indicator->IsCapturingDisplay(contents);
    indicator->StopMediaCapturing(
        contents, MediaStreamCaptureIndicator::MediaType::kDisplayMedia);
    std::move(response).Run(Success(base::Value(capturing)));
  }
  return true;
}
}  // namespace bay
