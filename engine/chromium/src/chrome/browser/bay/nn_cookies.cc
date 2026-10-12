// Copyright 2026 Bay. Apache-2.0.

#include "chrome/browser/bay/nn_cookies.h"

#include <cmath>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/barrier_callback.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/time/time.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "chrome/browser/bay/nn_sensitive_args.h"
#include "content/public/browser/storage_partition.h"
#include "net/cookies/canonical_cookie.h"
#include "net/cookies/cookie_access_result.h"
#include "net/cookies/cookie_constants.h"
#include "net/cookies/cookie_inclusion_status.h"
#include "net/cookies/cookie_options.h"
#include "net/cookies/cookie_partition_key.h"
#include "services/network/public/mojom/cookie_manager.mojom.h"
#include "url/gurl.h"
#include "url/third_party/mozilla/url_parse.h"

namespace bay {
namespace {

constexpr size_t kMaxCookies = 1000;
constexpr size_t kMaxArgsBytes = 4 * 1024 * 1024;

// A time argument in ms since the Unix epoch; nullopt when absent, 0 or bad.
std::optional<base::Time> TimeArg(const base::DictValue& dict,
                                  std::string_view key) {
  std::optional<double> ms = dict.FindDouble(key);
  if (!ms || !std::isfinite(*ms) || *ms <= 0) {
    return std::nullopt;
  }
  return base::Time::FromMillisecondsSinceUnixEpoch(*ms);
}

std::string_view StringArg(const base::DictValue& dict, std::string_view key) {
  const std::string* value = dict.FindString(key);
  return value ? std::string_view(*value) : std::string_view();
}

net::CookieSameSite SameSiteArg(std::string_view value) {
  if (value == "none") {
    return net::CookieSameSite::NO_RESTRICTION;
  }
  if (value == "lax") {
    return net::CookieSameSite::LAX_MODE;
  }
  if (value == "strict") {
    return net::CookieSameSite::STRICT_MODE;
  }
  return net::CookieSameSite::UNSPECIFIED;
}

net::CookiePriority PriorityArg(std::string_view value) {
  if (value == "low") {
    return net::COOKIE_PRIORITY_LOW;
  }
  if (value == "high") {
    return net::COOKIE_PRIORITY_HIGH;
  }
  return net::COOKIE_PRIORITY_MEDIUM;
}

int PortArg(const base::DictValue& dict) {
  if (std::optional<int> port = dict.FindInt("sourcePort")) {
    return *port;
  }
  std::optional<double> port = dict.FindDouble("sourcePort");
  if (port && std::isfinite(*port) && *port >= 0 && *port <= 65535) {
    return static_cast<int>(*port);
  }
  return url::PORT_UNSPECIFIED;
}

struct Imported {
  std::unique_ptr<net::CanonicalCookie> cookie;
  GURL source_url;
};

// One cookie as Chrome would accept it fresh from |source_url| (public
// suffixes, sizes, prefixes, Secure only from a secure URL), or nullopt.
std::optional<Imported> ToCookie(const base::Value& entry, base::Time now) {
  const base::DictValue* dict = entry.GetIfDict();
  if (!dict) {
    return std::nullopt;
  }
  const std::string* name = dict->FindString("name");
  const std::string* value = dict->FindString("value");
  const std::string* domain = dict->FindString("domain");
  const std::string* path = dict->FindString("path");
  if (!name || !value || !domain || !path || domain->empty()) {
    return std::nullopt;
  }
  const bool secure = dict->FindBool("secure").value_or(false);
  const bool source_secure = StringArg(*dict, "sourceScheme") == "secure";
  const int source_port = PortArg(*dict);

  // The URL that set it: its scheme, host and port, and the path. A domain
  // cookie (".example.com") keeps its domain attribute; a host-only one has
  // none.
  const bool domain_cookie = domain->starts_with('.');
  std::string_view host = *domain;
  if (domain_cookie) {
    host.remove_prefix(1);
  }
  std::string spec = secure || source_secure ? "https://" : "http://";
  spec.append(host);
  if (source_port > 0 && source_port <= 65535) {
    spec.append(":").append(base::NumberToString(source_port));
  }
  spec.append(*path);
  GURL source_url(spec);
  if (!source_url.is_valid()) {
    return std::nullopt;
  }

  base::Time creation = TimeArg(*dict, "created").value_or(now);
  if (creation > now) {
    creation = now;
  }
  base::Time last_access = TimeArg(*dict, "lastAccess").value_or(creation);
  if (last_access < creation) {
    last_access = creation;
  }
  if (last_access > now) {
    last_access = now;
  }

  // Chromium's own serialization (the reader converts other browsers' to it):
  // an empty site is an unpartitioned cookie, anything unparseable is
  // rejected.
  std::optional<net::CookiePartitionKey> partition_key;
  if (const base::DictValue* key = dict->FindDict("partitionKey")) {
    const std::string* site = key->FindString("topLevelSite");
    base::expected<std::optional<net::CookiePartitionKey>, std::string> parsed =
        net::CookiePartitionKey::FromStorage(
            site ? *site : std::string(),
            key->FindBool("crossSite").value_or(false));
    if (!parsed.has_value()) {
      return std::nullopt;
    }
    partition_key = std::move(parsed).value();
  }

  // Caps the expiry from the creation date the way Chrome caps any cookie it
  // sets.
  net::CookieInclusionStatus status;
  std::unique_ptr<net::CanonicalCookie> cookie =
      net::CanonicalCookie::CreateSanitizedCookie(
          source_url, *name, *value, domain_cookie ? *domain : std::string(),
          *path, creation, TimeArg(*dict, "expires").value_or(base::Time()),
          last_access, secure, dict->FindBool("httpOnly").value_or(false),
          SameSiteArg(StringArg(*dict, "sameSite")),
          PriorityArg(StringArg(*dict, "priority")), std::move(partition_key),
          &status);
  if (!cookie || cookie->IsExpired(now)) {
    return std::nullopt;
  }
  // The fresh-cookie rules can canonicalize a cookie into another scope (a
  // path's "..", a public-suffix domain made host-only): import a cookie only
  // as the source stored it.
  if (cookie->Domain() != base::ToLowerASCII(*domain) ||
      cookie->Path() != *path) {
    return std::nullopt;
  }
  return Imported{std::move(cookie), std::move(source_url)};
}

struct Counts {
  int imported = 0;
  int rejected = 0;
  int replaced = 0;
};

network::mojom::CookieManager* CookieManagerOf(Profile* profile) {
  return profile->GetDefaultStoragePartition()
      ->GetCookieManagerForBrowserProcess();
}

// Every write has run: flush them to disk, then reply.
void Written(base::WeakPtr<Profile> profile,
             Counts counts,
             Reply reply,
             const std::vector<bool>& results) {
  for (bool included : results) {
    ++(included ? counts.imported : counts.rejected);
  }
  if (!profile) {
    return reply.Error("profile closed");
  }
  CookieManagerOf(profile.get())
      ->FlushCookieStore(base::BindOnce(
          [](Reply reply, Counts counts) {
            reply.Send(base::DictValue()
                           .Set("imported", counts.imported)
                           .Set("rejected", counts.rejected)
                           .Set("replaced", counts.replaced));
          },
          std::move(reply), counts));
}

// The old cookies are gone: writes the imported ones (the first of equivalent
// ones in the same import).
void WriteImported(base::WeakPtr<Profile> profile,
                   std::vector<Imported> cookies,
                   Counts counts,
                   Reply reply,
                   const std::vector<bool>& /*deleted*/) {
  if (!profile) {
    return reply.Error("profile closed");
  }
  std::map<std::string_view, std::vector<const net::CanonicalCookie*>>
      by_domain;
  std::vector<const Imported*> fresh;
  for (const Imported& imported : cookies) {
    std::vector<const net::CanonicalCookie*>& same =
        by_domain[imported.cookie->Domain()];
    bool duplicate = false;
    for (const net::CanonicalCookie* earlier : same) {
      if (imported.cookie->IsEquivalent(*earlier)) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) {
      fresh.push_back(&imported);
      same.push_back(imported.cookie.get());
    }
  }
  base::RepeatingCallback<void(bool)> barrier = base::BarrierCallback<bool>(
      fresh.size(),
      base::BindOnce(&Written, profile, counts, std::move(reply)));
  network::mojom::CookieManager* manager = CookieManagerOf(profile.get());
  for (const Imported* imported : fresh) {
    manager->SetCanonicalCookie(*imported->cookie, imported->source_url,
                                net::CookieOptions::MakeAllInclusive(),
                                base::BindOnce(
                                    [](base::RepeatingCallback<void(bool)> done,
                                       net::CookieAccessResult result) {
                                      done.Run(result.status.IsInclude());
                                    },
                                    barrier));
  }
}

// The import replaces each site's cookies (by domain and partition) with the
// source's: a sign-in is several cookies, and keeping the profile's where the
// source has its own mixed two sessions, which sites (Google) read as signed
// out.
void Replace(base::WeakPtr<Profile> profile,
             std::vector<Imported> cookies,
             Counts counts,
             Reply reply,
             const std::vector<net::CanonicalCookie>& present) {
  if (!profile) {
    return reply.Error("profile closed");
  }
  std::map<std::string_view,
           std::vector<const std::optional<net::CookiePartitionKey>*>>
      sites;
  for (const Imported& imported : cookies) {
    sites[imported.cookie->Domain()].push_back(
        &imported.cookie->PartitionKey());
  }
  std::vector<const net::CanonicalCookie*> old;
  for (const net::CanonicalCookie& cookie : present) {
    auto it = sites.find(cookie.Domain());
    if (it == sites.end()) {
      continue;
    }
    for (const std::optional<net::CookiePartitionKey>* key : it->second) {
      if (*key == cookie.PartitionKey()) {
        old.push_back(&cookie);
        break;
      }
    }
  }
  counts.replaced = static_cast<int>(old.size());
  base::RepeatingCallback<void(bool)> barrier = base::BarrierCallback<bool>(
      old.size(), base::BindOnce(&WriteImported, profile, std::move(cookies),
                                 counts, std::move(reply)));
  network::mojom::CookieManager* manager = CookieManagerOf(profile.get());
  for (const net::CanonicalCookie* cookie : old) {
    manager->DeleteCanonicalCookie(*cookie, barrier);
  }
}

}  // namespace
}  // namespace bay

