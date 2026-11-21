// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/nn_search_suggestions.h"

#include "chrome/browser/bay/nn_search_suggestions_policy.h"

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/callback_list.h"
#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_util.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "chrome/browser/search_engines/template_url_service_factory.h"
#include "chrome/browser/search_engines/ui_thread_search_terms_data.h"
#include "components/search_engines/template_url.h"
#include "components/search_engines/template_url_service.h"
#include "content/public/browser/storage_partition.h"
#include "net/base/load_flags.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/fetch_api.mojom.h"

namespace bay {

namespace {
class SuggestionsState : public ProfileState {
 public:
  explicit SuggestionsState(Profile* profile) : ProfileState(profile) {}

  void Fetch(std::string client, GURL url, Reply reply) {
    Cancel(client, "suggestion request superseded");
    if (requests_.size() >= 8) {
      reply.Error("too many suggestion requests");
      return;
    }
    auto request = std::make_unique<Request>(std::move(url), std::move(reply));
    request->timeout.Start(
        FROM_HERE, base::Seconds(3),
        base::BindOnce(&SuggestionsState::Cancel, weak_.GetWeakPtr(), client,
                       "suggestion request timed out"));
    requests_.emplace(client, std::move(request));
    auto* service = TemplateURLServiceFactory::GetForProfile(profile());
    if (!IsBuiltInSuggestionEndpoint(requests_.at(client)->url) && service &&
        !service->loaded()) {
      if (!subscription_) {
        subscription_ = service->RegisterOnLoadedCallback(
            base::BindOnce(&SuggestionsState::Loaded, weak_.GetWeakPtr()));
        service->Load();
      }
      return;
    }
    Start(client);
  }

 private:
  struct Request {
    Request(GURL address, Reply callback)
        : url(std::move(address)), reply(std::move(callback)) {}
    GURL url;
    Reply reply;
    base::OneShotTimer timeout;
    std::unique_ptr<network::SimpleURLLoader> loader;
  };

  void Release() override {
    weak_.InvalidateWeakPtrs();
    subscription_ = {};
    requests_.clear();
  }

  void Cancel(const std::string& client, const char* message) {
    auto entry = requests_.extract(client);
    if (!entry.empty())
      entry.mapped()->reply.Error(message);
  }

  void Loaded() {
    subscription_ = {};
    std::vector<std::string> waiting;
    for (const auto& [client, request] : requests_) {
      if (!request->loader)
        waiting.push_back(client);
    }
    for (const auto& client : waiting)
      Start(client);
  }

  bool Allowed(const GURL& url) {
    if (IsBuiltInSuggestionEndpoint(url))
      return true;
    auto* service = TemplateURLServiceFactory::GetForProfile(profile());
    if (!service || !service->loaded())
      return false;
    UIThreadSearchTermsData terms;
    for (TemplateURL* engine : service->GetTemplateURLs()) {
      if (MatchesSuggestionEndpoint(
              url, GURL(engine->suggestions_url_ref().DisplayURL(terms)))) {
        return true;
      }
    }
    return false;
  }

  void Start(const std::string& client) {
    auto found = requests_.find(client);
    if (found == requests_.end())
      return;
    auto& job = *found->second;
    if (!Allowed(job.url)) {
      Cancel(client, "suggestion endpoint is not configured for this profile");
      return;
    }
    auto request = std::make_unique<network::ResourceRequest>();
    request->url = job.url;
    request->credentials_mode = network::mojom::CredentialsMode::kOmit;
    request->redirect_mode = network::mojom::RedirectMode::kError;
    request->load_flags = net::LOAD_DO_NOT_SAVE_COOKIES | net::LOAD_DISABLE_CACHE;
    job.loader = network::SimpleURLLoader::Create(
        std::move(request),
        net::DefineNetworkTrafficAnnotation("bay_search_suggestions", R"(
          semantics { sender: "Bay search suggestions"
            description: "Retrieves suggestions from the selected search provider."
            trigger: "The user types in the address palette with search suggestions enabled."
            data: "The text typed into the address palette."
            destination: WEBSITE }
          policy { cookies_allowed: NO
            setting: "Disabled by turning off Search Suggestions in Bay settings."
            policy_exception_justification: "This user-controlled feature does not have a separate enterprise policy." })"));
    job.loader->SetTimeoutDuration(base::Seconds(3));
    job.loader->DownloadToString(
        profile()->GetDefaultStoragePartition()
            ->GetURLLoaderFactoryForBrowserProcess().get(),
        base::BindOnce(&SuggestionsState::Downloaded, weak_.GetWeakPtr(), client),
        64 * 1024);
  }

  void Downloaded(const std::string& client, std::optional<std::string> body) {
    auto entry = requests_.extract(client);
    if (entry.empty())
      return;
    if (!body || !base::IsStringUTF8(*body)) {
      entry.mapped()->reply.Error("could not fetch search suggestions");
      return;
    }
    entry.mapped()->reply.Send(base::DictValue().Set("body", std::move(*body)));
  }

  base::CallbackListSubscription subscription_;
  std::map<std::string, std::unique_ptr<Request>> requests_;
  base::WeakPtrFactory<SuggestionsState> weak_{this};
};
}  // namespace
}  // namespace bay

NN_ENGINE_CALL(nn_search_suggestions) {
  bay::Call call(profile_dir, args_json, reply, context);
  if (!call)
    return;
  const auto client = call.String("client");
  const auto url = call.String("url");
  if (call.args().size() != 2 || client.empty() || client.size() > 128 ||
      client.find_first_not_of(
          "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_:") !=
          std::string::npos ||
      url.empty() || url.size() > 8192) {
    call.TakeReply().Error("invalid suggestion request");
    return;
  }
  bay::StateFor<bay::SuggestionsState>(call.profile())
      .Fetch(client, GURL(url), call.TakeReply());
}
