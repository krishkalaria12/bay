#pragma once
#include "../windows/ImportCore.h"
namespace bay::importer {
// A backend returns the original Safe Storage password, not an AES key. The
// caller owns and wipes the returned bytes. Production never creates an item.
class LinuxSecretLookup {
public:
  virtual ~LinuxSecretLookup() = default;
  virtual Bytes lookup(LinuxChromiumBrowser browser,
                       LinuxSecretBackend backend) = 0;
};
// Scoped process-wide injection for service tests. The shared backend remains
// alive for an in-flight unlock. Tests must serialize installation of
// overrides.
class ScopedLinuxSecretLookupForTesting {
  std::shared_ptr<LinuxSecretLookup> previous_;

public:
  explicit ScopedLinuxSecretLookupForTesting(
      std::shared_ptr<LinuxSecretLookup> lookup);
  ~ScopedLinuxSecretLookupForTesting();
  ScopedLinuxSecretLookupForTesting(const ScopedLinuxSecretLookupForTesting &) =
      delete;
  ScopedLinuxSecretLookupForTesting &
  operator=(const ScopedLinuxSecretLookupForTesting &) = delete;
};
ChromiumSecretContext unlockLinuxChromiumSecrets(LinuxChromiumBrowser browser,
                                                 bool consent,
                                                 LinuxSecretBackend backend,
                                                 LinuxSecretLookup &lookup);
Bytes decryptLinuxChromiumSecret(const Bytes &value,
                                 const ChromiumSecretContext &context);
} // namespace bay::importer
