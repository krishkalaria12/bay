// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/document_store.h"

#include <memory>
#include <string>

#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/functional/callback_helpers.h"
#include "base/json/json_reader.h"
#include "base/test/task_environment.h"
#include "base/test/test_future.h"
#include "build/build_config.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
namespace {

TEST(DocumentNameTest, AcceptsNamesEveryDesktopCanStore) {
  for (const char* name : {"session.json", "release notes.json", "a", "CONSOLE",
                           "com10.txt", "lpt0", "caf\xc3\xa9.json"})
    EXPECT_TRUE(IsValidDocumentName(name)) << name;
}

TEST(DocumentNameTest, RejectsPathsAndWindowsReservedNames) {
  for (const char* name :
       {"",    ".",        "..",  "a/b",     "a\\b", "c:",        "a<b",
        "a>b", "a\"b",     "a|b", "a?",      "a*",   "trailing.", "trailing ",
        "con", "PRN.json", "aux", "Nul.txt", "COM1", "lpt9.log",  "bad\xff"})
    EXPECT_FALSE(IsValidDocumentName(name)) << name;
  EXPECT_FALSE(IsValidDocumentName(std::string("a\x01", 2)));
  EXPECT_FALSE(IsValidDocumentName(std::string("a\0b", 3)));
}

class DocumentStoreTest : public testing::Test {
 protected:
  void SetUp() override { ASSERT_TRUE(folder_.CreateUniqueTempDir()); }

  base::FilePath Folder() const { return folder_.GetPath(); }
  std::unique_ptr<DocumentStore> Ready(
      base::RepeatingClosure changed = base::DoNothing()) {
    auto store = std::make_unique<DocumentStore>(Folder(), std::move(changed));
    base::test::TestFuture<void> ready;
    store->Prepare(ready.GetCallback());
    EXPECT_TRUE(ready.Wait());
    return store;
  }
  static base::DictValue Invoke(DocumentStore& store,
                                const std::string& method,
                                base::ListValue args) {
    base::test::TestFuture<const std::string&> result;
    DocumentStore::Response callback = result.GetCallback();
    EXPECT_TRUE(store.Dispatch("BayShell", method, args, callback));
    auto parsed =
        base::JSONReader::ReadDict(result.Get(), base::JSON_PARSE_RFC);
    return parsed ? std::move(*parsed) : base::DictValue();
  }
  static std::string ErrorCode(const base::DictValue& response) {
    const auto* code = response.FindStringByDottedPath("error.code");
    return code ? *code : "";
  }

