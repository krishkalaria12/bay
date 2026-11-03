// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/tab_strip_mirror.h"

#include <limits>
#include <string>
#include <vector>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/test/bind.h"
#include "base/test/scoped_command_line.h"
#include "chrome/browser/bay/webui/host_context.h"
#include "chrome/browser/bay/webui/tab_broker.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/tabs/tab_group_model.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/test/base/browser_with_test_window_test.h"
#include "chrome/test/base/testing_profile.h"
#include "components/tab_groups/tab_group_color.h"
#include "components/tab_groups/tab_group_visual_data.h"
#include "components/tabs/public/tab_group.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
class TabStripMirrorTest : public BrowserWithTestWindowTest {
 protected:
  std::optional<std::string> GetDefaultProfileName() override {
    return "Default";
  }
  void SetUp() override {
    command_line_.GetProcessCommandLine()->AppendSwitch("bay-legacy-runtime");
    BrowserWithTestWindowTest::SetUp();
    ASSERT_TRUE(
        WindowRegistry::Get()
            .Open(HostContext::ForWindow(*browser()), "strip-test",
                  base::DictValue()
                      .Set("profile",
                           profile()->GetPath().BaseName().AsUTF8Unsafe())
                      .Set("focus", false))
            .ok);
    TabStripMirror::Get().Start(
        base::BindLambdaForTesting([this](base::DictValue tx) {
          transactions_.push_back(std::move(tx));
        }));
  }
  void TearDown() override {
    TabStripMirror::Get().Start(TabStripMirror::Sink());
    BrowserWithTestWindowTest::TearDown();
  }
  void Mount(const std::string& key) {
    const auto result = TabBroker::Get().Mount(
        browser(), base::DictValue()
                       .Set("transferKey", key)
                       .Set("url", "https://example.test/" + key)
                       .Set("visible", false));
    ASSERT_TRUE(result.error.empty()) << result.error;
  }
  bool Apply(base::DictValue command) {
    const auto before = transactions_.size();
    command.Set("strip", browser()->GetSessionID().id());
    const auto result = Invoke(
        "tabStripCommand",
        base::ListValue().Append(next_command_++).Append(std::move(command)));
    EXPECT_TRUE(result.contains("value"));
    EXPECT_EQ(before + 1, transactions_.size());
    return transactions_.size() == before + 1 &&
           !transactions_.back().FindBool("rejected").value_or(false);
  }
  std::vector<std::string> Order() {
    std::vector<std::string> order;
    auto* model = browser()->tab_strip_model();
    for (int i = 0; i < model->count(); ++i)
      order.push_back(TabBroker::Get().KeyFor(model->GetWebContentsAt(i)));
    return order;
  }
  base::DictValue Invoke(const std::string& method,
                         base::ListValue args,
                         bool window = false) {
    std::string result;
    TabStripMirror::Response reply = base::BindLambdaForTesting(
        [&](const std::string& json) { result = json; });
    const auto context = window ? HostContext::ForWindow(*browser())
                                : HostContext::ForCoordinator(*profile());
    EXPECT_TRUE(TabStripMirror::Get().Dispatch(context, method, args, reply));
    return base::JSONReader::ReadDict(result, base::JSON_PARSE_RFC)
        .value_or(base::DictValue());
  }
  void UseSharedRuntime() {
    command_line_.GetProcessCommandLine()->RemoveSwitch("bay-legacy-runtime");
    command_line_.GetProcessCommandLine()->RemoveSwitch("bay-hosting-spike");
  }
  std::vector<base::DictValue> transactions_;

 private:
  base::test::ScopedCommandLine command_line_;
  int next_command_ = 100;
};

TEST_F(TabStripMirrorTest, ActivateArrangeAndStaleKeysKeepIdentity) {
  Mount("a");
  Mount("b");
  Mount("c");
  ASSERT_TRUE(Apply(base::DictValue().Set("op", "activate").Set("key", "b")));
  EXPECT_EQ("b", TabBroker::Get().KeyFor(
                     browser()->tab_strip_model()->GetActiveWebContents()));
  ASSERT_TRUE(Apply(base::DictValue()
                        .Set("op", "arrange")
                        .Set("keys", base::ListValue().Append("c").Append("a"))
                        .Set("pinned", 1)));
  EXPECT_EQ((std::vector<std::string>{"c", "a", "b"}), Order());
  EXPECT_TRUE(browser()->tab_strip_model()->IsTabPinned(0));
  EXPECT_FALSE(browser()->tab_strip_model()->IsTabPinned(1));
  EXPECT_EQ("b", TabBroker::Get().KeyFor(
                     browser()->tab_strip_model()->GetActiveWebContents()));
  EXPECT_FALSE(
      Apply(base::DictValue().Set("op", "activate").Set("key", "gone")));
  EXPECT_FALSE(Apply(base::DictValue()
                         .Set("op", "arrange")
                         .Set("keys", base::ListValue().Append("gone"))
                         .Set("pinned", 0)));
  EXPECT_EQ((std::vector<std::string>{"c", "a", "b"}), Order());
  ASSERT_TRUE(
      Apply(base::DictValue()
                .Set("op", "arrange")
                .Set("keys", base::ListValue().Append("gone").Append("b"))
                .Set("pinned", 0)));
  EXPECT_EQ("b", Order()[1]);  // Chrome keeps the unlisted pinned tab first.
}

