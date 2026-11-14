// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/sync_ui_linux.h"

#include <memory>
#include <vector>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/memory/ref_counted.h"
#include "base/test/task_environment.h"
#include "base/test/test_future.h"
#include "chrome/browser/bay/data/packages/sync/windows/SyncService.h"
#include "chrome/browser/bay/webui/host_context.h"
#include "chrome/browser/ui/browser_window/test/mock_browser_window_interface.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "testing/gmock/include/gmock/gmock.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/base/test/mock_base_window.h"
#include "ui/shell_dialogs/select_file_dialog.h"
#include "ui/shell_dialogs/select_file_dialog_factory.h"
#include "ui/shell_dialogs/select_file_policy.h"
#include "ui/shell_dialogs/selected_file_info.h"

namespace bay {
namespace {
class PickerWindow : public MockBrowserWindowInterface {
 public:
  bool IsNormalBrowser() const override { return true; }
};
class FakeDialog : public ui::SelectFileDialog {
 public:
  FakeDialog(Listener* listener, std::unique_ptr<ui::SelectFilePolicy> policy)
      : SelectFileDialog(listener, std::move(policy)) {}
  bool IsRunning(gfx::NativeWindow) const override { return !!listener_; }
  void ListenerDestroyed() override {
    ++detached;
    listener_ = nullptr;
  }
  void Select(const base::FilePath& path) {
    if (listener_)
      listener_->FileSelected(ui::SelectedFileInfo(path), 1);
  }
  void Cancel() {
    if (listener_)
      listener_->FileSelectionCanceled();
  }
  Type type = SELECT_NONE;
  base::FilePath initial;
  base::FilePath::StringType extension;
  std::vector<std::vector<base::FilePath::StringType>> extensions;
  int detached = 0;

 protected:
  ~FakeDialog() override = default;
  void SelectFileImpl(Type selected_type,
                      const std::u16string&,
                      const base::FilePath& default_path,
                      const FileTypeInfo* file_types,
                      int,
                      const base::FilePath::StringType& default_extension,
                      gfx::NativeWindow,
                      const GURL*) override {
    type = selected_type;
    initial = default_path;
    extension = default_extension;
    if (file_types)
      extensions = file_types->extensions;
  }
  bool HasMultipleFileTypeChoicesImpl() override { return false; }
};
class FakeFactory : public ui::SelectFileDialogFactory {
 public:
  ui::SelectFileDialog* Create(
      ui::SelectFileDialog::Listener* listener,
      std::unique_ptr<ui::SelectFilePolicy> policy) override {
    auto dialog = base::MakeRefCounted<FakeDialog>(listener, std::move(policy));
    dialogs.push_back(dialog);
    return dialog.get();
  }
  std::vector<scoped_refptr<FakeDialog>> dialogs;
};
class SyncUITest : public ChromeRenderViewHostTestHarness {
 public:
  SyncUITest()
      : ChromeRenderViewHostTestHarness(
            base::test::TaskEnvironment::ThreadPoolExecutionMode::QUEUED) {}

