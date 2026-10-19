// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_PAGE_SECURITY_H_
#define CHROME_BROWSER_BAY_WEBUI_PAGE_SECURITY_H_

#include "net/cert/cert_status_flags.h"

namespace content {
struct SSLStatus;
}
namespace bay {
net::CertStatus PageCertificateErrors(net::CertStatus status);
// HTTPS connection state can be absent while a visible pending entry loads.
// A missing handshake or certificate alone is not a certificate failure.
const char* PageSecurityLevel(const content::SSLStatus& ssl);
}  // namespace bay
#endif
