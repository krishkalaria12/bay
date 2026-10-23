// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/native_host.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/observer_list.h"
#include "base/path_service.h"
#include "base/task/single_thread_task_runner.h"
#include "base/test/bind.h"
#include "base/test/scoped_path_override.h"
#include "base/test/task_environment.h"
#include "base/test/test_future.h"
#include "chrome/browser/bay/webui/app_runtime.h"
#include "chrome/browser/bay/webui/shell_ui.h"
#include "chrome/browser/bay/webui/tab_broker.h"
#include "chrome/browser/bay/webui/window_placement.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "chrome/browser/platform_util_internal.h"
#include "chrome/browser/ui/browser_window/test/mock_browser_window_interface.h"
#include "chrome/common/chrome_paths.h"
#include "chrome/test/base/chrome_render_view_host_test_harness.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "net/base/filename_util.h"
#include "testing/gmock/include/gmock/gmock.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "ui/base/clipboard/test/test_clipboard.h"
#include "ui/base/test/mock_base_window.h"
#include "ui/linux/fake_linux_ui.h"
#include "ui/linux/window_button_order_observer.h"
#include "ui/shell_dialogs/select_file_dialog.h"
#include "ui/shell_dialogs/select_file_dialog_factory.h"
#include "ui/shell_dialogs/select_file_policy.h"
#include "ui/shell_dialogs/selected_file_info.h"
#include "ui/views/window/window_button_order_provider.h"
#include "url/gurl.h"

namespace bay {
namespace {

class NativeHostTest : public ChromeRenderViewHostTestHarness {
 public:
  NativeHostTest()
      : ChromeRenderViewHostTestHarness(
            base::test::TaskEnvironment::ThreadPoolExecutionMode::QUEUED) {}

 protected:
  void SetUp() override {
    ChromeRenderViewHostTestHarness::SetUp();
    platform_util::internal::DisableShellOperationsForTesting();
    // Documents live under a temporary user data folder.
    user_data_ =
        std::make_unique<base::ScopedPathOverride>(chrome::DIR_USER_DATA);
    downloads_ = std::make_unique<base::ScopedPathOverride>(
        chrome::DIR_DEFAULT_DOWNLOADS,
        base::PathService::CheckedGet(chrome::DIR_USER_DATA)
            .Append("downloads café"),
        true, false);
    auto* host =
        new NativeHost(*main_rfh(), HostContext::ForCoordinator(*profile()),
                       remote_.BindNewPipeAndPassReceiver());
    host_ = host->GetWeakPtr();
  }
  void TearDown() override {
    if (host_)
      host_->ResetAndDeleteThis();
    remote_.reset();
    task_environment()->RunUntilIdle();
    ChromeRenderViewHostTestHarness::TearDown();
  }
  std::string Invoke(const std::string& module,
                     const std::string& method,
                     const std::string& args) {
    base::test::TestFuture<const std::string&> result;
    host_->Invoke(module, method, args, result.GetCallback());
    return result.Get();
  }
  void ExpectError(const std::string& response, const char* code) {
    auto parsed = base::JSONReader::ReadDict(response, base::JSON_PARSE_RFC);
    ASSERT_TRUE(parsed);
    const auto* error = parsed->FindStringByDottedPath("error.code");
    ASSERT_TRUE(error);
    EXPECT_EQ(*error, code);
  }

  // A fresh coordinator, once its saved documents are read.
  void ReplaceHost() {
    host_->ResetAndDeleteThis();
    remote_.reset();
    auto* host =
        new NativeHost(*main_rfh(), HostContext::ForCoordinator(*profile()),
                       remote_.BindNewPipeAndPassReceiver());
    host_ = host->GetWeakPtr();
    task_environment()->RunUntilIdle();
  }
  base::DictValue HostInfo() {
    // Host info waits for the document read, which QUEUED holds until here.
    task_environment()->RunUntilIdle();
    base::test::TestFuture<const std::string&> result;
    host_->GetHostInfo(result.GetCallback());
    auto info = base::JSONReader::ReadDict(result.Get(), base::JSON_PARSE_RFC);
    return info ? std::move(*info) : base::DictValue();
  }
  base::FilePath Documents() const {
    return base::PathService::CheckedGet(chrome::DIR_USER_DATA)
        .AppendASCII("BayDocuments");
  }