  base::test::TaskEnvironment task_environment_;
  base::ScopedTempDir folder_;
};

TEST_F(DocumentStoreTest, LoadsTheFolderBeforeAnswering) {
  ASSERT_TRUE(base::WriteFile(Folder().AppendASCII("session.json"), "{}"));
  ASSERT_TRUE(base::CreateDirectory(Folder().AppendASCII("folder.json")));
  auto store = Ready();
  EXPECT_TRUE(store->error().empty());
  const auto documents = store->documents();
  EXPECT_EQ(documents.size(), 1u);
  ASSERT_TRUE(documents.FindString("session.json"));
  EXPECT_EQ(*documents.FindString("session.json"), "{}");
  auto read =
      Invoke(*store, "readDocument", base::ListValue().Append("session.json"));
  ASSERT_TRUE(read.FindString("value"));
  EXPECT_EQ(*read.FindString("value"), "{}");
  read = Invoke(*store, "readDocument", base::ListValue().Append("none.json"));
  ASSERT_TRUE(read.Find("value"));
  EXPECT_TRUE(read.Find("value")->is_none());
}

TEST_F(DocumentStoreTest, WritesReachEveryStoreOnTheFolder) {
  int changes = 0;
  auto writer = Ready();
  auto reader =
      Ready(base::BindRepeating([](int* count) { ++*count; }, &changes));
  base::ScopedTempDir elsewhere;
  ASSERT_TRUE(elsewhere.CreateUniqueTempDir());
  auto other =
      std::make_unique<DocumentStore>(elsewhere.GetPath(), base::DoNothing());
  base::test::TestFuture<void> other_ready;
  other->Prepare(other_ready.GetCallback());
  ASSERT_TRUE(other_ready.Wait());

  EXPECT_EQ(ErrorCode(Invoke(*writer, "saveDocument",
                             base::ListValue().Append("a.json").Append("1"))),
            "");
  EXPECT_EQ(ErrorCode(Invoke(*writer, "writeDocument",
                             base::ListValue().Append("b.json").Append("2"))),
            "");
  std::string contents;
  ASSERT_TRUE(
      base::ReadFileToString(Folder().AppendASCII("a.json"), &contents));
  EXPECT_EQ(contents, "1");
  EXPECT_EQ(changes, 2);
  ASSERT_TRUE(reader->documents().FindString("b.json"));
  EXPECT_EQ(*reader->documents().FindString("b.json"), "2");
  EXPECT_TRUE(other->documents().empty());

  EXPECT_EQ(ErrorCode(Invoke(*reader, "removeDocument",
                             base::ListValue().Append("a.json"))),
            "");
  EXPECT_FALSE(base::PathExists(Folder().AppendASCII("a.json")));
  EXPECT_FALSE(writer->documents().contains("a.json"));
  EXPECT_EQ(changes, 3);
}

TEST_F(DocumentStoreTest, ValidatesArgumentsAndLeavesOtherMethodsAlone) {
  auto store = Ready();
  EXPECT_EQ(ErrorCode(Invoke(*store, "readDocument", base::ListValue())),
            "invalid_args");
  EXPECT_EQ(ErrorCode(Invoke(*store, "readDocument",
                             base::ListValue().Append("../x"))),
            "invalid_args");
  EXPECT_EQ(ErrorCode(Invoke(*store, "saveDocument",
                             base::ListValue().Append("a.json"))),
            "invalid_args");
  EXPECT_EQ(ErrorCode(Invoke(*store, "writeDocument",
                             base::ListValue().Append("a.json").Append(1))),
            "invalid_args");
  bool called = false;
  DocumentStore::Response callback = base::BindOnce(
      [](bool* called, const std::string&) { *called = true; }, &called);
  EXPECT_FALSE(store->Dispatch("BayShell", "copyText", {}, callback));
  EXPECT_FALSE(store->Dispatch("BaySystem", "readDocument", {}, callback));
  EXPECT_FALSE(called);
  std::move(callback).Run("");
}

TEST_F(DocumentStoreTest, RefusesEverythingBeforeItIsReady) {
  DocumentStore store(Folder(), base::DoNothing());
  EXPECT_EQ(ErrorCode(Invoke(store, "readDocument",
                             base::ListValue().Append("a.json"))),
            "initialization_failed");
}

TEST_F(DocumentStoreTest, AnUnreadableDocumentStopsTheStore) {
  ASSERT_TRUE(base::WriteFile(Folder().AppendASCII("good.json"), "{}"));
  ASSERT_TRUE(base::WriteFile(Folder().AppendASCII("bad.json"), "\xff\xfe"));
  auto store = Ready();
  EXPECT_NE(store->error().find("bad.json"), std::string::npos);
  EXPECT_TRUE(store->documents().empty());
  EXPECT_EQ(
      ErrorCode(Invoke(*store, "saveDocument",
                       base::ListValue().Append("good.json").Append("x"))),
      "initialization_failed");
  std::string contents;
  ASSERT_TRUE(
      base::ReadFileToString(Folder().AppendASCII("good.json"), &contents));
  EXPECT_EQ(contents, "{}");
}

TEST_F(DocumentStoreTest, AFolderInTheWayFailsTheWrite) {
  auto store = Ready();
  ASSERT_TRUE(base::CreateDirectory(Folder().AppendASCII("taken.json")));
  EXPECT_EQ(
      ErrorCode(Invoke(*store, "saveDocument",
                       base::ListValue().Append("taken.json").Append("1"))),
      "document_write_failed");
  EXPECT_FALSE(store->documents().contains("taken.json"));
}

#if BUILDFLAG(IS_POSIX)
TEST_F(DocumentStoreTest, SymlinkedDocumentsAreNotFollowed) {
  base::ScopedTempDir outside;
  ASSERT_TRUE(outside.CreateUniqueTempDir());
  const auto target = outside.GetPath().AppendASCII("secret.txt");
  ASSERT_TRUE(base::WriteFile(target, "secret"));
  ASSERT_TRUE(base::CreateSymbolicLink(target, Folder().AppendASCII("a.json")));
  auto store = Ready();
  EXPECT_FALSE(store->error().empty());
  EXPECT_TRUE(store->documents().empty());
}

TEST_F(DocumentStoreTest, ASymlinkedFolderIsNotOpened) {
  base::ScopedTempDir parent;
  ASSERT_TRUE(parent.CreateUniqueTempDir());
  const auto link = parent.GetPath().AppendASCII("BayDocuments");
  ASSERT_TRUE(base::CreateSymbolicLink(Folder(), link));
  DocumentStore store(link, base::DoNothing());
  base::test::TestFuture<void> ready;
  store.Prepare(ready.GetCallback());
  ASSERT_TRUE(ready.Wait());
  EXPECT_EQ(store.error(), "Bay's document directory could not be opened");
}

TEST_F(DocumentStoreTest, WritingThroughASymlinkFails) {
  auto store = Ready();
  base::ScopedTempDir outside;
  ASSERT_TRUE(outside.CreateUniqueTempDir());
  const auto target = outside.GetPath().AppendASCII("target.txt");
  ASSERT_TRUE(base::WriteFile(target, "kept"));
  ASSERT_TRUE(base::CreateSymbolicLink(target, Folder().AppendASCII("a.json")));
  EXPECT_EQ(ErrorCode(Invoke(*store, "saveDocument",
                             base::ListValue().Append("a.json").Append("new"))),
            "document_write_failed");
  std::string contents;
  ASSERT_TRUE(base::ReadFileToString(target, &contents));
  EXPECT_EQ(contents, "kept");
}
#endif

}  // namespace
}  // namespace bay
