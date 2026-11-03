// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/easel_sharing.h"

#include <memory>
#include <string>

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/strings/string_util.h"
#include "base/test/task_environment.h"
#include "base/test/test_future.h"
#include "build/build_config.h"
#include "net/base/net_errors.h"
#include "services/network/public/cpp/weak_wrapper_shared_url_loader_factory.h"
#include "services/network/test/test_url_loader_factory.h"
#include "services/network/test/test_utils.h"
#include "testing/gtest/include/gtest/gtest.h"

#if BUILDFLAG(IS_POSIX)
#include <sys/stat.h>
#endif

namespace bay {
namespace {
class EaselSharingTest : public testing::Test {
 protected:
  void SetUp() override { ASSERT_TRUE(folder_.CreateUniqueTempDir()); }
  std::unique_ptr<EaselSharing> Ready(bool enabled = true) {
    auto service = std::make_unique<EaselSharing>(folder_.GetPath(), enabled);
    base::test::TestFuture<void> ready;
    service->Prepare(ready.GetCallback());
    EXPECT_TRUE(ready.Wait());
    EXPECT_TRUE(service->ready());
    return service;
  }
  base::FilePath File() const {
    return folder_.GetPath().AppendASCII("easel-shares.json");
  }
  base::DictValue Invoke(EaselSharing& service, const std::string& method,
                         base::ListValue args = {}) {
    base::test::TestFuture<const std::string&> result;
    EaselSharing::Response callback = result.GetCallback();
    EXPECT_TRUE(service.Dispatch("BayEasel", method, args, callback));
    auto parsed = base::JSONReader::ReadDict(result.Get(), base::JSON_PARSE_RFC);
    return parsed ? std::move(*parsed) : base::DictValue();
  }
  base::test::TaskEnvironment task_environment_;
  base::ScopedTempDir folder_;
};

TEST_F(EaselSharingTest, MissingRegistryIsNullAndSharingRemainsOptIn) {
  auto service = Ready(false);
  EXPECT_EQ(service->snapshots().FindBool("isEaselWebSharingEnabled"), false);
  ASSERT_TRUE(service->snapshots().Find("readEaselShareRecords"));
  EXPECT_TRUE(service->snapshots().Find("readEaselShareRecords")->is_none());
  EXPECT_TRUE(Invoke(*service, "readEaselShareRecords").Find("value")->is_none());
}
TEST_F(EaselSharingTest, ReadsTheSameRegistrySaveDocumentWrites) {
  const std::string records = R"({"version":1,"records":{"board":{"id":"abc"}}})";
  ASSERT_TRUE(base::WriteFile(File(), records));
  auto service = Ready();
  EXPECT_EQ(*service->snapshots().FindString("readEaselShareRecords"), records);
  ASSERT_TRUE(base::WriteFile(File(), "updated"));
  EXPECT_EQ(*Invoke(*service, "readEaselShareRecords").FindString("value"),
            "updated");
}
TEST_F(EaselSharingTest, ReadFailureCannotBecomeAnEmptyRegistry) {
  ASSERT_TRUE(base::WriteFile(File(), std::string("invalid\xff")));
  auto service = Ready();
  EXPECT_FALSE(service->snapshots().Find("readEaselShareRecords"));
  auto read = Invoke(*service, "readEaselShareRecords");
  EXPECT_EQ(*read.FindStringByDottedPath("error.code"), "read_failed");
  EXPECT_FALSE(read.Find("value"));
}
TEST_F(EaselSharingTest, RefusesDirectoriesAndOversizedRecords) {
  ASSERT_TRUE(base::CreateDirectory(File()));
  EXPECT_FALSE(Ready()->snapshots().Find("readEaselShareRecords"));
  ASSERT_TRUE(base::DeletePathRecursively(File()));
  ASSERT_TRUE(base::WriteFile(File(), std::string(16 * 1024 * 1024 + 1, 'x')));
  EXPECT_FALSE(Ready()->snapshots().Find("readEaselShareRecords"));
}
#if BUILDFLAG(IS_POSIX)
TEST_F(EaselSharingTest, DoesNotFollowLinksOrWaitOnFifos) {
  const auto target = folder_.GetPath().AppendASCII("other.json");
  ASSERT_TRUE(base::WriteFile(target, "private"));
  ASSERT_TRUE(base::CreateSymbolicLink(target, File()));
  EXPECT_FALSE(Ready()->snapshots().Find("readEaselShareRecords"));
  ASSERT_TRUE(base::DeleteFile(File()));
  ASSERT_EQ(mkfifo(File().value().c_str(), 0600), 0);
  EXPECT_FALSE(Ready()->snapshots().Find("readEaselShareRecords"));
}
#endif
TEST_F(EaselSharingTest, GeneratesIndependentRandomPublicAndManagementTokens) {
  auto service = Ready();
  const auto first = Invoke(*service, "createEaselShareIdentity");
  const auto second = Invoke(*service, "createEaselShareIdentity");
  const auto* id = first.FindStringByDottedPath("value.id");
  const auto* key = first.FindStringByDottedPath("value.key");
  ASSERT_TRUE(id);
  ASSERT_TRUE(key);
  EXPECT_EQ(id->size(), 32u);
  EXPECT_EQ(key->size(), 64u);
  EXPECT_EQ(id->find_first_not_of("0123456789abcdef"), std::string::npos);
  EXPECT_EQ(key->find_first_not_of("0123456789abcdef"), std::string::npos);
  EXPECT_NE(*id, *second.FindStringByDottedPath("value.id"));
  EXPECT_NE(*key, *second.FindStringByDottedPath("value.key"));
}
TEST_F(EaselSharingTest, RejectsArgumentsAndLeavesOtherMethodsUntouched) {
  auto service = Ready();
  EXPECT_EQ(*Invoke(*service, "createEaselShareIdentity",
                     base::ListValue().Append("ignored"))
                 .FindStringByDottedPath("error.code"),
            "invalid_args");
  EaselSharing::Response callback = base::BindOnce([](const std::string&) {});
  EXPECT_FALSE(service->Dispatch("BayShell", "createEaselShareIdentity", {},
                                 callback));
  EXPECT_FALSE(service->Dispatch("BayEasel", "storeImage", {}, callback));
  EXPECT_TRUE(callback);
}
TEST_F(EaselSharingTest, ClosingAHostDuringPreparationDropsItsCallback) {
  bool called = false;
  auto service = std::make_unique<EaselSharing>(folder_.GetPath(), true);
  service->Prepare(base::BindOnce([](bool* called) { *called = true; }, &called));
  service.reset();
  task_environment_.RunUntilIdle();
  EXPECT_FALSE(called);
}
TEST_F(EaselSharingTest, NativeRequestsUseOnlyTheFixedEndpointWithoutCookiesOrRedirects) {
  network::TestURLLoaderFactory factory;
  EaselSharing service(folder_.GetPath(), true, factory.GetSafeWeakWrapper());
  const std::string id(32, 'a');
  const std::string key(64, 'b');
  base::test::TestFuture<const std::string&> result;
  EaselSharing::Response callback = result.GetCallback();
  ASSERT_TRUE(service.Dispatch("BayEasel", "requestShare",
      base::ListValue().Append(id).Append(key).Append("PUT").Append("{\"version\":1}"), callback));
  task_environment_.RunUntilIdle();
  auto* pending = factory.GetPendingRequest(0);
  ASSERT_TRUE(pending);
  EXPECT_EQ(pending->request.url.spec(),
            "https://bay.krishkalaria.in/api/easels/" + id);
  EXPECT_EQ(pending->request.method, "PUT");
  EXPECT_EQ(pending->request.credentials_mode, network::mojom::CredentialsMode::kOmit);
  EXPECT_EQ(pending->request.redirect_mode, network::mojom::RedirectMode::kError);
  EXPECT_FALSE(pending->request.headers.HasHeader("Origin"));
  EXPECT_EQ(pending->request.headers.GetHeader("Authorization"), "Bearer " + key);
  EXPECT_EQ(network::GetUploadData(pending->request), "{\"version\":1}");
  ASSERT_TRUE(factory.SimulateResponseForPendingRequest(
      pending->request.url.spec(), "", net::HTTP_SERVICE_UNAVAILABLE));
  auto parsed = base::JSONReader::ReadDict(result.Get(), base::JSON_PARSE_RFC);
  ASSERT_TRUE(parsed);
  EXPECT_EQ(parsed->FindIntByDottedPath("value.status"), 503);
}
TEST_F(EaselSharingTest, RevocationAcceptsANoContentResponse) {
  network::TestURLLoaderFactory factory;
  const std::string id(32, 'a');
  factory.AddResponse("https://bay.krishkalaria.in/api/easels/" + id, "",
                      net::HTTP_NO_CONTENT);
  EaselSharing service(folder_.GetPath(), true, factory.GetSafeWeakWrapper());
  const auto response = Invoke(service, "requestShare",
      base::ListValue().Append(id).Append(std::string(64, 'b'))
          .Append("DELETE").Append(""));
  EXPECT_EQ(response.FindIntByDottedPath("value.status"), 204);
}
TEST_F(EaselSharingTest, DisabledAndInvalidRequestsNeverReachTheNetwork) {
  network::TestURLLoaderFactory factory;
  EaselSharing disabled(folder_.GetPath(), false, factory.GetSafeWeakWrapper());
  const auto arguments = [] {
    return base::ListValue().Append(std::string(32, 'a'))
        .Append(std::string(64, 'b')).Append("DELETE").Append("");
  };
  EXPECT_EQ(*Invoke(disabled, "requestShare", arguments())
                 .FindStringByDottedPath("error.code"), "sharing_disabled");
  EaselSharing enabled(folder_.GetPath(), true, factory.GetSafeWeakWrapper());
  auto invalid = arguments();
  invalid[0] = base::Value("../other");
  EXPECT_EQ(*Invoke(enabled, "requestShare", std::move(invalid))
                 .FindStringByDottedPath("error.code"), "invalid_args");
  invalid = arguments();
  invalid[3] = base::Value("DELETE cannot upload");
  EXPECT_EQ(*Invoke(enabled, "requestShare", std::move(invalid))
                 .FindStringByDottedPath("error.code"), "invalid_args");
  EXPECT_EQ(factory.NumPending(), 0);
}
TEST_F(EaselSharingTest, ClosingAHostCancelsItsPublicationRequest) {
  network::TestURLLoaderFactory factory;
  auto service = std::make_unique<EaselSharing>(folder_.GetPath(), true,
                                               factory.GetSafeWeakWrapper());
  bool answered = false;
  EaselSharing::Response callback = base::BindOnce(
      [](bool* answered, const std::string&) { *answered = true; }, &answered);
  ASSERT_TRUE(service->Dispatch("BayEasel", "requestShare",
      base::ListValue().Append(std::string(32, 'a')).Append(std::string(64, 'b'))
          .Append("DELETE").Append(""), callback));
  task_environment_.RunUntilIdle();
  ASSERT_EQ(factory.NumPending(), 1);
  service.reset();
  task_environment_.RunUntilIdle();
  EXPECT_FALSE(answered);
  EXPECT_EQ(factory.NumPending(), 0);
}
}  // namespace
}  // namespace bay