  std::unique_ptr<base::ScopedPathOverride> user_data_;
  std::unique_ptr<base::ScopedPathOverride> downloads_;
  mojo::Remote<mojom::NativeHost> remote_;
  base::WeakPtr<NativeHost> host_;
};

void ExpectLayoutAndCaptionMethods(const base::DictValue& info) {
  const auto* methods = info.FindList("optionalMethods");
  ASSERT_TRUE(methods);
  for (const char* method :
       {"BayShell.windowButtonLayout", "BayShell.minimizeWindow",
        "BayShell.toggleMaximizeWindow", "BayShell.windowState"})
    EXPECT_TRUE(methods->contains(method)) << method;
  EXPECT_FALSE(methods->contains("BayShell.setWindowCaption"));
  const auto* layout =
      info.FindDictByDottedPath("snapshots.BayShell.windowButtonLayout");
  ASSERT_TRUE(layout);
  EXPECT_EQ(layout->size(), 2u);
  EXPECT_TRUE(layout->FindList("left"));
  EXPECT_TRUE(layout->FindList("right"));
}

TEST_F(NativeHostTest, PlacementCapabilityAndUnknownWindowKeepCoordinatorRole) {
  const auto info = HostInfo();
  EXPECT_EQ(
      info.FindBoolByDottedPath("constants.BayShell.globalWindowCoordinates"),
      GlobalWindowCoordinates());
  EXPECT_EQ(*info.FindString("role"), "coordinator");
  EXPECT_EQ(Invoke("BayShell", "windowFrame", R"(["missing"])"),
            R"({"value":null})");
  ExpectError(Invoke("BayShell", "windowState", R"(["missing"])"),
              "window_error");
  for (const char* options : {R"({"size":[0,600]})", R"({"maximized":1})",
                              R"({"frame":[0,0,800,600],"size":[800]})"}) {
    ExpectError(Invoke("BayShell", "openWindow",
                       "[\"placement-test\"," + std::string(options) + "]"),
                "window_error");
  }
}

// A link another app opened, or a startup URL, is told apart from a page a
// page opened and from pages the broker already holds.
TEST_F(NativeHostTest, LaunchPagesSkipPageOpenedAndBrokerPages) {
  auto launched = CreateTestWebContents();
  auto opened = CreateTestWebContents();
  AppRuntime::MarkOpenedByPage(opened.get());
  AppRuntime::MarkOpenedByPage(nullptr);
  EXPECT_FALSE(AppRuntime::IsOpenedByPage(launched.get()));
  EXPECT_TRUE(AppRuntime::IsOpenedByPage(opened.get()));
  EXPECT_FALSE(AppRuntime::IsOpenedByPage(nullptr));

  EXPECT_FALSE(TabBroker::Get().Tracks(launched.get()));
  const auto offer = TabBroker::Get().Offer(launched.get(), /*park=*/false);
  ASSERT_TRUE(offer.error.empty());
  EXPECT_TRUE(TabBroker::Get().Tracks(launched.get()));
  TabBroker::Get().ReleaseOffer(offer.adopt_id);
  EXPECT_FALSE(TabBroker::Get().Tracks(launched.get()));
  // Without a started runtime nothing is offered.
  WindowRegistry::Get().AdoptLaunchPages();
}

class HostLayoutLinuxUi : public ui::FakeLinuxUi {
 public:
  void AddWindowButtonOrderObserver(ui::WindowButtonOrderObserver* o) override {
    observers.AddObserver(o);
  }
  void RemoveWindowButtonOrderObserver(
      ui::WindowButtonOrderObserver* o) override {
    observers.RemoveObserver(o);
  }
  void Notify() {
    for (auto& observer : observers)
      observer.OnWindowButtonOrderingChange();
  }
  base::ObserverList<ui::WindowButtonOrderObserver>::Unchecked observers;
};
class LayoutHostTest : public NativeHostTest {
 protected:
  void SetUp() override {
    NativeHostTest::SetUp();
    auto* order = views::WindowButtonOrderProvider::GetInstance();
    left_ = order->leading_buttons();
    right_ = order->trailing_buttons();
    old_ui_ = ui::LinuxUi::SetInstance(&linux_ui_);
    ReplaceHost();
    SetLayout(false);
    task_environment()->RunUntilIdle();
  }
  void TearDown() override {
    NativeHostTest::TearDown();
    EXPECT_TRUE(linux_ui_.observers.empty());
    ui::LinuxUi::SetInstance(old_ui_);
    views::WindowButtonOrderProvider::GetInstance()->SetWindowButtonOrder(
        left_, right_);
  }
  void SetLayout(bool left) {
    using Button = views::FrameButton;
    views::WindowButtonOrderProvider::GetInstance()->SetWindowButtonOrder(
        left ? std::vector<Button>{Button::kClose} : std::vector<Button>{},
        left ? std::vector<Button>{Button::kMinimize, Button::kMaximize}
             : std::vector<Button>{Button::kMinimize, Button::kMaximize,
                                   Button::kClose});
    linux_ui_.Notify();
  }
  HostLayoutLinuxUi linux_ui_;
  raw_ptr<ui::LinuxUi> old_ui_ = nullptr;
  std::vector<views::FrameButton> left_, right_;
};
class LayoutClient : public mojom::NativeHostClient {
 public:
  void Connect(NativeHost& host) {
    receiver.reset();
    host.SetClient(receiver.BindNewPipeAndPassRemote());
  }
  void OnNativeEvent(const std::string& module,
                     const std::string& event,
                     const std::string& json) override {
    if (module != "BayShell" || event != "onAppEvent")
      return;
    auto payload = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
    ASSERT_TRUE(payload);
    const auto* type = payload->FindString("type");
    if (!type || *type != "windowButtonLayout")
      return;
    EXPECT_EQ(payload->size(), 2u);
    const auto* layout = payload->FindDict("layout");
    ASSERT_TRUE(layout);
    events.push_back(layout->Clone());
  }
  void OnHostInfoChanged(const std::string& json) override {
    auto info = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
    ASSERT_TRUE(info);
    const auto* layout =
        info->FindDictByDottedPath("snapshots.BayShell.windowButtonLayout");
    ASSERT_TRUE(layout);
    snapshots.push_back(layout->Clone());
  }
  mojo::Receiver<mojom::NativeHostClient> receiver{this};
  std::vector<base::DictValue> events, snapshots;
};

TEST_F(NativeHostTest, LayoutQueryDoesNotWaitForDocumentPreparation) {
  base::test::TestFuture<const std::string&> info;
  host_->GetHostInfo(info.GetCallback());
  EXPECT_FALSE(info.IsReady());
  const auto result = base::JSONReader::ReadDict(
      Invoke("BayShell", "windowButtonLayout", "[]"), base::JSON_PARSE_RFC);
  ASSERT_TRUE(result);
  const auto* layout = result->FindDict("value");
  ASSERT_TRUE(layout);
  EXPECT_TRUE(layout->FindList("left"));
  EXPECT_TRUE(layout->FindList("right"));
}

TEST_F(LayoutHostTest, CoordinatorAdvertisesAndQueriesCurrentLayout) {
  SetLayout(true);
  const auto info = HostInfo();
  ExpectLayoutAndCaptionMethods(info);
  const auto* snapshot =
      info.FindDictByDottedPath("snapshots.BayShell.windowButtonLayout");
  ASSERT_TRUE(snapshot);
  EXPECT_EQ(Invoke("BayShell", "windowButtonLayout", "[]"),
            base::WriteJson(base::DictValue().Set("value", snapshot->Clone())));
  EXPECT_EQ(*snapshot->FindList("left"), base::ListValue().Append("close"));
  EXPECT_EQ(*snapshot->FindList("right"),
            base::ListValue().Append("minimize").Append("maximize"));
  for (const char* args : {"{}", "[1]", "[null]", "[[],{}]"})
    ExpectError(Invoke("BayShell", "windowButtonLayout", args), "invalid_args");
}
TEST_F(LayoutHostTest, CaptionCommandsPreserveCommonArityAndUnknownIdErrors) {
  for (const char* method :
       {"minimizeWindow", "toggleMaximizeWindow", "windowState"}) {
    ExpectError(Invoke("BayShell", method, "[]"), "invalid_args");
    ExpectError(Invoke("BayShell", method, R"(["missing",1])"), "invalid_args");
    ExpectError(Invoke("BayShell", method, R"(["missing"])"), "window_error");
  }
}
TEST_F(LayoutHostTest, LiveChangesPublishSnapshotAndCurrentEvent) {
  LayoutClient client;
  client.Connect(*host_);
  task_environment()->RunUntilIdle();
  ASSERT_EQ(client.events.size(), 1u);
  const auto initial = client.events[0].Clone();
  SetLayout(true);
  SetLayout(false);
  SetLayout(true);
  EXPECT_EQ(client.events.size(), 1u);
  task_environment()->RunUntilIdle();
  ASSERT_EQ(client.events.size(), 2u);
  ASSERT_FALSE(client.snapshots.empty());
  EXPECT_EQ(client.snapshots.back(), client.events.back());
  EXPECT_NE(initial, client.events.back());
  EXPECT_EQ(client.events.back(), *HostInfo().FindDictByDottedPath(
                                      "snapshots.BayShell.windowButtonLayout"));
}
TEST_F(LayoutHostTest, ReplaceDisconnectReconnectAndTeardownCancelStaleEvents) {
  LayoutClient first;
  first.Connect(*host_);
  SetLayout(true);
  LayoutClient second;
  second.Connect(*host_);
  task_environment()->RunUntilIdle();
  EXPECT_TRUE(first.events.empty());
  ASSERT_EQ(second.events.size(), 1u);
  second.receiver.reset();
  task_environment()->RunUntilIdle();
  SetLayout(false);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(second.events.size(), 1u);
  second.Connect(*host_);
  task_environment()->RunUntilIdle();
  ASSERT_EQ(second.events.size(), 2u);
  EXPECT_EQ(second.events.back(), *HostInfo().FindDictByDottedPath(
                                      "snapshots.BayShell.windowButtonLayout"));
  SetLayout(true);
  host_->ResetAndDeleteThis();
  task_environment()->RunUntilIdle();
  EXPECT_EQ(second.events.size(), 2u);
  EXPECT_TRUE(linux_ui_.observers.empty());
}
TEST_F(LayoutHostTest, FreshDocumentGetsCurrentLayoutAfterDisconnectedUpdate) {
  SetLayout(true);
  ReplaceHost();
  LayoutClient client;
  client.Connect(*host_);
  task_environment()->RunUntilIdle();
  ASSERT_EQ(client.events.size(), 1u);
  EXPECT_EQ(client.events[0], *HostInfo().FindDictByDottedPath(
                                  "snapshots.BayShell.windowButtonLayout"));
}

class AppearanceClient : public mojom::NativeHostClient {
 public:
  void Connect(NativeHost& host) {
    receiver.reset();
    host.SetClient(receiver.BindNewPipeAndPassRemote());
  }
  void OnNativeEvent(const std::string& module,
                     const std::string& event,
                     const std::string& json) override {
    if (module != "BayShell" || event != "onAppEvent")
      return;
    auto payload = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
    ASSERT_TRUE(payload);
    const auto* type = payload->FindString("type");
    ASSERT_TRUE(type);
    if (*type != "appearance")
      return;
    EXPECT_EQ(payload->size(), 2u);
    const auto dark = payload->FindBool("dark");
    ASSERT_TRUE(dark);
    events.push_back(*dark);
  }
  void OnHostInfoChanged(const std::string&) override {}
  mojo::Receiver<mojom::NativeHostClient> receiver{this};
  std::vector<bool> events;
};

TEST_F(NativeHostTest, CoordinatorAdvertisesAndQueriesSelectedAppearance) {
  const auto info = HostInfo();
  const auto* methods = info.FindList("optionalMethods");
  ASSERT_TRUE(methods);
  EXPECT_TRUE(methods->contains("BayShell.setAppearance"));
  EXPECT_TRUE(methods->contains("BayShell.isDarkAppearance"));
  EXPECT_EQ(Invoke("BayShell", "setAppearance", R"(["dark"])"),
            R"({"value":null})");
  EXPECT_EQ(Invoke("BayShell", "isDarkAppearance", "[]"), R"({"value":true})");
  EXPECT_EQ(Invoke("BayShell", "setAppearance", R"(["light"])"),
            R"({"value":null})");
  EXPECT_EQ(Invoke("BayShell", "isDarkAppearance", "[]"), R"({"value":false})");
}

TEST_F(NativeHostTest, AppearanceValidatesArityAndModeBeforeMutation) {
  // Appearance does not wait for the unrelated Linux document read.
  EXPECT_EQ(Invoke("BayShell", "setAppearance", R"(["dark"])"),
            R"({"value":null})");
  for (const char* args : {"[]", "[null]", "[1]", "[true]", "[{}]", "[[]]",
                           R"(["Dark"])", R"(["auto",1])"})
    ExpectError(Invoke("BayShell", "setAppearance", args), "invalid_args");
  ExpectError(Invoke("BayShell", "isDarkAppearance", "[null]"), "invalid_args");
  EXPECT_EQ(Invoke("BayShell", "isDarkAppearance", "[]"), R"({"value":true})");
}

TEST_F(NativeHostTest, AppearanceConnectReplaceDisconnectAndReconnect) {
  Invoke("BayShell", "setAppearance", R"(["light"])");
  AppearanceClient first;
  first.Connect(*host_);
  Invoke("BayShell", "setAppearance", R"(["dark"])");
  AppearanceClient second;
  second.Connect(*host_);
  task_environment()->RunUntilIdle();
  EXPECT_TRUE(first.events.empty());
  EXPECT_EQ(second.events, (std::vector<bool>{true}));
  second.receiver.reset();
  task_environment()->RunUntilIdle();
  Invoke("BayShell", "setAppearance", R"(["light"])");
  task_environment()->RunUntilIdle();
  EXPECT_EQ(second.events.size(), 1u);
  second.Connect(*host_);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(second.events, (std::vector<bool>{true, false}));
  Invoke("BayShell", "setAppearance", R"(["dark"])");
  host_->ResetAndDeleteThis();
  task_environment()->RunUntilIdle();
  EXPECT_EQ(second.events.size(), 2u);
}

TEST_F(NativeHostTest, FreshDocumentReceivesCurrentAppearance) {
  Invoke("BayShell", "setAppearance", R"(["dark"])");
  ReplaceHost();
  AppearanceClient client;
  client.Connect(*host_);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(client.events, (std::vector<bool>{true}));
}

TEST_F(NativeHostTest, AdvertisesOnlyImplementedShellAndSystemMethods) {
  auto info = HostInfo();
  const auto* modules = info.FindList("modules");
  const auto* methods = info.FindList("optionalMethods");
  ASSERT_TRUE(modules);
  ASSERT_TRUE(methods);
  EXPECT_TRUE(modules->contains("BaySystem"));
  EXPECT_TRUE(methods->contains("BayShell.prompt"));
  EXPECT_FALSE(methods->contains("BayShell.pickFiles"));
  EXPECT_FALSE(methods->contains("BayShell.showMenu"));
  EXPECT_TRUE(methods->contains("BaySystem.fileIcon"));
  EXPECT_TRUE(methods->contains("BayCEF.secretStorage"));
  for (const auto& method : *methods) {
    const auto& name = method.GetString();
    if (name.starts_with("BaySystem."))
      EXPECT_TRUE(
          name == "BaySystem.fileIcon" || name == "BaySystem.fileExists" ||
          name == "BaySystem.downloadsFolder" || name == "BaySystem.openFile" ||
          name == "BaySystem.revealFile" || name == "BaySystem.moveToTrash" ||
          name == "BaySystem.isDefaultBrowser" ||
          name == "BaySystem.setAsDefaultBrowser" ||
          name == "BaySystem.launchAtLoginStatus" ||
          name == "BaySystem.setLaunchAtLogin");
  }
  EXPECT_TRUE(methods->contains("BayShell.confirm"));
  EXPECT_TRUE(methods->contains("BayShell.readDocument"));
  EXPECT_TRUE(methods->contains("BayShell.saveDocument"));
  EXPECT_TRUE(info.FindDictByDottedPath("snapshots.BaySystem.files"));
  const auto* downloads =
      info.FindByDottedPath("snapshots.BaySystem.downloadsFolder");
  ASSERT_TRUE(downloads);
  EXPECT_TRUE(downloads->is_string() || downloads->is_none());
  EXPECT_EQ(Invoke("BaySystem", "downloadsFolder", "[]"),
            base::WriteJson(base::DictValue().Set("value", downloads->Clone()))
                .value());
}

TEST_F(NativeHostTest,
       FileSnapshotWaitsForPreparationAndIsTheNativeUserDirectory) {
  base::test::TestFuture<const std::string&> first;
  base::test::TestFuture<const std::string&> second;
  host_->GetHostInfo(first.GetCallback());
  host_->GetHostInfo(second.GetCallback());
  EXPECT_FALSE(first.IsReady());
  EXPECT_FALSE(second.IsReady());
  ExpectError(Invoke("BaySystem", "fileExists", "[null]"),
              "initialization_failed");
  task_environment()->RunUntilIdle();
  EXPECT_EQ(first.Get(), second.Get());
  auto info = base::JSONReader::ReadDict(first.Get(), base::JSON_PARSE_RFC);
  ASSERT_TRUE(info);
  const auto* path =
      info->FindStringByDottedPath("snapshots.BaySystem.downloadsFolder");
  ASSERT_TRUE(path);
  EXPECT_EQ(
      *path,
      base::PathService::CheckedGet(chrome::DIR_DEFAULT_DOWNLOADS).value());
  EXPECT_FALSE(base::PathExists(base::FilePath(*path)));
}

TEST_F(NativeHostTest,
       FileContractsRejectArityBeforeReadinessAndTypesAfterReadiness) {
  for (const char* method :
       {"fileExists", "openFile", "revealFile", "moveToTrash"}) {
    for (const char* args : {"{}", "[]", R"(["/tmp/a",1])"})
      ExpectError(Invoke("BaySystem", method, args), "invalid_args");
  }
  HostInfo();
  for (const char* method :
       {"fileExists", "openFile", "revealFile", "moveToTrash"}) {
    for (const char* args :
         {"[null]", "[1]", R"(["relative"])", R"(["/tmp/a\u0000b"])"})
      ExpectError(Invoke("BaySystem", method, args), "invalid_args");
  }
  ExpectError(Invoke("BaySystem", "downloadsFolder", "[1]"), "invalid_args");
  ExpectError(Invoke("BaySystem", "isDefaultBrowser", "[1]"), "invalid_args");
}

void ExpectDesktopSystemMethods(const base::DictValue& info) {
  const auto* methods = info.FindList("optionalMethods");
  ASSERT_TRUE(methods);
  for (const char* method :
       {"BaySystem.isDefaultBrowser", "BaySystem.setAsDefaultBrowser",
        "BaySystem.launchAtLoginStatus", "BaySystem.setLaunchAtLogin",
        "BayApp.systemInfo", "BayApp.launchEnvironment",
        "BayApp.openExternalURL", "BayApp.updaterState"})
    EXPECT_TRUE(methods->contains(method)) << method;
  for (const char* method :
       {"BayApp.checkForUpdates", "BayApp.installPendingUpdate",
        "BayApp.setAutomaticUpdateChecks",
        "BayApp.setAutomaticUpdateDownloads"})
    EXPECT_FALSE(methods->contains(method)) << method;
}

TEST_F(NativeHostTest, CoordinatorAdvertisesDesktopSystemMethods) {
  ExpectDesktopSystemMethods(HostInfo());
}

TEST_F(NativeHostTest, AppSnapshotsAreReadyBeforeHostInfoReturns) {
  base::test::TestFuture<const std::string&> result;
  host_->GetHostInfo(result.GetCallback());
  EXPECT_FALSE(result.IsReady());
  ExpectError(Invoke("BayApp", "systemInfo", "[]"), "initialization_failed");
  task_environment()->RunUntilIdle();
  auto info = base::JSONReader::ReadDict(result.Get(), base::JSON_PARSE_RFC);
  ASSERT_TRUE(info);
  const auto* system =
      info->FindDictByDottedPath("snapshots.BayApp.systemInfo");
  ASSERT_TRUE(system);
  const auto* name = system->FindString("appName");
  ASSERT_TRUE(name);
  EXPECT_EQ(*name, "Bay");
  EXPECT_EQ(system->FindBool("updates"), false);
  EXPECT_TRUE(info->FindDictByDottedPath("snapshots.BayApp.environment"));
  EXPECT_TRUE(info->FindDictByDottedPath("snapshots.BayShell.documents"));
  EXPECT_EQ(
      Invoke("BayApp", "systemInfo", "[]"),
      base::WriteJson(base::DictValue().Set("value", system->Clone())).value());
  EXPECT_EQ(Invoke("BayApp", "launchEnvironment", R"(["NOT_A_BAY_SETTING"])"),
            R"({"value":null})");
  auto updater = base::JSONReader::ReadDict(
      Invoke("BayApp", "updaterState", "[]"), base::JSON_PARSE_RFC);
  ASSERT_TRUE(updater);
  EXPECT_EQ(updater->FindBoolByDottedPath("value.available"), false);
  const auto* manager = updater->FindStringByDottedPath("value.managedBy");
  ASSERT_TRUE(manager);
  EXPECT_EQ(*manager, "packageManager");
}

TEST_F(NativeHostTest,
       DesktopSystemContractsRejectArgumentsWithoutExternalEffects) {
  HostInfo();
  for (const char* method :
       {"isDefaultBrowser", "setAsDefaultBrowser", "launchAtLoginStatus"})
    ExpectError(Invoke("BaySystem", method, "[1]"), "invalid_args");
  for (const char* args : {"[]", "[null]", "[1]", R"(["true"])"})
    ExpectError(Invoke("BaySystem", "setLaunchAtLogin", args), "invalid_args");
  for (const char* method : {"systemInfo", "updaterState"})
    ExpectError(Invoke("BayApp", method, "[1]"), "invalid_args");
  ExpectError(Invoke("BayApp", "launchEnvironment", "[1]"), "invalid_args");
  for (const char* args : {"[]", "[null]", R"(["file:///tmp/a"])",
                           R"json(["javascript:alert(1)"])json", R"(["ftp://example.com"])",
                           R"(["not a URL"])"})
    ExpectError(Invoke("BayApp", "openExternalURL", args), "invalid_args");
}

TEST_F(NativeHostTest, ClosingHostBeforeAppSnapshotReplyDropsPendingHostInfo) {
  int calls = 0;
  host_->GetHostInfo(
      base::BindLambdaForTesting([&calls](const std::string&) { ++calls; }));
  host_->ResetAndDeleteThis();
  EXPECT_FALSE(host_);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(calls, 0);
}

TEST_F(NativeHostTest,
       CoordinatorFileOperationsStayIndependentOfDocumentReadErrors) {
  ASSERT_TRUE(base::CreateDirectory(Documents()));
  ASSERT_TRUE(base::WriteFile(Documents().AppendASCII("bad.json"), "\xff"));
  ReplaceHost();
  const auto file = Documents().Append("café ?*.txt");
  ASSERT_TRUE(base::WriteFile(file, "safe"));
  const auto args =
      base::WriteJson(base::ListValue().Append(file.value())).value();
  EXPECT_EQ(Invoke("BaySystem", "fileExists", args), R"({"value":true})");
  EXPECT_EQ(Invoke("BaySystem", "openFile", args), R"({"value":true})");
  EXPECT_EQ(Invoke("BaySystem", "revealFile", args), R"({"value":true})");
  EXPECT_EQ(
      Invoke("BaySystem", "openFile",
             base::WriteJson(base::ListValue().Append(Documents().value()))
                 .value()),
      R"({"value":true})");
  const auto missing =
      base::WriteJson(
          base::ListValue().Append(Documents().AppendASCII("missing").value()))
          .value();
  EXPECT_EQ(Invoke("BaySystem", "fileExists", missing), R"({"value":false})");
  EXPECT_EQ(Invoke("BaySystem", "openFile", missing), R"({"value":false})");
  EXPECT_EQ(Invoke("BaySystem", "revealFile", missing), R"({"value":false})");
  // GIO receives only a nonexistent entry under the temporary test directory.
  EXPECT_EQ(Invoke("BaySystem", "moveToTrash", missing), R"({"value":false})");
  EXPECT_TRUE(base::PathExists(file));
}

TEST_F(NativeHostTest, HostInfoReplyCanDeleteOwnerAfterAllPreparation) {
  int calls = 0;
  host_->GetHostInfo(
      base::BindLambdaForTesting([this, &calls](const std::string& json) {
        ++calls;
        EXPECT_TRUE(base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC));
        host_->ResetAndDeleteThis();
      }));
  task_environment()->RunUntilIdle();
  EXPECT_FALSE(host_);
  EXPECT_EQ(calls, 1);
}

TEST_F(NativeHostTest, FileWorkerReplyAfterHostTeardownIsSettledOnce) {
  HostInfo();
  int calls = 0;
  host_->Invoke(
      "BaySystem", "fileExists",
      base::WriteJson(base::ListValue().Append(Documents().value())).value(),
      base::BindLambdaForTesting([this, &calls](const std::string& response) {
        ++calls;
        ExpectError(response, "host_closed");
      }));
  EXPECT_EQ(calls, 0);
  host_->ResetAndDeleteThis();
  EXPECT_EQ(calls, 1);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(calls, 1);
}

TEST_F(NativeHostTest, SavedDocumentsArriveInHostInfoAndPersist) {
  ASSERT_TRUE(base::CreateDirectory(Documents()));
  ASSERT_TRUE(base::WriteFile(Documents().AppendASCII("session.json"), "{}"));
  ReplaceHost();
  auto info = HostInfo();
  const auto* session =
      info.FindStringByDottedPath("snapshots.BayShell.documents.session.json");
  ASSERT_TRUE(session);
  EXPECT_EQ(*session, "{}");
  EXPECT_FALSE(
      info.FindStringByDottedPath("constants.BayShell.initializationError"));

  auto saved = base::JSONReader::ReadDict(
      Invoke("BayShell", "saveDocument", R"(["notes.json","[1]"])"),
      base::JSON_PARSE_RFC);
  ASSERT_TRUE(saved);
  EXPECT_FALSE(saved->Find("error"));
  std::string contents;
  ASSERT_TRUE(
      base::ReadFileToString(Documents().AppendASCII("notes.json"), &contents));
  EXPECT_EQ(contents, "[1]");
  EXPECT_TRUE(HostInfo().FindStringByDottedPath(
      "snapshots.BayShell.documents.notes.json"));
}

TEST_F(NativeHostTest, AnUnreadableDocumentBecomesTheInitializationError) {
  ASSERT_TRUE(base::CreateDirectory(Documents()));
  ASSERT_TRUE(base::WriteFile(Documents().AppendASCII("bad.json"), "\xff"));
  ReplaceHost();
  const auto info = HostInfo();
  const auto* error =
      info.FindStringByDottedPath("constants.BayShell.initializationError");
  ASSERT_TRUE(error);
  EXPECT_NE(error->find("bad.json"), std::string::npos);
  ExpectError(Invoke("BayShell", "saveDocument", R"(["bad.json","{}"])"),
              "initialization_failed");
}

// The testing browser process encrypts with a test key, not the fixed v10
// one. The engine facade would otherwise answer every BayCEF method.
TEST_F(NativeHostTest, SecretStorageAnswersAheadOfTheEngineFacade) {
  base::test::TestFuture<const std::string&> first;
  base::test::TestFuture<const std::string&> second;
  host_->Invoke("BayCEF", "secretStorage", "[]", first.GetCallback());
  host_->Invoke("BayCEF", "secretStorage", "[]", second.GetCallback());
  for (auto* result : {&first, &second}) {
    auto parsed =
        base::JSONReader::ReadDict(result->Get(), base::JSON_PARSE_RFC);
    ASSERT_TRUE(parsed);
    const auto* value = parsed->FindString("value");
    ASSERT_TRUE(value);
    EXPECT_EQ(*value, "keyring");
  }
  ExpectError(Invoke("BayCEF", "secretStorage", "[1]"), "invalid_args");
}

TEST_F(NativeHostTest, SecretStorageSettlesWhenTheHostCloses) {
  base::test::TestFuture<const std::string&> result;
  host_->Invoke("BayCEF", "secretStorage", "[]", result.GetCallback());
  ASSERT_FALSE(result.IsReady());
  host_->ResetAndDeleteThis();
  ASSERT_TRUE(result.IsReady());
  ExpectError(result.Get(), "host_closed");
  // The encryptor's late answer finds no owner.
  task_environment()->RunUntilIdle();
}

TEST_F(NativeHostTest, CoordinatorPromptRequiresAnExplicitLiveWindow) {
  ExpectError(Invoke("BayShell", "prompt", R"([{"title":"Input"}])"),
              "window_required");
  ExpectError(Invoke("BayShell", "prompt",
                     R"([{"title":"Input","windowId":"missing"}])"),
              "window_required");
}

TEST_F(NativeHostTest, CoordinatorConfirmRequiresAnExplicitLiveWindow) {
  ExpectError(Invoke("BayShell", "confirm", R"([{"title":"Quit?"}])"),
              "window_required");
  ExpectError(Invoke("BayShell", "confirm",
                     R"([{"title":"Quit?","windowId":"missing"}])"),
              "window_required");
}

TEST_F(NativeHostTest, CoordinatorCannotShowAContextMenu) {
  ExpectError(
      Invoke("BayShell", "showMenu", R"([[{"id":"copy","title":"Copy"}]])"),
      "window_required");
}

TEST_F(NativeHostTest, CoordinatorCannotPickFiles) {
  ExpectError(Invoke("BayShell", "pickFiles", "[]"), "window_required");
  ExpectError(Invoke("BayShell", "pickFiles", R"([{"windowId":"other"}])"),
              "invalid_args");
}

TEST_F(NativeHostTest, ValidatesArgumentsBeforeStartingShellWork) {
  ExpectError(Invoke("BayShell", "pickFiles", "[{}]"), "invalid_args");
  ExpectError(Invoke("BayShell", "pickFiles", "{}"), "invalid_args");
  ExpectError(Invoke("BayShell", "prompt", "[]"), "invalid_args");
  ExpectError(Invoke("BayShell", "prompt", "[{}]"), "invalid_args");
  ExpectError(Invoke("BayShell", "showMenu", "[]"), "invalid_args");
  ExpectError(Invoke("BayShell", "showMenu", "[{}]"), "invalid_args");
  ExpectError(Invoke("BayShell", "showMenu", R"([[{"title":"No id"}]])"),
              "invalid_args");
  ExpectError(Invoke("BayShell", "confirm", "[]"), "invalid_args");
  ExpectError(Invoke("BayShell", "confirm", "[{}]"), "invalid_args");
  ExpectError(
      Invoke("BayShell", "confirm", R"([{"title":"Quit?","destructive":1}])"),
      "invalid_args");
  ExpectError(Invoke("BaySystem", "fileIcon", R"(["../file.txt",16])"),
              "invalid_args");
  ExpectError(Invoke("BaySystem", "notAMethod", "[]"), "unknown_method");
}

TEST_F(NativeHostTest, UnhandledShellDispatchLeavesTheCallbackUntouched) {
  ShellUI shell;
  bool called = false;
  ShellUI::Response callback = base::BindOnce(
      [](bool* called, const std::string&) { *called = true; }, &called);
  EXPECT_FALSE(shell.Dispatch(HostContext::ForCoordinator(*profile()),
                              "BayShell", "copyText", {}, callback));
  EXPECT_FALSE(called);
  ASSERT_TRUE(callback);
  std::move(callback).Run("unused");
  EXPECT_TRUE(called);
}

TEST_F(NativeHostTest,
       HostDestructionSettlesIconsOnceBeforeLateLoadCompletion) {
  std::vector<std::string> responses;
  for (const char* args : {R"(["missing.txt",16])", R"(["missing.pdf",32])"}) {
    host_->Invoke(
        "BaySystem", "fileIcon", args,
        base::BindOnce(
            [](std::vector<std::string>* responses,
               const std::string& response) { responses->push_back(response); },
            &responses));
  }
  // QUEUED keeps IconLoader's MIME tasks pending until we drain them below.
  EXPECT_TRUE(responses.empty());
  host_->ResetAndDeleteThis();
  EXPECT_FALSE(host_);
  ASSERT_EQ(responses.size(), 2u);
  for (const auto& response : responses) {
    auto parsed = base::JSONReader::ReadDict(response, base::JSON_PARSE_RFC);
    ASSERT_TRUE(parsed);
    const auto* value = parsed->Find("value");
    ASSERT_TRUE(value);
    EXPECT_TRUE(value->is_none());
  }
  // The real self-deleting loaders still reply after their owner is gone.
  task_environment()->RunUntilIdle();
  EXPECT_EQ(responses.size(), 2u);
}

// Use Chromium's native factory override, without creating a real desktop
// dialog. The harness root window supplies only the modal parent handle.
struct FileDialogLifetime {
  bool destroyed = false;
  bool detached = false;
  bool returned_from_listener = false;
};

class FakeFileDialog : public ui::SelectFileDialog {
 public:
  using OnShow = base::RepeatingCallback<void(FakeFileDialog*)>;
  FakeFileDialog(Listener* listener,
                 std::unique_ptr<ui::SelectFilePolicy> policy,
                 OnShow on_show)
      : SelectFileDialog(listener, std::move(policy)),
        on_show_(std::move(on_show)) {}
  bool IsRunning(gfx::NativeWindow) const override { return !!listener_; }
  void ListenerDestroyed() override {
    ++detach_count;
    lifetime->detached = true;
    listener_ = nullptr;
  }
  void Select(const ui::SelectedFileInfo& file) {
    if (listener_)
      listener_->FileSelected(file, 0);
  }
  void SelectMultiple(const std::vector<ui::SelectedFileInfo>& files) {
    if (listener_)
      listener_->MultiFilesSelected(files);
  }
  void Cancel() {
    if (listener_) {
      listener_->FileSelectionCanceled();
      // Match the native backends' accesses after listener notification.
      lifetime->returned_from_listener = true;
    }
  }
  int detach_count = 0;
  gfx::NativeWindow parent = nullptr;
  std::shared_ptr<FileDialogLifetime> lifetime =
      std::make_shared<FileDialogLifetime>();

