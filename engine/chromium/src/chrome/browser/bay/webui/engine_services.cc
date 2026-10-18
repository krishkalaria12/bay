// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/engine_services.h"

#include <cmath>
#include <optional>
#include <string_view>
#include <utility>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/path_service.h"
#include "base/strings/string_util.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tab_sharing/tab_sharing_infobar_delegate.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/common/chrome_paths.h"
#include "components/autofill/content/browser/content_autofill_client.h"
#include "components/autofill/content/browser/content_autofill_driver.h"
#include "components/autofill/core/browser/foundations/autofill_driver.h"
#include "components/autofill/core/browser/foundations/autofill_manager.h"
#include "components/autofill/core/browser/foundations/scoped_autofill_managers_observation.h"
#include "components/autofill/core/common/aliases.h"
#include "components/autofill/core/common/unique_ids.h"
#include "components/infobars/content/content_infobar_manager.h"
#include "components/infobars/core/infobar.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_user_data.h"
#include "ui/base/base_window.h"
#include "ui/shell_dialogs/select_file_dialog.h"
#include "ui/shell_dialogs/select_file_policy.h"
#include "ui/shell_dialogs/selected_file_info.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace bay {
namespace {
using Response = EngineServices::Response;
using EngineInvoker = EngineServices::EngineInvoker;

enum class ArgumentType { kString, kNumber, kDictionary, kStringList };
struct Argument {
  const char* name = nullptr;
  ArgumentType type = ArgumentType::kString;
  bool nullable = false;
};
enum class Shape {
  kDomainResult,
  kObject,
  kVoid,
  kBoolean,
  kList,
  kDictionary,
  kDated,
  kZoom,
  kTasks,
};
struct Method {
  const char* facade;
  const char* engine;
  Shape shape = Shape::kDomainResult;
  const char* field = nullptr;
  Argument arguments[4] = {};
  bool profile = true;
};
constexpr Method kMethods[] = {
    {"listPasswords", "nn_passwords_list", Shape::kDated, "passwords"},
    {"unlockPasswords", "nn_passwords_unlock"},
    {"getPassword",
     "nn_passwords_reveal",
     Shape::kDomainResult,
     nullptr,
     {{"origin"}, {"username"}}},
    {"savePassword",
     "nn_passwords_add",
     Shape::kDomainResult,
     nullptr,
     {{"origin"}, {"username"}, {"password"}}},
    {"updatePassword",
     "nn_passwords_update",
     Shape::kDomainResult,
     nullptr,
     {{"origin"},
      {"username"},
      {"newUsername", ArgumentType::kString, true},
      {"newPassword", ArgumentType::kString, true}}},
    {"deletePassword",
     "nn_passwords_remove",
     Shape::kDomainResult,
     nullptr,
     {{"origin"}, {"username"}}},
    {"getNeverSavePasswordOrigins", "nn_passwords_exceptions"},
    {"allowSavingPasswords",
     "nn_passwords_allow",
     Shape::kDomainResult,
     nullptr,
     {{"origin"}}},
    {"listAddresses", "nn_autofill_addresses", Shape::kDated, "addresses"},
    {"saveAddress",
     "nn_autofill_save_address",
     Shape::kDomainResult,
     nullptr,
     {{"address", ArgumentType::kDictionary}}},
    {"listCards", "nn_autofill_cards", Shape::kDated, "cards"},
    {"saveCard",
     "nn_autofill_save_card",
     Shape::kDomainResult,
     nullptr,
     {{"card", ArgumentType::kDictionary},
      {"number", ArgumentType::kString, true}}},
    {"deleteAutofillEntry",
     "nn_autofill_remove",
     Shape::kDomainResult,
     nullptr,
     {{"id"}}},
    {"revealCardNumber",
     "nn_autofill_card_number",
     Shape::kDomainResult,
     nullptr,
     {{"id"}}},
    {"setSiteSetting",
     "nn_site_settings_set",
     Shape::kVoid,
     nullptr,
     {{"origin"}, {"type"}, {"value"}}},
    {"getSiteSettings",
     "nn_site_settings_get",
     Shape::kDictionary,
     "settings",
     {{"origin"}}},
    {"getSiteSettingsOrigins", "nn_site_settings_origins", Shape::kList,
     "origins"},
    {"resetSiteSettings",
     "nn_site_settings_reset",
     Shape::kVoid,
     nullptr,
     {{"origin"}}},
    {"clearSiteData",
     "nn_site_data_clear",
     Shape::kObject,
     nullptr,
     {{"origin"}}},
    {"clearBrowsingData",
     "nn_browsing_data_clear",
     Shape::kVoid,
     nullptr,
     {{"types", ArgumentType::kStringList},
      {"since", ArgumentType::kNumber, true}}},
    {"getZoomLevels", "nn_zoom_list", Shape::kZoom, "levels"},
    {"setZoom",
     "nn_zoom_set",
     Shape::kVoid,
     nullptr,
     {{"host"}, {"level", ArgumentType::kNumber}}},
    {"getExternalAppAllowances", "nn_external_apps_allowances", Shape::kList,
     "allowances"},
    {"removeExternalAppAllowance",
     "nn_external_apps_remove",
     Shape::kVoid,
     nullptr,
     {{"origin"}, {"scheme"}}},
    {"components", "nn_components_list", Shape::kList, "components", {}, false},
    {"listTasks", "nn_tasks_list", Shape::kTasks, "tasks", {}, false},
    {"killTask",
     "nn_tasks_kill",
     Shape::kBoolean,
     "ok",
     {{"id", ArgumentType::kNumber}},
     false},
};

const base::Value* At(const base::ListValue& args, size_t index) {
  return index < args.size() ? &args[index] : nullptr;
}
const std::string* Text(const base::ListValue& args, size_t index) {
  const auto* value = At(args, index);
  return value ? value->GetIfString() : nullptr;
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
std::string DomainEnvelope(const std::string& envelope) {
  const auto parsed =
      base::JSONReader::ReadDict(envelope, base::JSON_PARSE_RFC);
  const auto* error = parsed ? parsed->FindDict("error") : nullptr;
  const auto* code = error ? error->FindString("code") : nullptr;
  const auto* message = error ? error->FindString("message") : nullptr;
  // The shared Result<T> facade resolves ordinary engine failures as data.
  // Argument, profile and transport validation errors still reject the call.
  return code && *code == "engine_error" && message
             ? Success(base::Value(base::DictValue().Set("error", *message)))
             : envelope;
}
std::optional<base::DictValue> Result(const std::string& envelope,
                                      Response& response,
                                      bool domain_result = false) {
  auto parsed = base::JSONReader::ReadDict(envelope, base::JSON_PARSE_RFC);
  if (parsed && parsed->FindDict("error")) {
    std::move(response).Run(domain_result ? DomainEnvelope(envelope)
                                          : envelope);
    return std::nullopt;
  }
  auto* value = parsed ? parsed->FindDict("value") : nullptr;
  if (!value) {
    std::move(response).Run(
        Failure("invalid_result", "Invalid NN engine result"));
    return std::nullopt;
  }
  return std::move(*value);
}

bool Matches(const base::Value& value, ArgumentType type) {
  switch (type) {
    case ArgumentType::kString:
      return value.is_string();
    case ArgumentType::kNumber:
      return value.is_double() || value.is_int();
    case ArgumentType::kDictionary:
      return value.is_dict();
    case ArgumentType::kStringList:
      if (!value.is_list())
        return false;
      for (const auto& item : value.GetList())
        if (!item.is_string())
          return false;
      return true;
  }
}
std::string LoginOrigin(const std::string& text) {
  const GURL url(text);
  return url.SchemeIsHTTPOrHTTPS() ? url::Origin::Create(url).Serialize()
                                   : text;
}
void AdaptResult(const Method* method,
                 Response response,
                 const std::string& envelope) {
  if (method->shape == Shape::kDomainResult) {
    std::move(response).Run(DomainEnvelope(envelope));
    return;
  }
  if (method->shape == Shape::kObject) {
    std::move(response).Run(envelope);
    return;
  }
  auto result = Result(envelope, response, method->shape == Shape::kDated);
  if (!result)
    return;
  if (method->shape == Shape::kVoid) {
    const auto ok = result->FindBool("ok");
    std::move(response).Run(
        ok && *ok ? Success()
                  : Failure("operation_failed",
                            "Chrome could not complete this operation"));
    return;
  }
  const auto* field = result->Find(method->field);
  const bool valid =
      field &&
      ((method->shape == Shape::kBoolean && field->is_bool()) ||
       ((method->shape == Shape::kList || method->shape == Shape::kDated ||
         method->shape == Shape::kTasks) &&
        field->is_list()) ||
       ((method->shape == Shape::kDictionary ||
         method->shape == Shape::kZoom) &&
        field->is_dict()));
  if (!valid) {
    std::move(response).Run(
        Failure("invalid_result", "Unexpected NN engine result shape"));
    return;
  }
  if (method->shape == Shape::kDated) {
    base::ListValue entries;
    for (const auto& item : field->GetList()) {
      if (!item.is_dict()) {
        std::move(response).Run(
            Failure("invalid_result", "Unexpected saved entry"));
        return;
      }
      // These stores do not expose timestamps through the NN API. Zero has
      // the same "unknown" meaning as the existing Mac adapter.
      entries.Append(
          item.GetDict().Clone().Set("created", 0).Set("modified", 0));
    }
    std::move(response).Run(Success(
        base::Value(base::DictValue().Set(method->field, std::move(entries)))));
  } else if (method->shape == Shape::kTasks) {
    base::ListValue tasks;
    for (const auto& item : field->GetList()) {
      if (!item.is_dict()) {
        std::move(response).Run(
            Failure("invalid_result", "Unexpected process task"));
        return;
      }
      auto task = item.GetDict().Clone();
      base::ListValue browser_ids;
      if (const auto* tab_ids = task.FindList("tabIds")) {
        for (const auto& id : *tab_ids)
          if (id.is_int() && id.GetInt() > 0)
            browser_ids.Append(id.GetInt());
      }
      // Desktop NativeHost browser ids are Chrome's SessionTabHelper ids.
      task.Set("browserIds", std::move(browser_ids));
      tasks.Append(std::move(task));
    }
    std::move(response).Run(Success(base::Value(std::move(tasks))));
  } else if (method->shape == Shape::kZoom) {
    base::DictValue factors;
    for (const auto entry : field->GetDict()) {
      const auto level = entry.second.GetIfDouble();
      const double factor = level ? std::pow(1.2, *level) : 0;
      if (!std::isfinite(factor) || factor <= 0) {
        std::move(response).Run(
            Failure("invalid_result", "Unexpected zoom level"));
        return;
      }
      factors.Set(entry.first, std::round(factor * 100) / 100);
    }
    std::move(response).Run(Success(base::Value(std::move(factors))));
  } else {
    std::move(response).Run(Success(field->Clone()));
  }
}

void ReadAutofillSettings(EngineInvoker engine,
                          std::string profile,
                          Response response) {
  engine.Run(
      "nn_prefs_get", profile,
      base::DictValue().Set("name", "autofill.profile_enabled"),
      base::BindOnce(
          [](EngineInvoker engine, std::string profile, Response response,
             const std::string& envelope) {
            auto result = Result(envelope, response);
            if (!result)
              return;
            const auto addresses = result->FindBool("value");
            if (!addresses) {
              std::move(response).Run(
                  Failure("invalid_result", "Invalid autofill preference"));
              return;
            }
            engine.Run(
                "nn_prefs_get", profile,
                base::DictValue().Set("name", "autofill.credit_card_enabled"),
                base::BindOnce(
                    [](bool addresses, Response response,
                       const std::string& envelope) {
                      auto result = Result(envelope, response);
                      if (!result)
                        return;
                      const auto cards = result->FindBool("value");
                      std::move(response).Run(
                          cards ? Success(base::Value(
                                      base::DictValue()
                                          .Set("addresses", addresses)
                                          .Set("cards", *cards)))
                                : Failure("invalid_result",
                                          "Invalid autofill preference"));
                    },
                    *addresses, std::move(response)));
          },
          engine, profile, std::move(response)));
}
void WriteAutofillSettings(EngineInvoker engine,
                           std::string profile,
                           std::optional<bool> addresses,
                           std::optional<bool> cards,
                           Response response) {
  if (!addresses && !cards) {
    std::move(response).Run(Success());
    return;
  }
  const char* name =
      addresses ? "autofill.profile_enabled" : "autofill.credit_card_enabled";
  const bool value = addresses ? *addresses : *cards;
  engine.Run(
      "nn_prefs_set", profile,
      base::DictValue().Set("name", name).Set("value", value),
      base::BindOnce(
          [](EngineInvoker engine, std::string profile, bool wrote_addresses,
             std::optional<bool> cards, Response response,
             const std::string& envelope) {
            auto result = Result(envelope, response);
            if (!result)
              return;
            if (!result->FindBool("ok").value_or(false)) {
              std::move(response).Run(
                  Failure("operation_failed",
                          "Chrome refused the autofill preference"));
              return;
            }
            if (wrote_addresses && cards)
              WriteAutofillSettings(engine, profile, std::nullopt, cards,
                                    std::move(response));
            else
              std::move(response).Run(Success());
          },
          engine, profile, addresses.has_value(), cards, std::move(response)));
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
TabSharingInfoBarDelegate* SharingDelegate(content::WebContents* target,
                                           content::WebContents* capturer) {
  auto* manager = infobars::ContentInfoBarManager::FromWebContents(target);
  if (!manager)
    return nullptr;
  TabSharingInfoBarDelegate* found = nullptr;
  for (infobars::InfoBar* infobar : manager->infobars()) {
    if (infobar->delegate()->GetIdentifier() !=
        infobars::InfoBarDelegate::TAB_SHARING_INFOBAR_DELEGATE)
      continue;
    auto* sharing =
        static_cast<TabSharingInfoBarDelegate*>(infobar->delegate());
    auto* frame = content::RenderFrameHost::FromID(sharing->capturer_id());
    if (frame && content::WebContents::FromRenderFrameHost(frame) == capturer) {
      if (found)
        return nullptr;
      found = sharing;
    }
  }
  return found;
}

class FocusedAutofillField
    : public content::WebContentsUserData<FocusedAutofillField>,
      public autofill::AutofillManager::Observer {
 public:
  bool Trigger(bool passwords) {
    auto* frame = GetWebContents().GetFocusedFrame();
    auto* driver =
        frame ? autofill::ContentAutofillDriver::GetForRenderFrameHost(frame)
              : nullptr;
    if (!manager_ || !driver || !driver->IsActive() ||
        &driver->GetAutofillManager() != manager_.get())
      return false;
    static_cast<autofill::AutofillDriver*>(driver)
        ->RendererShouldTriggerSuggestions(
            field_, passwords ? autofill::AutofillSuggestionTriggerSource::
                                    kManualFallbackPasswords
                              : autofill::AutofillSuggestionTriggerSource::
                                    kFormControlElementClicked);
    return true;
  }

 private:
  friend class content::WebContentsUserData<FocusedAutofillField>;
  FocusedAutofillField(content::WebContents* contents,
                       autofill::ContentAutofillClient* client)
      : content::WebContentsUserData<FocusedAutofillField>(*contents) {
    observation_.Observe(client,
                         autofill::ScopedAutofillManagersObservation::
                             InitializationPolicy::kObservePreexistingManagers);
  }
  void OnAfterFocusOnFormField(autofill::AutofillManager& manager,
                               autofill::FormGlobalId,
                               autofill::FieldGlobalId field) override {
    Focused(manager, field);
  }
  void OnAfterAskForValuesToFill(autofill::AutofillManager& manager,
                                 autofill::FormGlobalId,
                                 autofill::FieldGlobalId field) override {
    Focused(manager, field);
  }
  void OnAfterFocusOnNonFormField(autofill::AutofillManager& manager) override {
    if (manager_.get() == &manager)
      manager_.reset();
  }
  void Focused(autofill::AutofillManager& manager,
               autofill::FieldGlobalId field) {
    manager_ = manager.GetWeakPtr();
    field_ = field;
  }
  base::WeakPtr<autofill::AutofillManager> manager_;
  autofill::FieldGlobalId field_;
  autofill::ScopedAutofillManagersObservation observation_{this};
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};
WEB_CONTENTS_USER_DATA_KEY_IMPL(FocusedAutofillField);
}  // namespace

class EngineServices::PasswordExportPicker final
    : public ui::SelectFileDialog::Listener {
 public:
  PasswordExportPicker(EngineInvoker engine,
                       std::string profile,
                       Response response,
                       base::OnceClosure done)
      : engine_(std::move(engine)),
        profile_(std::move(profile)),
        response_(std::move(response)),
        done_(std::move(done)),
        dialog_(ui::SelectFileDialog::Create(this, nullptr)) {}
  ~PasswordExportPicker() override { dialog_->ListenerDestroyed(); }
  void Show(gfx::NativeWindow parent) {
    base::FilePath directory;
    base::PathService::Get(chrome::DIR_DEFAULT_DOWNLOADS, &directory);
    types_.extensions = {{FILE_PATH_LITERAL("csv")}};
    types_.include_all_files = false;
    default_path_ = directory.AppendASCII("Bay Passwords.csv");
    dialog_->SelectFile(ui::SelectFileDialog::SELECT_SAVEAS_FILE,
                        u"Export unencrypted passwords", default_path_, &types_,
                        1, FILE_PATH_LITERAL("csv"), parent, nullptr);
  }
  void FileSelected(const ui::SelectedFileInfo& file, int) override {
    const std::string path = file.path().AsUTF8Unsafe();
    auto engine = engine_;
    auto profile = profile_;
    auto response = std::move(response_);
    Finished();
    engine.Run(
        "nn_passwords_export", profile, base::DictValue().Set("path", path),
        base::BindOnce(
            [](std::string path, Response response,
               const std::string& envelope) {
              auto result = Result(envelope, response, true);
              if (!result)
                return;
              const auto* status = result->FindString("status");
              if (status && *status == "succeeded")
                result->Set("path", path);
              std::move(response).Run(Success(base::Value(std::move(*result))));
            },
            path, std::move(response)));
  }
  void FileSelectionCanceled() override {
    Finished();
    if (response_)
      std::move(response_).Run(
          Success(base::Value(base::DictValue().Set("status", "cancelled"))));
  }

 private:
  void Finished() {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE,
                                                             std::move(done_));
  }
  EngineInvoker engine_;
  std::string profile_;
  Response response_;
  base::OnceClosure done_;
  ui::SelectFileDialog::FileTypeInfo types_;
  base::FilePath default_path_;
  scoped_refptr<ui::SelectFileDialog> dialog_;
};

EngineServices::EngineServices(BrowserWindowInterface* browser,
                               EngineInvoker engine)
    : browser_(browser), engine_(std::move(engine)) {}
EngineServices::~EngineServices() = default;
void EngineServices::PasswordExportPickerFinished() {
  password_export_picker_.reset();
}
void EngineServices::TrackTab(content::WebContents* contents) {
  auto* client =
      contents ? autofill::ContentAutofillClient::FromWebContents(contents)
               : nullptr;
  if (client && !FocusedAutofillField::FromWebContents(contents))
    FocusedAutofillField::CreateForWebContents(contents, client);
}
base::ListValue EngineServices::SupportedMethods() const {
  base::ListValue methods;
  for (const auto& method : kMethods)
    methods.Append(std::string("BayCEF.") + method.facade);
  for (const char* method :
       {"getPasswordAutofill", "setPasswordAutofill", "getAutofillSettings",
        "setAutofillSettings", "exportPasswords"})
    methods.Append(std::string("BayCEF.") + method);
  methods.Append("BayChromeUI.changeCaptureSource");
  methods.Append("BayChromeUI.showAutofillSuggestions");
  return methods;
}
bool EngineServices::DispatchEngineModule(const std::string& module,
                                          const std::string& method,
                                          const base::ListValue& args,
                                          Response& response) {
  auto invalid = [&] {
    std::move(response).Run(
        Failure("invalid_args", "Invalid engine facade arguments"));
  };
  if (module == "BayChromeUI" && (method == "changeCaptureSource" ||
                                  method == "showAutofillSuggestions")) {
    const auto* first = At(args, 0);
    auto* contents =
        first && first->is_int() ? FindTab(browser_, first->GetInt()) : nullptr;
    if (!contents) {
      std::move(response).Run(
          Failure("tab_unavailable", "This window does not own that tab"));
      return true;
    }
    if (method == "showAutofillSuggestions") {
      const auto* passwords = At(args, 1);
      if (!passwords || !passwords->is_bool()) {
        invalid();
        return true;
      }
      auto* focused = FocusedAutofillField::FromWebContents(contents);
      std::move(response).Run(Success(
          base::Value(focused && focused->Trigger(passwords->GetBool()))));
    } else {
      const auto* second = At(args, 1);
      auto* target = second && second->is_int()
                         ? FindTab(browser_, second->GetInt())
                         : nullptr;
      auto* sharing = target ? SharingDelegate(target, contents) : nullptr;
      const bool allowed = sharing &&
                           (sharing->GetButtons() &
                            TabSharingInfoBarDelegate::kShareThisTabInstead) &&
                           sharing->IsButtonEnabled(
                               TabSharingInfoBarDelegate::kShareThisTabInstead);
      if (allowed)
        sharing->ShareThisTabInstead();
      std::move(response).Run(Success(base::Value(allowed)));
    }
    return true;
  }
  if (module != "BayCEF")
    return false;
  if (method == "exportPasswords") {
    const auto* profile = Text(args, 0);
    if (!profile) {
      invalid();
      return true;
    }
    if (password_export_picker_) {
      std::move(response).Run(
          Failure("dialog_busy", "A password export picker is already open"));
      return true;
    }
    password_export_picker_ = std::make_unique<PasswordExportPicker>(
        engine_, *profile, std::move(response),
        base::BindOnce(&EngineServices::PasswordExportPickerFinished,
                       weak_factory_.GetWeakPtr()));
    password_export_picker_->Show(browser_->GetWindow()->GetNativeWindow());
    return true;
  }
  if (method == "getPasswordAutofill" || method == "setPasswordAutofill" ||
      method == "getAutofillSettings" || method == "setAutofillSettings") {
    const auto* profile = Text(args, 0);
    if (!profile) {
      invalid();
      return true;
    }
    if (method == "getAutofillSettings") {
      ReadAutofillSettings(engine_, *profile, std::move(response));
    } else if (method == "setAutofillSettings") {
      const auto* addresses = At(args, 1);
      const auto* cards = At(args, 2);
      if (!addresses || !cards ||
          (!addresses->is_none() && !addresses->is_bool()) ||
          (!cards->is_none() && !cards->is_bool())) {
        invalid();
        return true;
      }
      WriteAutofillSettings(engine_, *profile, addresses->GetIfBool(),
                            cards->GetIfBool(), std::move(response));
    } else {
      base::DictValue values;
      values.Set("name", "credentials_enable_service");
      const bool set = method == "setPasswordAutofill";
      if (set) {
        const auto* enabled = At(args, 1);
        if (!enabled || !enabled->is_bool()) {
          invalid();
          return true;
        }
        values.Set("value", enabled->GetBool());
      }
      static constexpr Method get_pref = {"getPasswordAutofill", "nn_prefs_get",
                                          Shape::kBoolean, "value"};
      static constexpr Method set_pref = {"setPasswordAutofill", "nn_prefs_set",
                                          Shape::kVoid};
      const auto* spec = set ? &set_pref : &get_pref;
      engine_.Run(spec->engine, *profile, std::move(values),
                  base::BindOnce(&AdaptResult, spec, std::move(response)));
    }
    return true;
  }
  for (const auto& spec : kMethods) {
    if (method != spec.facade)
      continue;
    std::string profile;
    size_t index = 0;
    if (spec.profile) {
      const auto* value = Text(args, index++);
      if (!value) {
        invalid();
        return true;
      }
      profile = *value;
    }
    base::DictValue values;
    for (const auto& argument : spec.arguments) {
      if (!argument.name)
        break;
      const auto* value = At(args, index++);
      if (!value) {
        invalid();
        return true;
      }
      if (argument.nullable && value->is_none())
        continue;
      if (!Matches(*value, argument.type)) {
        invalid();
        return true;
      }
      if (argument.type == ArgumentType::kNumber &&
          !std::isfinite(value->GetDouble())) {
        invalid();
        return true;
      }
      values.Set(argument.name, value->Clone());
    }
    if (method == "setZoom") {
      const double factor = values.FindDouble("level").value_or(0);
      if (factor <= 0) {
        invalid();
        return true;
      }
      values.Set("host", base::ToLowerASCII(*values.FindString("host")));
      values.Set("level", std::log(factor) / std::log(1.2));
    }
    if (method == "killTask") {
      const double id = values.FindDouble("id").value_or(-1);
      if (id < 0 || std::trunc(id) != id || id > 9007199254740991.0) {
        invalid();
        return true;
      }
    }
    if (std::string_view(spec.engine).starts_with("nn_passwords_")) {
      if (const auto* origin = values.FindString("origin"))
        values.Set("origin", LoginOrigin(*origin));
    }
    engine_.Run(spec.engine, profile, std::move(values),
                base::BindOnce(&AdaptResult, &spec, std::move(response)));
    return true;
  }
  return false;
}
}  // namespace bay