 protected:
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    ON_CALL(window_, GetProfile()).WillByDefault(testing::Return(profile()));
    ON_CALL(window_, GetWeakPtr())
        .WillByDefault(testing::Return(window_weak_.GetWeakPtr()));
    ON_CALL(window_, GetWindow()).WillByDefault(testing::Return(&base_window_));
    ON_CALL(base_window_, GetNativeWindow())
        .WillByDefault(testing::Return(root_window()));
    auto factory = std::make_unique<FakeFactory>();
    factory_ = factory.get();
    ui::SelectFileDialog::SetFactory(std::move(factory));
    ui_ = std::make_unique<SyncUI>();
  }
  void TearDown() override {
    ui_.reset();
    task_environment()->RunUntilIdle();
    ui::SelectFileDialog::SetFactory(nullptr);
    ChromeRenderViewHostTestHarness::TearDown();
  }
  void Dispatch(const std::string& method,
                base::ListValue args,
                SyncUI::Response response) {
    EXPECT_TRUE(ui_->Dispatch(HostContext::ForWindow(window_), "BaySync",
                              method, args, response));
  }
  void ExpectError(const std::string& response, const char* code) {
    auto value = base::JSONReader::ReadDict(response, base::JSON_PARSE_RFC);
    ASSERT_TRUE(value);
    auto* error = value->FindDict("error");
    ASSERT_TRUE(error);
    ASSERT_TRUE(error->FindString("code"));
    EXPECT_EQ(*error->FindString("code"), code);
  }
  testing::NiceMock<PickerWindow> window_;
  testing::NiceMock<ui::MockBaseWindow> base_window_;
  base::WeakPtrFactory<BrowserWindowInterface> window_weak_{&window_};
  FakeFactory* factory_ = nullptr;
  std::unique_ptr<SyncUI> ui_;
};

TEST_F(SyncUITest, FolderPickerReturnsTheNativePath) {
  base::test::TestFuture<const std::string&> result;
  Dispatch("chooseFolder", base::ListValue().Append("/tmp/current"),
           result.GetCallback());
  ASSERT_EQ(factory_->dialogs.size(), 1u);
  auto dialog = factory_->dialogs.back();
  EXPECT_EQ(dialog->type, ui::SelectFileDialog::SELECT_FOLDER);
  EXPECT_EQ(dialog->initial, base::FilePath("/tmp/current"));
  dialog->Select(base::FilePath("/tmp/sync café"));
  auto parsed = base::JSONReader::ReadDict(result.Get(), base::JSON_PARSE_RFC);
  ASSERT_TRUE(parsed);
  ASSERT_TRUE(parsed->FindString("value"));
  EXPECT_EQ(*parsed->FindString("value"), "/tmp/sync café");
  EXPECT_EQ(dialog->detached, 0);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(dialog->detached, 1);
}

TEST_F(SyncUITest, LockedSaveDoesNotOpenAPicker) {
  sync::SetDataDirectory("/tmp/bay-sync-ui-locked-test");
  sync::SetDataDirectory("");
  ASSERT_EQ(sync::RecoveryKeyGeneration(), 0u);
  base::test::TestFuture<const std::string&> result;
  Dispatch("saveRecoveryKit", base::ListValue().Append("pdf"),
           result.GetCallback());
  ExpectError(result.Get(), "locked");
  EXPECT_TRUE(factory_->dialogs.empty());
}

TEST_F(SyncUITest, TeardownSettlesOnceAndIgnoresLateNativeResults) {
  std::vector<std::string> results;
  Dispatch("chooseFolder", {},
           base::BindOnce(
               [](std::vector<std::string>* output,
                  const std::string& response) { output->push_back(response); },
               &results));
  auto dialog = factory_->dialogs.back();
  ui_.reset();
  ASSERT_EQ(results.size(), 1u);
  EXPECT_EQ(results[0], "{\"value\":null}");
  dialog->Select(base::FilePath("/tmp/late"));
  dialog->Cancel();
  task_environment()->RunUntilIdle();
  EXPECT_EQ(results.size(), 1u);
  EXPECT_EQ(dialog->detached, 1);
}

TEST_F(SyncUITest, RejectsBusyCoordinatorAndInvalidFormat) {
  base::test::TestFuture<const std::string&> first;
  Dispatch("chooseFolder", {}, first.GetCallback());
  base::test::TestFuture<const std::string&> busy;
  Dispatch("chooseFolder", {}, busy.GetCallback());
  ExpectError(busy.Get(), "dialog_busy");
  base::test::TestFuture<const std::string&> coordinator;
  auto response = coordinator.GetCallback();
  EXPECT_TRUE(ui_->Dispatch(HostContext::ForCoordinator(*profile()), "BaySync",
                            "chooseFolder", {}, response));
  ExpectError(coordinator.Get(), "window_required");
  base::test::TestFuture<const std::string&> invalid;
  Dispatch("saveRecoveryKit", base::ListValue().Append("invalid"),
           invalid.GetCallback());
  ExpectError(invalid.Get(), "invalid_arguments");
  EXPECT_EQ(factory_->dialogs.size(), 1u);
}
}  // namespace
}  // namespace bay
