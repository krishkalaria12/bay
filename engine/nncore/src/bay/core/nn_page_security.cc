// Copyright 2026 Bay. Apache-2.0.
#include "bay/core/nn_page_security.h"

#include <string>
#include <utility>

#include "base/containers/span.h"
#include "base/strings/string_number_conversions.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/ssl_status.h"
#include "content/public/browser/web_contents.h"
#include "net/cert/x509_certificate.h"
#include "net/ssl/ssl_connection_status_flags.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace nncore {
namespace {

std::string Hex(base::span<const uint8_t> bytes) {
  std::string result;
  for (uint8_t byte : bytes) {
    if (!result.empty()) {
      result += ':';
    }
    result += base::HexEncode(base::span_from_ref(byte));
  }
  return result;
}

base::DictValue Principal(const net::CertPrincipal& principal) {
  base::ListValue organizations;
  for (const auto& name : principal.organization_names) {
    organizations.Append(name);
  }
  return base::DictValue()
      .Set("commonName", principal.common_name)
      .Set("displayName", principal.GetDisplayName())
      .Set("organizations", std::move(organizations))
      .Set("country", principal.country_name);
}

base::ListValue CertificateErrorNames(net::CertStatus errors) {
  static constexpr std::pair<net::CertStatus, const char*> kErrors[] = {
      {net::CERT_STATUS_COMMON_NAME_INVALID, "nameMismatch"},
      {net::CERT_STATUS_DATE_INVALID, "dateInvalid"},
      {net::CERT_STATUS_AUTHORITY_INVALID, "authorityInvalid"},
      {net::CERT_STATUS_REVOKED, "revoked"},
      {net::CERT_STATUS_INVALID, "invalid"},
      {net::CERT_STATUS_WEAK_SIGNATURE_ALGORITHM, "weakSignature"},
      {net::CERT_STATUS_NON_UNIQUE_NAME, "nonUniqueName"},
      {net::CERT_STATUS_WEAK_KEY, "weakKey"},
      {net::CERT_STATUS_PINNED_KEY_MISSING, "pinnedKeyMissing"},
      {net::CERT_STATUS_NAME_CONSTRAINT_VIOLATION, "nameConstraint"},
      {net::CERT_STATUS_VALIDITY_TOO_LONG, "validityTooLong"},
      {net::CERT_STATUS_CERTIFICATE_TRANSPARENCY_REQUIRED,
       "certificateTransparency"},
  };
  base::ListValue names;
  for (const auto& [bit, name] : kErrors) {
    if (errors & bit) {
      names.Append(name);
    }
  }
  return names;
}

const char* Protocol(int connection_status) {
  switch (net::SSLConnectionStatusToVersion(connection_status)) {
    case net::SSL_CONNECTION_VERSION_TLS1:
      return "TLS 1.0";
    case net::SSL_CONNECTION_VERSION_TLS1_1:
      return "TLS 1.1";
    case net::SSL_CONNECTION_VERSION_TLS1_2:
      return "TLS 1.2";
    case net::SSL_CONNECTION_VERSION_TLS1_3:
      return "TLS 1.3";
    case net::SSL_CONNECTION_VERSION_QUIC:
      return "QUIC";
    default:
      return nullptr;
  }
}

}  // namespace

net::CertStatus PageCertificateErrors(net::CertStatus status) {
  return status & net::CERT_STATUS_ALL_ERRORS &
         ~(net::CERT_STATUS_NO_REVOCATION_MECHANISM |
           net::CERT_STATUS_UNABLE_TO_CHECK_REVOCATION);
}

const char* PageSecurityLevel(const content::SSLStatus& ssl) {
  if (!ssl.initialized) {
    return "none";
  }
  if (PageCertificateErrors(ssl.cert_status)) {
    return "certificateError";
  }
  if (!ssl.certificate) {
    return "none";
  }
  const int mixed = content::SSLStatus::RAN_INSECURE_CONTENT |
                    content::SSLStatus::RAN_CONTENT_WITH_CERT_ERRORS |
                    content::SSLStatus::DISPLAYED_INSECURE_CONTENT |
                    content::SSLStatus::DISPLAYED_CONTENT_WITH_CERT_ERRORS;
  return ssl.content_status & mixed ? "mixed" : "secure";
}

base::DictValue PageSecurityInfo(content::WebContents* contents) {
  base::DictValue info;
  if (!contents) {
    info.Set("level", "none");
    return info;
  }
  content::NavigationEntry* entry = contents->GetController().GetVisibleEntry();
  const GURL url = entry ? entry->GetURL() : contents->GetVisibleURL();
  info.Set("url", url.spec());
  info.Set("origin", url.SchemeIsHTTPOrHTTPS() && url.has_host()
                         ? base::Value(url::Origin::Create(url).Serialize())
                         : base::Value());
  if (url.SchemeIs("http") || url.SchemeIs("ws")) {
    info.Set("level", "insecure");
    return info;
  }
  if (!url.SchemeIs("https") && !url.SchemeIs("wss")) {
    info.Set("level",
             !url.is_empty() && url != GURL("about:blank") ? "local" : "none");
    return info;
  }
  if (!entry) {
    info.Set("level", "none");
    return info;
  }
  const content::SSLStatus& ssl = entry->GetSSL();
  const std::string level = PageSecurityLevel(ssl);
  info.Set("level", level);
  if (level == "none") {
    return info;
  }
  const bool ran =
      ssl.content_status & (content::SSLStatus::RAN_INSECURE_CONTENT |
                            content::SSLStatus::RAN_CONTENT_WITH_CERT_ERRORS);
  const bool displayed =
      ssl.content_status &
      (content::SSLStatus::DISPLAYED_INSECURE_CONTENT |
       content::SSLStatus::DISPLAYED_CONTENT_WITH_CERT_ERRORS);
  info.Set("certificateErrors",
           CertificateErrorNames(PageCertificateErrors(ssl.cert_status)));
  info.Set("mixedContent", ran         ? base::Value("ran")
                           : displayed ? base::Value("displayed")
                                       : base::Value());
  info.Set("isEV", (ssl.cert_status & net::CERT_STATUS_IS_EV) != 0);
  if (const char* protocol = Protocol(ssl.connection_status)) {
    info.Set("protocol", protocol);
  }
  if (const net::X509Certificate* cert = ssl.certificate.get()) {
    info.Set(
        "certificate",
        base::DictValue()
            .Set("subject", Principal(cert->subject()))
            .Set("issuer", Principal(cert->issuer()))
            .Set("validFrom",
                 cert->valid_start().InMillisecondsFSinceUnixEpoch())
            .Set("validUntil",
                 cert->valid_expiry().InMillisecondsFSinceUnixEpoch())
            .Set("chainLength",
                 static_cast<int>(cert->intermediate_buffers().size() + 1))
            .Set("serialNumber", Hex(cert->serial_number()))
            .Set("sha256", Hex(net::X509Certificate::CalculateFingerprint256(
                               cert->cert_buffer()))));
  }
  return info;
}

}  // namespace nncore