NN_ENGINE_CALL(nn_cookies_import) {
  // Parsed here, not by Call, so this copy of the values is ours to zero.
  bay::Call call(profile_dir, nullptr, reply, context);
  if (!call) {
    return;
  }
  if (call.profile()->IsOffTheRecord()) {
    return call.TakeReply().Error("private profile");
  }

  std::vector<bay::Imported> cookies;
  bay::Counts counts;
  {
    bay::SensitiveArgs args(args_json, bay::kMaxArgsBytes);
    if (args.too_large()) {
      return call.TakeReply().Error("arguments too large");
    }
    if (!args.dict()) {
      return call.TakeReply().Error("arguments are not a JSON object");
    }
    const base::ListValue* list = args.dict()->FindList("cookies");
    if (!list) {
      return call.TakeReply().Error("cookies must be a list");
    }
    if (list->size() > bay::kMaxCookies) {
      return call.TakeReply().Error("too many cookies in one call");
    }
    const base::Time now = base::Time::Now();
    cookies.reserve(list->size());
    for (const base::Value& entry : *list) {
      std::optional<bay::Imported> cookie =
          bay::ToCookie(entry, now);
      if (cookie) {
        cookies.push_back(std::move(*cookie));
      } else {
        ++counts.rejected;
      }
    }
  }  // The parsed arguments are zeroed here.

  if (cookies.empty()) {
    return call.TakeReply().Send(base::DictValue()
                                     .Set("imported", 0)
                                     .Set("rejected", counts.rejected)
                                     .Set("replaced", 0));
  }
  bay::CookieManagerOf(call.profile())
      ->GetAllCookies(
          base::BindOnce(&bay::Replace, call.profile()->GetWeakPtr(),
                         std::move(cookies), counts, call.TakeReply()));
}