 protected:
  ~FakeFileDialog() override { lifetime->destroyed = true; }
  void SelectFileImpl(Type type,
                      const std::u16string& title,
                      const base::FilePath& default_path,
                      const FileTypeInfo* file_types,
                      int file_type_index,
                      const base::FilePath::StringType& default_extension,
                      gfx::NativeWindow owning_window,
                      const GURL* caller) override {
    EXPECT_EQ(type, SELECT_OPEN_MULTI_FILE);
    EXPECT_EQ(title, u"Open files");
    EXPECT_TRUE(default_path.empty());
    EXPECT_FALSE(file_types);
    EXPECT_EQ(file_type_index, 0);
    EXPECT_TRUE(default_extension.empty());
    EXPECT_FALSE(caller);
    parent = owning_window;
    if (on_show_)
      on_show_.Run(this);
  }
  bool HasMultipleFileTypeChoicesImpl() override { return false; }

 private:
  OnShow on_show_;
};

class FakeFileDialogFactory : public ui::SelectFileDialogFactory {
 public:
  ui::SelectFileDialog* Create(
      ui::SelectFileDialog::Listener* listener,
      std::unique_ptr<ui::SelectFilePolicy> policy) override {
    if (unavailable)
      return nullptr;
    auto dialog = base::MakeRefCounted<FakeFileDialog>(
        listener, std::move(policy), on_show);
    dialogs.push_back(dialog);
    if (on_create)
      on_create.Run();
    return dialog.get();
  }
  bool unavailable = false;
  FakeFileDialog::OnShow on_show;
  base::RepeatingClosure on_create;
  std::vector<scoped_refptr<FakeFileDialog>> dialogs;
};

// The pinned mock predates this BrowserWindowInterface pure virtual method.
class PickerWindow : public MockBrowserWindowInterface {
 public:
  bool IsNormalBrowser() const override { return true; }
};

class ClipboardHostTest : public NativeHostTest {
 protected:
  void SetUp() override {
    NativeHostTest::SetUp();
    ui::TestClipboard::CreateForCurrentThread();
  }
  void TearDown() override {
    NativeHostTest::TearDown();
    ui::Clipboard::DestroyClipboardForCurrentThread();
  }
  std::u16string ReadText() {
    base::test::TestFuture<std::u16string> result;
    ui::Clipboard::GetForCurrentThread()->ReadText(
        ui::ClipboardBuffer::kCopyPaste, std::nullopt, result.GetCallback());
    return result.Get();
  }
};

TEST_F(ClipboardHostTest, CoordinatorAdvertisesBothClipboardMethods) {
  auto info = HostInfo();
  const auto* methods = info.FindList("optionalMethods");
  ASSERT_TRUE(methods);
  EXPECT_TRUE(methods->contains("BayShell.copyText"));
  EXPECT_TRUE(methods->contains("BayShell.copyImage"));
  EXPECT_TRUE(methods->contains("BaySystem.openFile"));
}

TEST_F(ClipboardHostTest, CoordinatorCopiesBeforeSavedDocumentsAreReady) {
  base::test::TestFuture<const std::string&> result;
  host_->Invoke("BayShell", "copyText", R"(["café 🌊"])", result.GetCallback());
  ASSERT_TRUE(result.IsReady());
  EXPECT_EQ(result.Get(), R"({"value":null})");
  EXPECT_EQ(ReadText(), u"café 🌊");
}

TEST_F(ClipboardHostTest, GlobalContractRejectsArityAndPayloadErrors) {
  EXPECT_EQ(Invoke("BayShell", "copyText", R"(["keep"])"), R"({"value":null})");
  for (const char* method : {"copyText", "copyImage"}) {
    for (const char* args : {"[]", R"(["a","b"])", "[null]", "[1]", "[{}]"})
      ExpectError(Invoke("BayShell", method, args), "invalid_args");
  }
  ExpectError(Invoke("BayShell", "copyImage", R"(["%%%"])"), "invalid_args");
  EXPECT_EQ(Invoke("BayShell", "copyImage", R"(["bm90IGFuIGltYWdl"])"),
            R"({"value":false})");
  EXPECT_EQ(ReadText(), u"keep");
}

TEST_F(ClipboardHostTest, CoordinatorCopiesAnImage) {
  // A complete opaque 1x1 PNG, with valid chunk checksums.
  EXPECT_EQ(
      Invoke(
          "BayShell", "copyImage",
          R"(["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg=="])"),
      R"({"value":true})");
  base::test::TestFuture<const std::vector<uint8_t>&> image;
  ui::Clipboard::GetForCurrentThread()->ReadPng(
      ui::ClipboardBuffer::kCopyPaste, std::nullopt, image.GetCallback());
  EXPECT_FALSE(image.Get().empty());
}

TEST_F(ClipboardHostTest,
       CopyResponseCanCloseTheHostWithoutPendingClipboardWork) {
  int calls = 0;
  host_->Invoke(
      "BayShell", "copyText", R"(["copied"])",
      base::BindLambdaForTesting([this, &calls](const std::string& response) {
        ++calls;
        EXPECT_EQ(response, R"({"value":null})");
        EXPECT_EQ(ReadText(), u"copied");
        host_->ResetAndDeleteThis();
      }));
  EXPECT_FALSE(host_);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(calls, 1);
  EXPECT_EQ(ReadText(), u"copied");
}

class WindowClipboardHostTest : public ClipboardHostTest {
 protected:
  void SetUp() override {
    ClipboardHostTest::SetUp();
    ON_CALL(window_, GetProfile()).WillByDefault(testing::Return(profile()));
    ON_CALL(window_, GetWeakPtr())
        .WillByDefault(testing::Return(window_weak_factory_.GetWeakPtr()));
    host_->ResetAndDeleteThis();
    remote_.reset();
    auto* host = new NativeHost(*main_rfh(), HostContext::ForWindow(window_),
                                remote_.BindNewPipeAndPassReceiver());
    host_ = host->GetWeakPtr();
  }
  testing::NiceMock<PickerWindow> window_;
  base::WeakPtrFactory<BrowserWindowInterface> window_weak_factory_{&window_};
};

TEST_F(WindowClipboardHostTest, WindowAdvertisesLayoutAndCaptionMethods) {
  const auto info = HostInfo();
  ExpectLayoutAndCaptionMethods(info);
  const auto* snapshot =
      info.FindDictByDottedPath("snapshots.BayShell.windowButtonLayout");
  ASSERT_TRUE(snapshot);
  EXPECT_EQ(Invoke("BayShell", "windowButtonLayout", "[]"),
            base::WriteJson(base::DictValue().Set("value", snapshot->Clone())));
  for (const char* method :
       {"minimizeWindow", "toggleMaximizeWindow", "windowState"})
    ExpectError(Invoke("BayShell", method, R"(["missing"])"), "window_error");
}

TEST_F(WindowClipboardHostTest,
       PlacementCapabilityDoesNotChangeWindowAuthority) {
  const auto info = HostInfo();
  EXPECT_EQ(
      info.FindBoolByDottedPath("constants.BayShell.globalWindowCoordinates"),
      GlobalWindowCoordinates());
  EXPECT_EQ(*info.FindString("role"), "window");
  EXPECT_EQ(Invoke("BayShell", "windowFrame", R"(["missing"])"),
            R"({"value":null})");
  ExpectError(Invoke("BayShell", "windowState", R"(["missing"])"),
              "window_error");
}

TEST_F(WindowClipboardHostTest, WindowAdvertisesAndDispatchesFileMethods) {
  const auto info = HostInfo();
  const auto* methods = info.FindList("optionalMethods");
  ASSERT_TRUE(methods);
  for (const char* method :
       {"BaySystem.fileExists", "BaySystem.downloadsFolder",
        "BaySystem.openFile", "BaySystem.revealFile", "BaySystem.moveToTrash"})
    EXPECT_TRUE(methods->contains(method));
  EXPECT_EQ(
      Invoke("BaySystem", "fileExists",
             base::WriteJson(base::ListValue().Append(Documents().value()))
                 .value()),
      R"({"value":true})");
  EXPECT_EQ(
      Invoke("BaySystem", "openFile",
             base::WriteJson(base::ListValue().Append(Documents().value()))
                 .value()),
      R"({"value":true})");
}

TEST_F(WindowClipboardHostTest,
       WindowAdvertisesAndQueriesDesktopSystemSnapshots) {
  ExpectDesktopSystemMethods(HostInfo());
  auto result = base::JSONReader::ReadDict(Invoke("BayApp", "systemInfo", "[]"),
                                           base::JSON_PARSE_RFC);
  ASSERT_TRUE(result);
  const auto* name = result->FindStringByDottedPath("value.appName");
  ASSERT_TRUE(name);
  EXPECT_EQ(*name, "Bay");
  EXPECT_EQ(Invoke("BayApp", "launchEnvironment", R"(["NOT_A_BAY_SETTING"])"),
            R"({"value":null})");
}

TEST_F(WindowClipboardHostTest,
       WindowAdvertisesAppearanceAndReceivesAppEvents) {
  const auto info = HostInfo();
  const auto* methods = info.FindList("optionalMethods");
  ASSERT_TRUE(methods);
  EXPECT_TRUE(methods->contains("BayShell.setAppearance"));
  EXPECT_TRUE(methods->contains("BayShell.isDarkAppearance"));
  EXPECT_EQ(Invoke("BayShell", "setAppearance", R"(["light"])"),
            R"({"value":null})");
  AppearanceClient client;
  client.Connect(*host_);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(client.events, (std::vector<bool>{false}));
  EXPECT_EQ(Invoke("BayShell", "setAppearance", R"(["dark"])"),
            R"({"value":null})");
  EXPECT_EQ(Invoke("BayShell", "isDarkAppearance", "[]"), R"({"value":true})");
  task_environment()->RunUntilIdle();
  EXPECT_EQ(client.events, (std::vector<bool>{false, true}));
}

TEST_F(WindowClipboardHostTest, WindowAdvertisesAndDispatchesBothMethods) {
  const auto info = HostInfo();
  const auto* methods = info.FindList("optionalMethods");
  ASSERT_TRUE(methods);
  EXPECT_TRUE(methods->contains("BayShell.copyText"));
  EXPECT_TRUE(methods->contains("BayShell.copyImage"));
  EXPECT_EQ(Invoke("BayShell", "copyText", R"(["window text"])"),
            R"({"value":null})");
  EXPECT_EQ(ReadText(), u"window text");
  EXPECT_EQ(Invoke("BayShell", "copyImage", R"([""])"), R"({"value":false})");
}

class FilePickerTest : public NativeHostTest {
 protected:
  void SetUp() override {
    NativeHostTest::SetUp();
    ON_CALL(window_, GetProfile()).WillByDefault(testing::Return(profile()));
    ON_CALL(window_, GetWeakPtr())
        .WillByDefault(testing::Return(window_weak_factory_.GetWeakPtr()));
    ON_CALL(window_, GetWindow()).WillByDefault(testing::Return(&base_window_));
    ON_CALL(base_window_, GetNativeWindow())
        .WillByDefault(testing::Return(root_window()));
    auto factory = std::make_unique<FakeFileDialogFactory>();
    factory_ = factory.get();
    ui::SelectFileDialog::SetFactory(std::move(factory));
    shell_ = std::make_unique<ShellUI>();
  }
  void TearDown() override {
    shell_.reset();
    task_environment()->RunUntilIdle();
    ui::SelectFileDialog::SetFactory(nullptr);
    factory_ = nullptr;
    NativeHostTest::TearDown();
  }
  void Pick(ShellUI::Response callback) {
    EXPECT_TRUE(shell_->Dispatch(HostContext::ForWindow(window_), "BayShell",
                                 "pickFiles", {}, callback));
  }
  void ExpectFiles(const std::string& response,
                   const std::vector<base::FilePath>& expected) {
    auto parsed = base::JSONReader::ReadDict(response, base::JSON_PARSE_RFC);
    ASSERT_TRUE(parsed);
    const auto* files = parsed->FindList("value");
    ASSERT_TRUE(files);
    ASSERT_EQ(files->size(), expected.size());
    for (size_t i = 0; i < files->size(); ++i) {
      ASSERT_TRUE((*files)[i].is_string());
      const GURL url((*files)[i].GetString());
      EXPECT_TRUE(url.SchemeIsFile());
      EXPECT_FALSE(url.has_query());
      EXPECT_FALSE(url.has_ref());
      base::FilePath roundtrip;
      ASSERT_TRUE(net::FileURLToFilePath(url, &roundtrip));
      EXPECT_EQ(roundtrip, expected[i]);
    }
  }

