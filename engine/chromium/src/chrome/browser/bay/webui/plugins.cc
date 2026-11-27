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
#include "base/time/time.h"
#include "chrome/browser/bay/webui/bay_plugins.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/net/system_network_context_manager.h"
#include "chrome/common/chrome_paths.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "content/public/common/url_constants.h"
#include "net/base/load_flags.h"
#include "net/http/http_response_headers.h"
#include "net/http/http_util.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/content_security_policy.mojom.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "url/gurl.h"

namespace bay {
namespace {

constexpr char kRootName[] = "BayPlugins";
constexpr size_t kMaxFetchBody = 5 * 1024 * 1024;

constexpr net::NetworkTrafficAnnotationTag kFetchAnnotation =
    net::DefineNetworkTrafficAnnotation("bay_plugin_fetch", R"(
      semantics { sender: "Bay plugins"
        description: "A request a plugin the user added and turned on makes, to one of the hosts its manifest lists."
        trigger: "A plugin's script calls bay.fetch."
        data: "Whatever the plugin sends; never the user's cookies." destination: OTHER }
      policy { cookies_allowed: NO setting: "Settings > Plugins turns each plugin on or off."
        policy_exception_justification: "Only plugins the user added run." })");

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

// bay.fetch for a plugin (the app has checked its manifest's hosts): no
// cookies, no cache, the network stack's own headers kept. Answers {status,
// url, headers, body}.
void Fetch(const base::ListValue& args, Plugins::Response response) {
  const GURL url = args.size() == 4 && args[0].is_string()
                       ? GURL(args[0].GetString())
                       : GURL();
  const std::string* method =
      args.size() == 4 ? args[1].GetIfString() : nullptr;
  const base::DictValue* headers =
      args.size() == 4 ? args[2].GetIfDict() : nullptr;
  const std::string* body = args.size() == 4 ? args[3].GetIfString() : nullptr;
  if (!url.is_valid() || !url.SchemeIsHTTPOrHTTPS() || !method ||
      !net::HttpUtil::IsValidHeaderName(*method) || !headers ||
      (!body && !args[3].is_none()) || (body && body->size() > kMaxFetchBody)) {
    std::move(response).Run(Failure("invalid_args", "Invalid plugin request"));
    return;
  }
  auto request = std::make_unique<network::ResourceRequest>();
  request->url = url;
  request->method = *method;
  request->credentials_mode = network::mojom::CredentialsMode::kOmit;
  request->load_flags = net::LOAD_DISABLE_CACHE;
  std::string content_type = "text/plain;charset=UTF-8";
  for (const auto [name, value] : *headers) {
    if (!value.is_string() || !net::HttpUtil::IsValidHeaderName(name) ||
        !net::HttpUtil::IsValidHeaderValue(value.GetString()) ||
        !net::HttpUtil::IsSafeHeader(name, value.GetString()))
      continue;
    if (base::EqualsCaseInsensitiveASCII(name, "content-type"))
      content_type = value.GetString();
    else
      request->headers.SetHeader(name, value.GetString());
  }
  auto loader =
      network::SimpleURLLoader::Create(std::move(request), kFetchAnnotation);
  if (body)
    loader->AttachStringForUpload(*body, content_type);
  loader->SetAllowHttpErrorResults(true);
  loader->SetTimeoutDuration(base::Seconds(60));
  auto* raw = loader.get();
  raw->DownloadToString(
      g_browser_process->system_network_context_manager()
          ->GetSharedURLLoaderFactory()
          .get(),
      base::BindOnce(
          [](std::unique_ptr<network::SimpleURLLoader> loader, GURL requested,
             Plugins::Response response, std::optional<std::string> text) {
            const auto* head = loader->ResponseInfo();
            if (!head || !head->headers) {
              std::move(response).Run(Failure(
                  "network", "The plugin's request didn't reach its host"));
              return;
            }
            if (!text) {
              std::move(response).Run(
                  Failure("too_big", "The answer is bigger than 5 MB"));
              return;
            }
            base::DictValue headers;
            size_t iterator = 0;
            std::string name;
            std::string value;
            while (
                head->headers->EnumerateHeaderLines(&iterator, &name, &value)) {
              const std::string key = base::ToLowerASCII(name);
              if (key == "set-cookie" || key == "set-cookie2")
                continue;
              const std::string* earlier = headers.FindString(key);
              headers.Set(key, earlier ? *earlier + ", " + value : value);
            }
            const GURL final_url = loader->GetFinalURL().is_valid()
                                       ? loader->GetFinalURL()
                                       : requested;
            std::move(response).Run(Success(
                base::Value(base::DictValue()
                                .Set("status", head->headers->response_code())
                                .Set("url", final_url.spec())
                                .Set("headers", std::move(headers))
                                .Set("body", std::move(*text)))));
          },
          std::move(loader), url, std::move(response)),
      kMaxFetchBody);
}

}  // namespace

base::ListValue Plugins::SupportedMethods() {
  base::ListValue methods;
  for (const char* method : {"list", "install", "remove", "reveal", "fetch"})
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
  if (method == "fetch") {
    Fetch(args, std::move(response));
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
