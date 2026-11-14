// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/secret_storage_linux.h"

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/test/task_environment.h"
#include "base/test/test_future.h"
#include "components/os_crypt/async/browser/key_provider.h"
#include "components/os_crypt/async/browser/os_crypt_async.h"
#include "components/os_crypt/async/browser/posix_key_provider.h"
#include "components/os_crypt/async/common/algorithm.mojom.h"
#include "components/os_crypt/async/common/encryptor.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
namespace {

using os_crypt_async::Encryptor;
using os_crypt_async::KeyProvider;
using os_crypt_async::OSCryptAsync;

// Stands in for the Secret Service (v11) and Secret portal (v12) providers.
class TaggedKeyProvider final : public KeyProvider {
 public:
  TaggedKeyProvider(std::string tag, bool encrypt)
      : tag_(std::move(tag)), encrypt_(encrypt) {}

 private:
  void GetKey(KeyCallback callback) override {
    const std::vector<uint8_t> key(Encryptor::Key::kAES256GCMKeySize, 7);
    std::move(callback).Run(
        tag_,
        Encryptor::Key(key, os_crypt_async::mojom::Algorithm::kAES256GCM));
  }
  bool UseForEncryption() override { return encrypt_; }

  const std::string tag_;
  const bool encrypt_;
};

class SecretStorageKindTest : public testing::Test {
 protected:
  using Providers =
      std::vector<std::pair<size_t, std::unique_ptr<KeyProvider>>>;

  // Matches Chrome's Linux precedence: portal 15, keyring 10, basic 5.
  std::string_view Kind(Providers providers) {
    OSCryptAsync os_crypt(std::move(providers));
    base::test::TestFuture<scoped_refptr<Encryptor>> encryptor;
    os_crypt.GetInstance(encryptor.GetCallback());
    return SecretStorageKind(*encryptor.Get());
  }
  static Providers With(std::unique_ptr<KeyProvider> keyring) {
    Providers providers;
    if (keyring)
      providers.emplace_back(10u, std::move(keyring));
    providers.emplace_back(
        5u, std::make_unique<os_crypt_async::PosixKeyProvider>());
    return providers;
  }

  base::test::TaskEnvironment task_environment_;
};

TEST_F(SecretStorageKindTest, KeyringKeyIsReportedAsKeyring) {
  EXPECT_EQ(Kind(With(std::make_unique<TaggedKeyProvider>("v11", true))),
            "keyring");
}

TEST_F(SecretStorageKindTest, SecretPortalKeyIsReportedAsKeyring) {
  EXPECT_EQ(Kind(With(std::make_unique<TaggedKeyProvider>("v12", true))),
            "keyring");
}

TEST_F(SecretStorageKindTest, OnlyTheFixedKeyIsReportedAsBasic) {
  EXPECT_EQ(Kind(With(nullptr)), "basic");
}

// A decrypt-only keyring key still leaves new data under the fixed key.
TEST_F(SecretStorageKindTest, DecryptOnlyKeyringStillEncryptsWithBasic) {
  EXPECT_EQ(Kind(With(std::make_unique<TaggedKeyProvider>("v11", false))),
            "basic");
}

TEST_F(SecretStorageKindTest, NoProvidersMeansUnavailable) {
  EXPECT_EQ(Kind({}), "unavailable");
}

}  // namespace
}  // namespace bay