  testing::NiceMock<PickerWindow> window_;
  testing::NiceMock<ui::MockBaseWindow> base_window_;
  base::WeakPtrFactory<BrowserWindowInterface> window_weak_factory_{&window_};
  raw_ptr<FakeFileDialogFactory> factory_ = nullptr;
  std::unique_ptr<ShellUI> shell_;
};

TEST_F(FilePickerTest, SingleSelectionReturnsAnEscapedNativeFileUrl) {
  base::test::TestFuture<const std::string&> result;
  Pick(result.GetCallback());
  ASSERT_EQ(factory_->dialogs.size(), 1u);
  auto dialog = factory_->dialogs.back();
  EXPECT_EQ(dialog->parent, root_window());
  const base::FilePath path("/tmp/a ?#% café.txt");
  dialog->Select(ui::SelectedFileInfo(base::FilePath("/display/name"), path));
  ExpectFiles(result.Get(), {path});
  task_environment()->RunUntilIdle();
  EXPECT_EQ(dialog->detach_count, 1);
}

TEST_F(FilePickerTest, WindowHostAdvertisesFilePicking) {
  host_->ResetAndDeleteThis();
  remote_.reset();
  auto* host = new NativeHost(*main_rfh(), HostContext::ForWindow(window_),
                              remote_.BindNewPipeAndPassReceiver());
  host_ = host->GetWeakPtr();
  auto info = HostInfo();
  const auto* role = info.FindString("role");
  ASSERT_TRUE(role);
  EXPECT_EQ(*role, "window");
  const auto* methods = info.FindList("optionalMethods");
  ASSERT_TRUE(methods);
  EXPECT_TRUE(methods->contains("BayShell.pickFiles"));
  EXPECT_TRUE(methods->contains("BayShell.showMenu"));
}

TEST_F(FilePickerTest, MultipleSelectionPreservesOrderAndReservedCharacters) {
  base::test::TestFuture<const std::string&> result;
  Pick(result.GetCallback());
  const std::vector<base::FilePath> paths = {
      base::FilePath("/tmp/z#?.txt"), base::FilePath("/tmp/a%20.txt"),
      base::FilePath("/tmp/space ü.txt")};
  auto selected = ui::FilePathListToSelectedFileInfoList(paths);
  selected[1].local_path.clear();
  factory_->dialogs.back()->SelectMultiple(selected);
  ExpectFiles(result.Get(), paths);
}

TEST_F(FilePickerTest, CancelSettlesOnceAndIgnoresLateResults) {
  std::vector<std::string> results;
  Pick(base::BindOnce(
      [](std::vector<std::string>* results, const std::string& value) {
        results->push_back(value);
      },
      &results));
  auto dialog = factory_->dialogs.back();
  dialog->Cancel();
  ASSERT_EQ(results.size(), 1u);
  ExpectFiles(results[0], {});
  dialog->Select(ui::SelectedFileInfo(base::FilePath("/tmp/late")));
  dialog->Cancel();
  EXPECT_EQ(results.size(), 1u);
  task_environment()->RunUntilIdle();
  dialog->Cancel();
  EXPECT_EQ(results.size(), 1u);
  EXPECT_EQ(dialog->detach_count, 1);
}

TEST_F(FilePickerTest, RequiresTheContextWindowBeforeCheckingBusy) {
  base::test::TestFuture<const std::string&> first;
  Pick(first.GetCallback());
  base::test::TestFuture<const std::string&> busy;
  Pick(busy.GetCallback());
  ExpectError(busy.Get(), "dialog_busy");
  ON_CALL(base_window_, GetNativeWindow())
      .WillByDefault(testing::Return(nullptr));
  base::test::TestFuture<const std::string&> no_window;
  Pick(no_window.GetCallback());
  ExpectError(no_window.Get(), "window_required");
  EXPECT_EQ(factory_->dialogs.size(), 1u);
  factory_->dialogs.back()->Cancel();
  ExpectFiles(first.Get(), {});
}

TEST_F(FilePickerTest, CoordinatorCannotBorrowAWindowEvenWhenPickerIsBusy) {
  base::test::TestFuture<const std::string&> first;
  Pick(first.GetCallback());
  base::test::TestFuture<const std::string&> result;
  auto callback = result.GetCallback();
  EXPECT_TRUE(shell_->Dispatch(HostContext::ForCoordinator(*profile()),
                               "BayShell", "pickFiles", {}, callback));
  ExpectError(result.Get(), "window_required");
  EXPECT_EQ(factory_->dialogs.size(), 1u);
}

TEST_F(FilePickerTest, NullFactoryResultIsAnErrorAndReleasesBusySlot) {
  factory_->unavailable = true;
  base::test::TestFuture<const std::string&> result;
  Pick(result.GetCallback());
  ExpectError(result.Get(), "dialog_unavailable");
  task_environment()->RunUntilIdle();
  factory_->unavailable = false;
  base::test::TestFuture<const std::string&> retry;
  Pick(retry.GetCallback());
  ASSERT_EQ(factory_->dialogs.size(), 1u);
  factory_->dialogs.back()->Cancel();
  ExpectFiles(retry.Get(), {});
}

TEST_F(FilePickerTest, OwnerTeardownSettlesOnceBeforeALateCallback) {
  std::vector<std::string> results;
  Pick(base::BindOnce(
      [](std::vector<std::string>* results, const std::string& value) {
        results->push_back(value);
      },
      &results));
  auto dialog = factory_->dialogs.back();
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&FakeFileDialog::Cancel, dialog));
  shell_.reset();
  ASSERT_EQ(results.size(), 1u);
  ExpectFiles(results[0], {});
  task_environment()->RunUntilIdle();
  EXPECT_EQ(results.size(), 1u);
  EXPECT_EQ(dialog->detach_count, 1);
}