TEST_F(TabStripMirrorTest, GroupsAndVisualsRoundTripThroughChrome) {
  Mount("a");
  Mount("b");
  ASSERT_TRUE(Apply(base::DictValue()
                        .Set("op", "group")
                        .Set("keys", base::ListValue().Append("a").Append("b"))
                        .Set("group", "new")
                        .Set("title", "Shared")
                        .Set("color", "blue")
                        .Set("collapsed", true)));
  auto* model = browser()->tab_strip_model();
  const auto group = model->GetTabGroupForTab(0);
  ASSERT_TRUE(group);
  EXPECT_EQ(group, model->GetTabGroupForTab(1));
  const auto* visuals =
      model->group_model()->GetTabGroup(*group)->visual_data();
  EXPECT_EQ(u"Shared", visuals->title());
  EXPECT_EQ(tab_groups::TabGroupColorId::kBlue, visuals->color());
  EXPECT_TRUE(visuals->is_collapsed());
  EXPECT_TRUE(Apply(base::DictValue()
                        .Set("op", "group")
                        .Set("keys", base::ListValue().Append("a"))
                        .Set("group", base::Value())));
  for (int i = 0; i < model->count(); ++i)
    if (TabBroker::Get().KeyFor(model->GetWebContentsAt(i)) == "a")
      EXPECT_FALSE(model->GetTabGroupForTab(i));
}

TEST_F(TabStripMirrorTest, InvalidCommandsDoNotPartiallyMutateTheStrip) {
  Mount("a");
  Mount("b");
  EXPECT_FALSE(Apply(base::DictValue()
                         .Set("op", "arrange")
                         .Set("keys", base::ListValue().Append("a").Append("a"))
                         .Set("pinned", 1)));
  EXPECT_FALSE(Apply(base::DictValue()
                         .Set("op", "group")
                         .Set("keys", base::ListValue().Append("a"))
                         .Set("group", "new")
                         .Set("color", "invalid")));
  EXPECT_EQ((std::vector<std::string>{"a", "b"}), Order());
  EXPECT_FALSE(browser()->tab_strip_model()->IsTabPinned(0));
  EXPECT_FALSE(browser()->tab_strip_model()->GetTabGroupForTab(0));
}

TEST_F(TabStripMirrorTest, AppChangesBatchAndSnapshotsDoNotConsumeTheirEvents) {
  Mount("a");
  Mount("b");
  auto* model = browser()->tab_strip_model();
  const auto before = transactions_.size();
  {
    TabStripMirror::AppChange change;
    model->SetTabPinned(0, true);
    model->ActivateTabAt(1);
    EXPECT_EQ(before, transactions_.size());
    EXPECT_TRUE(Invoke("tabStrips", base::ListValue()).FindDict("value"));
  }
  ASSERT_EQ(before + 1, transactions_.size());
  EXPECT_EQ(-1, transactions_.back().FindInt("cmd"));
  model->ActivateTabAt(0);
  ASSERT_EQ(before + 2, transactions_.size());
  ASSERT_TRUE(transactions_.back().Find("cmd"));
  EXPECT_TRUE(transactions_.back().Find("cmd")->is_none());
}

TEST_F(TabStripMirrorTest, SharedWindowCannotReadOrChangeOtherWindowsStrips) {
  Mount("a");
  UseSharedRuntime();
  EXPECT_TRUE(Invoke("tabStrips", base::ListValue(), true).FindDict("error"));
  const auto before = transactions_.size();
  EXPECT_TRUE(Invoke("tabStripCommand",
                     base::ListValue().Append(42).Append(
                         base::DictValue()
                             .Set("strip", browser()->GetSessionID().id())
                             .Set("op", "activate")
                             .Set("key", "a")),
                     true)
                  .FindDict("error"));
  EXPECT_EQ(before, transactions_.size());
  EXPECT_TRUE(Invoke("tabStrips", base::ListValue()).FindDict("value"));
}

TEST_F(TabStripMirrorTest, MissingStripCommandsStillAcknowledgeOnce) {
  const auto spec = base::DictValue()
                        .Set("op", "activate")
                        .Set("strip", 123456)
                        .Set("key", "gone");
  const auto before = transactions_.size();
  const auto result = Invoke("tabStripCommand",
                             base::ListValue().Append(42).Append(spec.Clone()));
  EXPECT_TRUE(result.contains("value"));
  ASSERT_EQ(before + 1, transactions_.size());
  EXPECT_EQ(42, transactions_.back().FindDouble("cmd"));
  EXPECT_EQ(true, transactions_.back().FindBool("rejected"));
  const auto rev = transactions_.back().FindDouble("rev");
  ASSERT_TRUE(rev);
  const auto snapshot = Invoke("tabStrips", base::ListValue());
  ASSERT_TRUE(snapshot.FindDict("value"));
  EXPECT_EQ(rev, snapshot.FindDict("value")->FindDouble("rev"));
  EXPECT_TRUE(Invoke("tabStripCommand",
                     base::ListValue()
                         .Append(std::numeric_limits<double>::quiet_NaN())
                         .Append(spec.Clone()))
                  .FindDict("error"));
  EXPECT_EQ(before + 1, transactions_.size());
}
}  // namespace bay
