// Copyright 2026 Bay. Apache-2.0.
// A page's connection security as both desktop hosts report it (JS
// SecurityInfo): macOS (nn_tab_info.mm) and Windows and Linux
// (webui/page_services.cc).
#ifndef BAY_CORE_NN_PAGE_SECURITY_H_
#define BAY_CORE_NN_PAGE_SECURITY_H_

#include "base/values.h"
#include "net/cert/cert_status_flags.h"

namespace content {
struct SSLStatus;
class WebContents;
}  // namespace content

namespace nncore {

// The certificate's errors, without "couldn't check revocation".
net::CertStatus PageCertificateErrors(net::CertStatus status);

// HTTPS connection state can be absent while a visible pending entry loads. A
// missing handshake or certificate alone is not a certificate failure.
const char* PageSecurityLevel(const content::SSLStatus& ssl);

// The visible entry's {url, origin, level, certificateErrors, mixedContent,
// isEV, protocol, certificate}.
base::DictValue PageSecurityInfo(content::WebContents* contents);

}  // namespace nncore

#endif  // BAY_CORE_NN_PAGE_SECURITY_H_
