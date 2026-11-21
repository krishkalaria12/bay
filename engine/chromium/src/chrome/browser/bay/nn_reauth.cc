// Copyright 2026 Bay. Apache-2.0.

#include "chrome/browser/bay/nn_reauth.h"

#include <stdlib.h>
#include <string.h>

#include <memory>
#include <utility>

#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/logging.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/utf_string_conversions.h"
#include "build/build_config.h"
#include "chrome/browser/bay/nn_engine.h"

#if !BUILDFLAG(IS_LINUX)
#include "chrome/browser/device_reauth/chrome_device_authenticator_factory.h"
#include "components/device_reauth/device_authenticator.h"
#endif

#if BUILDFLAG(IS_MAC)
#include <Security/Security.h>

#include "base/apple/scoped_cftyperef.h"
#include "base/command_line.h"
#include "components/os_crypt/common/os_crypt_switches.h"
#endif

namespace bay {
namespace {

bool HiddenTestInstance() {
  const char* background = getenv("BAY_BACKGROUND");
  return background && !strcmp(background, "1");
}

#if BUILDFLAG(IS_MAC)
// Whether this code is signed for distribution: a Mac App Store or Developer ID
// signature, as every shipped build is. Any API failure counts as signed, so the
// test grant fails closed.
bool SignedForDistribution() {
  base::apple::ScopedCFTypeRef<SecCodeRef> self;
  if (SecCodeCopySelf(kSecCSDefaultFlags, self.InitializeInto()) !=
      errSecSuccess) {
    return true;
  }
  base::apple::ScopedCFTypeRef<SecRequirementRef> distribution;
  if (SecRequirementCreateWithString(
          CFSTR("anchor apple generic and "
                "(certificate leaf[field.1.2.840.113635.100.6.1.9] exists or "
                "certificate 1[field.1.2.840.113635.100.6.2.6] exists and "
                "certificate leaf[field.1.2.840.113635.100.6.1.13] exists)"),
          kSecCSDefaultFlags, distribution.InitializeInto()) != errSecSuccess) {
    return true;
  }
  return SecCodeCheckValidity(self.get(), kSecCSDefaultFlags,
                              distribution.get()) == errSecSuccess;
}

// BAY_TEST_REAUTH counts only in a build that isn't signed for distribution
// (Debug, ad hoc) and on Chrome's mock keychain, where the real Safe Storage key
// can't be read: whatever data dir it points at, nothing saved by the real app
// decrypts. A shipped build never honours it.
bool TestGrantHonoured() {
  static const bool honoured =
      !SignedForDistribution() &&
      base::CommandLine::ForCurrentProcess()->HasSwitch(
          os_crypt::switches::kUseMockKeychain);
  return honoured;
}
#else
bool TestGrantHonoured() {
  // Other hosts have no mock-keychain isolation for this test grant.
  return false;
}
#endif

bool TestGrant() {
  const char* grant = getenv("BAY_TEST_REAUTH");
  return grant && !strcmp(grant, "granted") && TestGrantHonoured();
}

#if !BUILDFLAG(IS_LINUX)
const char* Histogram(device_reauth::DeviceAuthSource source) {
  return source == device_reauth::DeviceAuthSource::kPasswordManager
             ? "PasswordManager.ReauthToAccessPasswordInSettings"
             : "Autofill.PaymentMethods.SettingsPage.Reauth";
}

// The profile's authentication in progress (one at a time).
class ReauthState : public ProfileState {
 public:
  explicit ReauthState(Profile* profile) : ProfileState(profile) {}

  void Start(device_reauth::DeviceAuthSource source,
             const std::u16string& purpose,
             base::TimeDelta validity,
             base::OnceCallback<void(bool)> done) {
    base::WeakPtr<ReauthState> self = weak_factory_.GetWeakPtr();
    const int generation = ++generation_;
    // Cancelling answers the older request (false) synchronously. Its reply
    // may start another request (which then wins: this one fails) or let the
    // profile go.
    while (authenticator_) {
      std::unique_ptr<device_reauth::DeviceAuthenticator> older =
          std::move(authenticator_);
      older->Cancel();
      older.reset();
      if (!self) {
        return;
      }
      if (generation_ != generation) {
        std::move(done).Run(false);
        return;
      }
    }
    authenticator_ = ChromeDeviceAuthenticatorFactory::GetForProfile(
        profile(), device_reauth::DeviceAuthParams(validity, source,
                                                   Histogram(source)));
    authenticator_->AuthenticateWithMessage(
        purpose, base::BindOnce(&ReauthState::Done, self, generation,
                                std::move(done)));
  }

 private:
  void Release() override {
    weak_factory_.InvalidateWeakPtrs();
    authenticator_.reset();
  }

  void Done(int generation,
            base::OnceCallback<void(bool)> done,
            bool authenticated) {
    if (generation == generation_) {
      // As PasswordsPrivateDelegateImpl::OnReauthCompleted: the authenticator
      // allows going away inside its own callback.
      authenticator_.reset();
    }
    std::move(done).Run(authenticated);
  }

  std::unique_ptr<device_reauth::DeviceAuthenticator> authenticator_;
  int generation_ = 0;
  base::WeakPtrFactory<ReauthState> weak_factory_{this};
};
#endif  // !BUILDFLAG(IS_LINUX)

}  // namespace

void Reauth(Profile* profile,
            device_reauth::DeviceAuthSource source,
            const std::u16string& purpose,
            base::TimeDelta validity,
            base::OnceCallback<void(bool)> done) {
  if (HiddenTestInstance()) {
    const bool granted = TestGrant();
    LOG(WARNING) << "[bay] OS reauth (" << purpose
                 << ") in a hidden test instance, no prompt: "
                 << (granted ? "granted" : "denied");
    Emit("reauth.requested", profile,
         base::DictValue().Set("purpose", purpose).Set("granted", granted));
    std::move(done).Run(granted);
    return;
  }
#if BUILDFLAG(IS_LINUX)
  // As Chrome's password page on Linux: there is no OS authenticator to ask.
  std::move(done).Run(true);
#else
  StateFor<ReauthState>(profile).Start(source, purpose, validity,
                                       std::move(done));
#endif
}

}  // namespace bay
