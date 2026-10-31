// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_SECRET_STORAGE_LINUX_H_
#define CHROME_BROWSER_BAY_WEBUI_SECRET_STORAGE_LINUX_H_

#include <string>
#include <string_view>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/sequence_checker.h"
#include "base/values.h"

namespace os_crypt_async {
class Encryptor;
}

namespace bay {

// The key os_crypt protects saved passwords, cookies and card numbers with:
// "keyring" for a key held by the Secret Service, KWallet or the Secret
// portal; "basic" for the fixed v10 key every Chromium build shares, which any
// app running as the user can read; "unavailable" when nothing can encrypt.
std::string_view SecretStorageKind(const os_crypt_async::Encryptor& encryptor);

// BayCEF.secretStorage for one document. The encryptor can wait on a keyring
// unlock prompt; destroying the owner settles every pending request once.
class SecretStorage {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;
  SecretStorage();
  ~SecretStorage();
  SecretStorage(const SecretStorage&) = delete;
  SecretStorage& operator=(const SecretStorage&) = delete;

  static base::ListValue SupportedMethods();
  // False leaves callback untouched.
  bool Dispatch(const std::string& module,
                const std::string& method,
                const base::ListValue& args,
                Response& callback);

 private:
  void Resolved(scoped_refptr<os_crypt_async::Encryptor> encryptor);

  // Every request waits on the one outstanding encryptor lookup.
  std::vector<Response> pending_;
  SEQUENCE_CHECKER(sequence_checker_);
  base::WeakPtrFactory<SecretStorage> weak_factory_{this};
};

}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_SECRET_STORAGE_LINUX_H_
