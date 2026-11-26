// Copyright 2026 Bay. Apache-2.0.

#include "chrome/browser/bay/webui/plugins.h"

#include <string_view>
#include <utility>

#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/memory/ref_counted_memory.h"
#include "base/path_service.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/bay/webui/bay_plugins.h"
#include "chrome/common/chrome_paths.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "content/public/common/url_constants.h"
#include "services/network/public/mojom/content_security_policy.mojom.h"
#include "url/gurl.h"

namespace bay {
namespace {

constexpr char kRootName[] = "BayPlugins";

std::string Success(base::Value value = {}) {
  return base::WriteJson(base::DictValue().Set("value", std::move(value)))
      .value_or("{}");
}
std::string Failure(const char* code, const char* message) {
  return base::WriteJson(
             base::DictValue().Set(
                 "error",
                 base::DictValue().Set("code", code).Set("message", message)))
      .value_or("{}");
}

std::string Utf8(const base::FilePath& path) {
  return path.AsUTF8Unsafe();
}

// Rust's string, released once copied.
std::string Take(char* text) {
  std::string out = text ? text : "";
  bay_plugins_string_free(text);
  return out;
}

std::string List() {
  const base::FilePath root = Plugins::Root();
  return Take(bay_plugins_list(root.empty() ? "" : Utf8(root).c_str()));
}

bool Remove(const std::string& id) {
  const base::FilePath root = Plugins::Root();
  return !root.empty() && bay_plugins_remove(Utf8(root).c_str(), id.c_str());
}

// The directives bay-plugins' policy uses (network keeps its own parser
// private).
network::mojom::CSPDirectiveName Directive(std::string_view name) {
  using enum network::mojom::CSPDirectiveName;
  static constexpr std::pair<std::string_view, network::mojom::CSPDirectiveName>
      kNames[] = {{"default-src", DefaultSrc}, {"script-src", ScriptSrc},
                  {"style-src", StyleSrc},     {"img-src", ImgSrc},
                  {"font-src", FontSrc},       {"connect-src", ConnectSrc},
                  {"frame-src", FrameSrc},     {"worker-src", WorkerSrc},
                  {"object-src", ObjectSrc},   {"base-uri", BaseURI},
                  {"form-action", FormAction}, {"sandbox", Sandbox}};
  for (const auto& [text, directive] : kNames)
    if (text == name)
      return directive;
  return Unknown;
}

// A sandbox's file: "<id>/<path>", as bay_plugins_file allows it.
scoped_refptr<base::RefCountedMemory> ReadFile(const std::string& request) {
  const std::string path = request.substr(0, request.find_first_of("?#"));
  const size_t slash = path.find('/');
  const base::FilePath root = Plugins::Root();
  if (slash == std::string::npos || root.empty())
    return nullptr;
  BayPluginFile* file =
      bay_plugins_file(Utf8(root).c_str(), path.substr(0, slash).c_str(),
                       path.substr(slash + 1).c_str());
  if (!file)
    return nullptr;
  std::string bytes(reinterpret_cast<const char*>(file->data), file->len);
  bay_plugins_file_free(file);
  return base::MakeRefCounted<base::RefCountedString>(std::move(bytes));
}

}  // namespace

base::ListValue Plugins::SupportedMethods() {
  base::ListValue methods;
  for (const char* method : {"list", "install", "remove", "reveal"})
    methods.Append(std::string("BayPlugins.") + method);
  return methods;
}

base::FilePath Plugins::Root() {
  base::FilePath dir;
  return base::PathService::Get(chrome::DIR_USER_DATA, &dir)
             ? dir.AppendASCII(kRootName)
             : base::FilePath();
}

bool Plugins::Dispatch(const std::string& module,
                       const std::string& method,
                       const base::ListValue& args,
                       Response& response) {
  if (module != "BayPlugins")
    return false;
  auto answer = [](Response response, base::Value value) {
    std::move(response).Run(Success(std::move(value)));
  };
  const auto disk =
      base::TaskTraits{base::MayBlock(), base::TaskPriority::USER_VISIBLE};
  if (method == "list") {
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, disk, base::BindOnce([] { return base::Value(List()); }),
        base::BindOnce(answer, std::move(response)));
    return true;
  }
  if (method == "remove") {
    if (args.size() != 1 || !args[0].is_string()) {
      std::move(response).Run(
          Failure("invalid_args", "A plugin id is required"));
      return true;
    }
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, disk,
        base::BindOnce([](std::string id) { return base::Value(Remove(id)); },
                       args[0].GetString()),
        base::BindOnce(answer, std::move(response)));
    return true;
  }
  return false;
}

std::string Plugins::Install(const base::FilePath& source) {
  const base::FilePath root = Root();
  if (root.empty())
    return Success(base::Value(R"({"ok":false,"error":"No plugins folder"})"));
  return Success(base::Value(
      Take(bay_plugins_install(Utf8(root).c_str(), Utf8(source).c_str()))));
}

BayPluginUIConfig::BayPluginUIConfig()
    : DefaultWebUIConfig(content::kChromeUIUntrustedScheme, kPluginHost) {}

BayPluginUI::BayPluginUI(content::WebUI* web_ui)
    : ui::UntrustedWebUIController(web_ui) {
  auto* source = content::WebUIDataSource::CreateAndAdd(
      web_ui->GetWebContents()->GetBrowserContext(),
      std::string(content::kChromeUIUntrustedScheme) +
          url::kStandardSchemeSeparator + kPluginHost + "/");
  // bay-plugins' policy, directive by directive: the plugin's own files, no
  // network, a sandboxed unique origin. Only Bay's document may frame it.
  source->DisableTrustedTypesCSP();
  for (const auto& directive :
       base::SplitString(bay_plugins_csp(), ";", base::TRIM_WHITESPACE,
                         base::SPLIT_WANT_NONEMPTY)) {
    const std::string name = directive.substr(0, directive.find(' '));
    const auto key = Directive(name);
    if (key != network::mojom::CSPDirectiveName::Unknown)
      source->OverrideContentSecurityPolicy(key, directive + ";");
  }
  source->AddFrameAncestor(GURL("chrome://bay"));
  source->SetRequestFilter(
      base::BindRepeating([](const std::string&) { return true; }),
      base::BindRepeating([](const std::string& path,
                             content::WebUIDataSource::GotDataCallback reply) {
        base::ThreadPool::PostTaskAndReplyWithResult(
            FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
            base::BindOnce(&ReadFile, path), std::move(reply));
      }));
}

BayPluginUI::~BayPluginUI() = default;

}  // namespace bay
