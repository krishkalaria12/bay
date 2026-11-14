// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/easel_sharing.h"

#include <array>
#include <cerrno>
#include <optional>
#include <utility>

#include "base/containers/span.h"
#include "base/environment.h"
#include "base/files/file.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/rand_util.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "build/build_config.h"
#include "chrome/browser/bay/webui/document_store.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/storage_partition.h"
#include "net/base/load_flags.h"
#include "net/base/net_errors.h"
#include "net/http/http_response_headers.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "url/gurl.h"

#if BUILDFLAG(IS_POSIX)
#include <fcntl.h>
#include <sys/stat.h>
#endif

namespace bay {
namespace {
constexpr size_t kMaximumRecordsBytes = 16 * 1024 * 1024;
constexpr net::NetworkTrafficAnnotationTag kSharingAnnotation =
    net::DefineNetworkTrafficAnnotation("bay_easel_share", R"(
      semantics {
        sender: "Bay Easel sharing"
        description: "Publishes or revokes an Easel snapshot on Bay's website."
        trigger: "The user explicitly publishes, updates or stops sharing an Easel."
        data: "Rendered canvas, explicit source links, revision and a random management capability."
        destination: WEBSITE
      }
      policy {
        cookies_allowed: NO
        setting: "Opt-in BAY_EASEL_WEB_SHARING launch flag. Every upload is explicit."
        policy_exception_justification: "Not implemented."
      })");

bool Hex(const std::string& value, size_t size) {
  return value.size() == size &&
         value.find_first_not_of("0123456789abcdef") == std::string::npos;
}

bool Enabled() {
  return base::Environment::Create()->GetVar("BAY_EASEL_WEB_SHARING") == "true";
}
std::string Success(base::Value value = {}) {
  return base::WriteJson(base::DictValue().Set("value", std::move(value)))
      .value_or("{}");
}
std::string Failure(const char* code, const std::string& message) {
  return base::WriteJson(base::DictValue().Set(
                            "error", base::DictValue()
                                         .Set("code", code)
                                         .Set("message", message)))
      .value_or("{}");
}

// Null is reserved for a genuinely missing file; failures never reset the
// publication registry and lose the ability to revoke existing links.
base::DictValue ReadRecords(const base::FilePath& directory) {
  const auto failure = [] {
    return base::DictValue().Set(
        "error", "Couldn't read Easel sharing records. Restore access to "
                 "easel-shares.json before changing shared pages.");
  };
  if (directory.empty() || base::IsLink(directory))
    return failure();
  const auto path = directory.AppendASCII("easel-shares.json");
#if BUILDFLAG(IS_POSIX)
  // Open without following a link or waiting on a FIFO, then inspect the same
  // descriptor we read so replacing the path cannot redirect the read.
  const int fd = open(path.value().c_str(),
                      O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0)
    return errno == ENOENT
               ? base::DictValue().Set("value", base::Value())
               : failure();
  base::File file(fd);
  struct stat node;
  if (file.IsValid() &&
      (fstat(file.GetPlatformFile(), &node) != 0 || !S_ISREG(node.st_mode)))
    return failure();
#else
  if (base::IsLink(path))
    return failure();
  base::File file(path, base::File::FLAG_OPEN | base::File::FLAG_READ);
#endif
  if (!file.IsValid()) {
    return file.error_details() == base::File::FILE_ERROR_NOT_FOUND
               ? base::DictValue().Set("value", base::Value())
               : failure();
  }
  base::File::Info info;
  if (!file.GetInfo(&info) || info.is_directory || info.size < 0 ||
      info.size > static_cast<int64_t>(kMaximumRecordsBytes))
    return failure();
  std::string text(static_cast<size_t>(info.size), '\0');
  if (!file.ReadAtCurrentPosAndCheck(base::as_writable_byte_span(text)) ||
      !base::IsStringUTF8(text))
    return failure();
  return base::DictValue().Set("value", std::move(text));
}
std::string ReadRecordsResponse(base::FilePath directory) {
  auto result = ReadRecords(directory);
  if (auto* value = result.Find("value"))
    return Success(std::move(*value));
  return Failure("read_failed", *result.FindString("error"));
}
}  // namespace

struct EaselSharing::Request {
  std::unique_ptr<network::SimpleURLLoader> loader;
  Response response;
};

EaselSharing::EaselSharing(Profile* profile)
    : EaselSharing(DocumentStore::DefaultDirectory(), Enabled(),
                   profile->GetDefaultStoragePartition()
                       ->GetURLLoaderFactoryForBrowserProcess()) {}
EaselSharing::EaselSharing(
    base::FilePath directory, bool enabled,
    scoped_refptr<network::SharedURLLoaderFactory> factory)
    : directory_(std::move(directory)),
      enabled_(enabled),
      factory_(std::move(factory)) {
  snapshots_.Set("isEaselWebSharingEnabled", enabled_);
}
EaselSharing::~EaselSharing() = default;

void EaselSharing::Prepare(base::OnceClosure ready) {
  if (ready_) {
    std::move(ready).Run();
    return;
  }
  ready_callbacks_.push_back(std::move(ready));
  if (preparing_)
    return;
  preparing_ = true;
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&ReadRecords, directory_),
      base::BindOnce(&EaselSharing::Prepared, weak_factory_.GetWeakPtr()));
}
void EaselSharing::Prepared(base::DictValue result) {
  if (auto* value = result.Find("value"))
    snapshots_.Set("readEaselShareRecords", std::move(*value));
  ready_ = true;
  auto callbacks = std::move(ready_callbacks_);
  // A readiness callback can destroy this host.
  for (auto& callback : callbacks)
    std::move(callback).Run();
}
base::ListValue EaselSharing::SupportedMethods() {
  return base::ListValue()
      .Append("BayEasel.isEaselWebSharingEnabled")
      .Append("BayEasel.createEaselShareIdentity")
      .Append("BayEasel.requestShare")
      .Append("BayEasel.readEaselShareRecords");
}
bool EaselSharing::Dispatch(const std::string& module,
                            const std::string& method,
                            const base::ListValue& args,
                            Response& callback) {
  if (module != "BayEasel" ||
      (method != "isEaselWebSharingEnabled" &&
       method != "createEaselShareIdentity" && method != "readEaselShareRecords" &&
       method != "requestShare"))
    return false;
  if (method == "requestShare") {
    RequestShare(args, std::move(callback));
    return true;
  }
  if (!args.empty()) {
    std::move(callback).Run(Failure("invalid_args", "Invalid Easel arguments"));
    return true;
  }
  if (method == "isEaselWebSharingEnabled") {
    std::move(callback).Run(Success(base::Value(enabled_)));
  } else if (method == "createEaselShareIdentity") {
    std::array<uint8_t, 48> random;
    base::RandBytes(random);
    const std::string hex = base::HexEncodeLower(random);
    std::move(callback).Run(Success(base::Value(
        base::DictValue().Set("id", hex.substr(0, 32)).Set("key", hex.substr(32)))));
  } else {
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
        base::BindOnce(&ReadRecordsResponse, directory_), std::move(callback));
  }
  return true;
}
void EaselSharing::RequestShare(const base::ListValue& args,
                                Response response) {
  if (!enabled_) {
    std::move(response).Run(
        Failure("sharing_disabled", "Easel web sharing is disabled."));
    return;
  }
  if (args.size() != 4 || !args[0].is_string() || !args[1].is_string() ||
      !args[2].is_string() || !args[3].is_string()) {
    std::move(response).Run(Failure("invalid_args", "Invalid sharing request."));
    return;
  }
  const auto& id = args[0].GetString();
  const auto& key = args[1].GetString();
  const auto& method = args[2].GetString();
  const auto& body = args[3].GetString();
  if (!Hex(id, 32) || !Hex(key, 64) ||
      (method != "PUT" && method != "DELETE") ||
      (method == "DELETE" && !body.empty()) ||
      (method == "PUT" && (body.empty() || body.size() > kMaximumRecordsBytes ||
                            !base::IsStringUTF8(body)))) {
    std::move(response).Run(Failure("invalid_args", "Invalid sharing request."));
    return;
  }
  if (!factory_) {
    std::move(response).Run(Failure(
        "network_unavailable", "Easel sharing's network connection is unavailable."));
    return;
  }
  if (requests_.size() >= 8) {
    std::move(response).Run(Failure(
        "sharing_busy", "Too many sharing requests. Wait for them to finish."));
    return;
  }
  auto request = std::make_unique<network::ResourceRequest>();
  // This is deliberately not a general cross-origin fetch API.
  request->url = GURL("https://bay.krishkalaria.in/api/easels/" + id);
  request->method = method;
  request->credentials_mode = network::mojom::CredentialsMode::kOmit;
  request->redirect_mode = network::mojom::RedirectMode::kError;
  request->load_flags = net::LOAD_BYPASS_CACHE | net::LOAD_DISABLE_CACHE;
  request->headers.SetHeader("Authorization", "Bearer " + key);
  auto pending = std::make_unique<Request>();
  pending->response = std::move(response);
  pending->loader = network::SimpleURLLoader::Create(std::move(request),
                                                    kSharingAnnotation);
  pending->loader->SetTimeoutDuration(base::Seconds(60));
  pending->loader->SetAllowHttpErrorResults(true);
  if (method == "PUT")
    pending->loader->AttachStringForUpload(body, "application/json");
  const int request_id = ++next_request_;
  auto* loader = pending->loader.get();
  requests_.emplace(request_id, std::move(pending));
  loader->DownloadToString(
      factory_.get(),
      base::BindOnce(&EaselSharing::Requested, weak_factory_.GetWeakPtr(),
                     request_id),
      64 * 1024);
}
void EaselSharing::Requested(int id, std::optional<std::string> body) {
  auto found = requests_.find(id);
  if (found == requests_.end())
    return;
  auto request = std::move(found->second);
  requests_.erase(found);
  const auto* info = request->loader->ResponseInfo();
  std::string result;
  if (request->loader->NetError() != net::OK || !body || !info || !info->headers) {
    const bool timed_out = request->loader->NetError() == net::ERR_TIMED_OUT;
    result = Failure(
        "sharing_failed",
        timed_out ? "Sharing timed out. Retry or stop sharing to check the link's status."
                  : "Sharing failed. Check your connection and try again.");
  } else {
    result = Success(base::Value(
        base::DictValue().Set("status", info->headers->response_code())));
  }
  // Answering may destroy this document and the other pending requests.
  auto response = std::move(request->response);
  request.reset();
  std::move(response).Run(result);
}
}  // namespace bay