TEST_F(FilePickerTest, SynchronousCompletionCanDestroyTheOwnerDuringShow) {
  factory_->on_show = base::BindRepeating(&FakeFileDialog::Cancel);
  int calls = 0;
  Pick(base::BindOnce(
      [](std::unique_ptr<ShellUI>* shell, int* calls,
         const std::string& value) {
        ++*calls;
        EXPECT_EQ(value, R"({"value":[]})");
        shell->reset();
      },
      &shell_, &calls));
  EXPECT_FALSE(shell_);
  EXPECT_EQ(calls, 1);
  task_environment()->RunUntilIdle();
  EXPECT_EQ(factory_->dialogs.back()->detach_count, 1);
}

TEST_F(FilePickerTest, NestedOwnerTeardownDuringShowCancelsThePendingResponse) {
  factory_->on_show = base::BindRepeating(
      [](std::unique_ptr<ShellUI>* shell, FakeFileDialog*) { shell->reset(); },
      &shell_);
  base::test::TestFuture<const std::string&> result;
  Pick(result.GetCallback());
  EXPECT_FALSE(shell_);
  ExpectFiles(result.Get(), {});
  task_environment()->RunUntilIdle();
  EXPECT_EQ(factory_->dialogs.back()->detach_count, 1);
}

TEST_F(FilePickerTest, OwnerTeardownDuringCreateDoesNotShowTheDialog) {
  factory_->on_create = base::BindLambdaForTesting([this] { shell_.reset(); });
  base::test::TestFuture<const std::string&> result;
  Pick(result.GetCallback());
  ExpectFiles(result.Get(), {});
  ASSERT_EQ(factory_->dialogs.size(), 1u);
  EXPECT_FALSE(factory_->dialogs.back()->parent);
  EXPECT_EQ(factory_->dialogs.back()->detach_count, 1);
}

