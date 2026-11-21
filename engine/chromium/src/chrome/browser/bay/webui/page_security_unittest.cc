// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/page_security.h"

#include "content/public/browser/ssl_status.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
TEST(PageSecurityTest, PendingHttpsWithoutAHandshakeIsNeutral) {
  content::SSLStatus pending;
  ASSERT_FALSE(pending.initialized);
  ASSERT_FALSE(pending.certificate);
  EXPECT_STREQ(PageSecurityLevel(pending), "none");
  // Uninitialized metadata must not become an asserted certificate failure.
  pending.cert_status = net::CERT_STATUS_DATE_INVALID;
  EXPECT_STREQ(PageSecurityLevel(pending), "none");
}
TEST(PageSecurityTest, MissingCertificateAloneDoesNotAssertAnError) {
  content::SSLStatus connection;
  connection.initialized = true;
  ASSERT_FALSE(connection.certificate);
  EXPECT_STREQ(PageSecurityLevel(connection), "none");
  connection.cert_status = net::CERT_STATUS_NO_REVOCATION_MECHANISM |
                           net::CERT_STATUS_UNABLE_TO_CHECK_REVOCATION;
  EXPECT_STREQ(PageSecurityLevel(connection), "none");
}
TEST(PageSecurityTest, ReportsRealCertificateFailuresAfterInitialization) {
  content::SSLStatus connection;
  connection.initialized = true;
  for (auto status :
       {net::CERT_STATUS_DATE_INVALID, net::CERT_STATUS_COMMON_NAME_INVALID,
        net::CERT_STATUS_AUTHORITY_INVALID, net::CERT_STATUS_REVOKED}) {
    connection.cert_status = status;
    EXPECT_STREQ(PageSecurityLevel(connection), "certificateError");
  }
}
TEST(PageSecurityTest, FiltersOnlyTheExistingAdvisoryRevocationStatuses) {
  EXPECT_EQ(PageCertificateErrors(net::CERT_STATUS_NO_REVOCATION_MECHANISM |
                                  net::CERT_STATUS_UNABLE_TO_CHECK_REVOCATION),
            0u);
  EXPECT_EQ(PageCertificateErrors(net::CERT_STATUS_AUTHORITY_INVALID |
                                  net::CERT_STATUS_NO_REVOCATION_MECHANISM),
            net::CERT_STATUS_AUTHORITY_INVALID);
}
}  // namespace bay
