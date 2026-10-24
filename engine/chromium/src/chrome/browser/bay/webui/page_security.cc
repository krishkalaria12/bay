// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/page_security.h"

#include "content/public/browser/ssl_status.h"

namespace bay {
net::CertStatus PageCertificateErrors(net::CertStatus status) {
  return status & net::CERT_STATUS_ALL_ERRORS &
         ~(net::CERT_STATUS_NO_REVOCATION_MECHANISM |
           net::CERT_STATUS_UNABLE_TO_CHECK_REVOCATION);
}
const char* PageSecurityLevel(const content::SSLStatus& ssl) {
  if (!ssl.initialized)
    return "none";
  if (PageCertificateErrors(ssl.cert_status))
    return "certificateError";
  if (!ssl.certificate)
    return "none";
  const int mixed = content::SSLStatus::RAN_INSECURE_CONTENT |
                    content::SSLStatus::RAN_CONTENT_WITH_CERT_ERRORS |
                    content::SSLStatus::DISPLAYED_INSECURE_CONTENT |
                    content::SSLStatus::DISPLAYED_CONTENT_WITH_CERT_ERRORS;
  return ssl.content_status & mixed ? "mixed" : "secure";
}
}  // namespace bay