TEST_F(FilePickerTest, DialogSurvivesOwnerDestructionAndNestedLoopInResponse) {
  std::shared_ptr<FileDialogLifetime> lifetime;
  Pick(base::BindLambdaForTesting([this, &lifetime](const std::string& value) {
    ExpectFiles(value, {});
    lifetime = factory_->dialogs.back()->lifetime;
    factory_->dialogs.clear();
    shell_.reset();
    task_environment()->RunUntilIdle();
    EXPECT_FALSE(lifetime->destroyed);
    EXPECT_FALSE(lifetime->detached);
  }));
  auto* dialog = factory_->dialogs.back().get();
  dialog->Cancel();
  EXPECT_TRUE(lifetime->returned_from_listener);
  EXPECT_FALSE(lifetime->destroyed);
  EXPECT_FALSE(lifetime->detached);
  task_environment()->RunUntilIdle();
  EXPECT_TRUE(lifetime->destroyed);
  EXPECT_TRUE(lifetime->detached);
}

TEST_F(FilePickerTest, StaysBusyUntilNativeCleanupAndCannotResetANewerPicker) {
  base::test::TestFuture<const std::string&> reentrant;
  factory_->on_show = base::BindRepeating(&FakeFileDialog::Cancel);
  Pick(base::BindLambdaForTesting([this, &reentrant](const std::string& value) {
    EXPECT_EQ(value, R"({"value":[]})");
    factory_->on_show.Reset();
    Pick(reentrant.GetCallback());
  }));
  ExpectError(reentrant.Get(), "dialog_busy");
  ASSERT_EQ(factory_->dialogs.size(), 1u);
  base::test::TestFuture<const std::string&> before_cleanup;
  Pick(before_cleanup.GetCallback());
  ExpectError(before_cleanup.Get(), "dialog_busy");
  task_environment()->RunUntilIdle();
  base::test::TestFuture<const std::string&> second;
  Pick(second.GetCallback());
  ASSERT_EQ(factory_->dialogs.size(), 2u);
  auto old = factory_->dialogs.front();
  auto current = factory_->dialogs.back();
  old->Cancel();
  task_environment()->RunUntilIdle();
  base::test::TestFuture<const std::string&> busy;
  Pick(busy.GetCallback());
  ExpectError(busy.Get(), "dialog_busy");
  EXPECT_FALSE(second.IsReady());
  current->Select(ui::SelectedFileInfo(base::FilePath("/tmp/new")));
  ExpectFiles(second.Get(), {base::FilePath("/tmp/new")});
}

}  // namespace
}  // namespace bay
