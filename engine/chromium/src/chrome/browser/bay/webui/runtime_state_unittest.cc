// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/runtime_state.h"

#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace bay {
namespace {
base::DictValue State() {
  auto state = base::JSONReader::ReadDict(R"({
    "spaces":{},"spaceOrder":[],"orphanedProfileData":[],
    "windows":{},"windowOrder":[],"closedWindows":[],"pinnedFolders":{},"folderMoveUndo":[],
    "tabLists":{},"peeks":{},"closedPeeks":{},"localFiles":{},"sidebarUndo":{},
    "tabs":{},"live":{},"closedTabs":[],"groups":{},"selection":{},
    "cleanedTabs":[],"privateCleanedTabs":{},"privateSiteMutes":{},
    "closedGroups":[],"deletedGroups":[],"splits":{},"history":{},
    "bookmarkUndo":[],
    "historyReady":{},"historyFloor":{},"bookmarks":{"nodes":{},"roots":{}},
    "bookmarksReady":{},"settings":{},
    "ui":{"focusedWindowId":null,"focusOrder":[],"appDark":true},
    "windowUi":{},"find":{},"downloads":[],"services":{}
  })",
                                          base::JSON_PARSE_RFC);
  CHECK(state);
  return std::move(*state);
}
void AddWindow(base::DictValue& state, const char* id, bool incognito) {
  const std::string profile =
      incognito ? std::string("incognito:") + id : "default";
  const std::string tab_id = std::string(id) + "-tab";
  if (!incognito && !state.FindDict("spaces")->contains(profile)) {
    state.FindDict("spaces")->Set(profile,
                                  base::DictValue().Set("id", profile));
    state.FindList("spaceOrder")->Append(profile);
  }
  auto* list = state.FindDict("tabLists")->FindList(profile);
  if (!list) {
    state.FindDict("tabLists")->Set(profile, base::ListValue());
    list = state.FindDict("tabLists")->FindList(profile);
  }
  list->Append(tab_id);
  state.FindDict("windows")->Set(
      id, base::DictValue()
              .Set("id", id)
              .Set("spaceId", profile)
              .Set("incognito", incognito)
              .Set("activeTabIds", base::DictValue().Set(profile, tab_id)));
  state.FindDict("tabs")->Set(tab_id,
                              base::DictValue()
                                  .Set("id", tab_id)
                                  .Set("windowId", id)
                                  .Set("spaceId", profile)
                                  .Set("url", std::string(id) + "-secret"));
  state.FindList("windowOrder")->Append(id);
  state.FindDict("ui")->FindList("focusOrder")->Append(id);
  state.FindDict("ui")->Set("focusedWindowId", id);
  state.FindDict("live")->Set(
      tab_id, base::DictValue().Set("title", std::string(id) + "-secret"));
  state.FindDict("find")->Set(
      tab_id, base::DictValue().Set("query", std::string(id) + "-secret"));
  state.FindDict("windowUi")
      ->Set(id, base::DictValue().Set("panel", std::string(id) + "-secret"));
  state.FindDict("selection")->Set(id, base::ListValue().Append(tab_id));
  state.FindDict("groups")->Set(
      std::string(id) + "-group",
      base::DictValue()
          .Set("tabIds", base::ListValue().Append(tab_id))
          .Set("spaceId", profile)
          .Set("name", std::string(id) + "-secret"));
  state.FindDict("splits")->Set(
      std::string(id) + "-split",
      base::DictValue().Set("tabIds", base::ListValue().Append(tab_id)));
  if (incognito) {
    state.FindDict("privateCleanedTabs")
        ->Set(id, base::ListValue().Append(base::DictValue().Set(
                      "url", std::string(id) + "-secret")));
    state.FindDict("privateSiteMutes")
        ->Set(id, base::DictValue().Set(std::string(id) + "-secret", true));
  }
  state.FindList("downloads")
      ->Append(base::DictValue()
                   .Set("profile", profile)
                   .Set("url", std::string(id) + "-secret"));
}
// A Little Bay window lists its tab under its own id, not its space's.
void AddLittleBay(base::DictValue& state, const char* id) {
  AddWindow(state, id, false);
  state.FindDict("windows")->FindDict(id)->Set("kind", "small");
  const std::string tab_id = std::string(id) + "-tab";
  state.FindDict("tabLists")->FindList("default")->EraseValue(base::Value(tab_id));
  state.FindDict("tabLists")->Set(id, base::ListValue().Append(tab_id));
}
TEST(RuntimePageEventsTest, AuthorizesProfileWithoutRequiringWindowOwnership) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private", true);
  EXPECT_TRUE(CanAcceptRuntimePageEvent(state, "normal-tab", ""));
  EXPECT_FALSE(CanAcceptRuntimePageEvent(state, "normal-tab", "default"));
  EXPECT_FALSE(CanAcceptRuntimePageEvent(state, "missing", ""));
  EXPECT_FALSE(CanAcceptRuntimePageEvent(state, "", ""));
  EXPECT_FALSE(CanAcceptRuntimePageEvent(state, "private-tab", ""));
  EXPECT_TRUE(
      CanAcceptRuntimePageEvent(state, "private-tab", "incognito:private"));
  EXPECT_FALSE(
      CanAcceptRuntimePageEvent(state, "private-tab", "incognito:other"));
  state.FindDict("tabs")->FindDict("normal-tab")->Set("windowId", "");
  EXPECT_TRUE(CanAcceptRuntimePageEvent(state, "normal-tab", ""));
  state.FindDict("spaces")->FindDict("default")->Set("profileId", "Profile 2");
  EXPECT_FALSE(CanAcceptRuntimePageEvent(state, "normal-tab", ""));
  EXPECT_TRUE(CanAcceptRuntimePageEvent(state, "normal-tab", "Profile 2"));
  state.FindDict("windows")->Remove("private");
  EXPECT_FALSE(
      CanAcceptRuntimePageEvent(state, "private-tab", "incognito:private"));
}
TEST(RuntimePageEventsTest, MountRequiresTrustedOwnerAndProfile) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  EXPECT_TRUE(CanMountRuntimePage(state, "normal", "normal-tab", ""));
  EXPECT_FALSE(CanMountRuntimePage(state, "other", "normal-tab", ""));
  EXPECT_FALSE(CanMountRuntimePage(state, "normal", "normal-tab", "Profile 2"));
  EXPECT_FALSE(CanMountRuntimePage(state, "normal", "missing", ""));
  EXPECT_FALSE(CanMountRuntimePage(state, "", "normal-tab", ""));
}
TEST(RuntimePageOpenTest, RequiresTheAcceptedMountToken) {
  auto state = State();
  AddWindow(state, "normal", false);
  auto* tab = state.FindDict("tabs")->FindDict("normal-tab");
  EXPECT_TRUE(CanMountRuntimePageOffer(state, "normal-tab", ""));
  EXPECT_FALSE(CanMountRuntimePageOffer(state, "missing", ""));
  EXPECT_FALSE(CanMountRuntimePageOffer(state, "normal-tab", "offer"));
  tab->Set("adoptId", "offer");
  EXPECT_TRUE(CanMountRuntimePageOffer(state, "normal-tab", "offer"));
  EXPECT_FALSE(CanMountRuntimePageOffer(state, "normal-tab", ""));
  EXPECT_FALSE(CanMountRuntimePageOffer(state, "normal-tab", "other"));
  tab->Remove("adoptId");
  tab->Set("wakeAdoptId", "offer");
  EXPECT_TRUE(CanMountRuntimePageOffer(state, "normal-tab", "offer"));
  EXPECT_FALSE(CanMountRuntimePageOffer(state, "normal-tab", ""));
}
TEST(RuntimePageOpenTest, FindsOneOwnedPublicDestinationWithTheExactProfile) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  auto* tab = state.FindDict("tabs")->FindDict("normal-tab");
  tab->Set("adoptId", "offer");
  auto target = FindRuntimePageOpenTarget(state, "offer", "", false);
  ASSERT_TRUE(target);
  EXPECT_EQ(target->tab_id, "normal-tab");
  EXPECT_EQ(target->window_id, "normal");
  EXPECT_EQ(target->profile, "");
  tab->Set("windowId", "other");
  target = FindRuntimePageOpenTarget(state, "offer", "", false);
  ASSERT_TRUE(target);
  EXPECT_EQ(target->tab_id, "normal-tab");
  EXPECT_EQ(target->window_id, "other");
  EXPECT_EQ(target->profile, "");
  EXPECT_FALSE(FindRuntimePageOpenTarget(state, "", "", false));
  EXPECT_FALSE(FindRuntimePageOpenTarget(state, "other", "", false));
  EXPECT_FALSE(FindRuntimePageOpenTarget(state, "offer", "Profile 2", false));
  EXPECT_FALSE(FindRuntimePageOpenTarget(state, "offer", "", true));
  state.FindDict("spaces")->FindDict("default")->Set("profileId", "Profile 2");
  EXPECT_TRUE(FindRuntimePageOpenTarget(state, "offer", "Profile 2", false));
  EXPECT_FALSE(FindRuntimePageOpenTarget(state, "offer", "", false));
}
TEST(RuntimePageOpenTest, RejectsDuplicateClaimsAcrossAdoptAndWakeFields) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  state.FindDict("tabs")->FindDict("normal-tab")->Set("adoptId", "offer");
  state.FindDict("tabs")->FindDict("other-tab")->Set("wakeAdoptId", "offer");
  EXPECT_FALSE(FindRuntimePageOpenTarget(state, "offer", "", false));
  state.FindDict("tabs")->FindDict("other-tab")->Remove("wakeAdoptId");
  EXPECT_TRUE(FindRuntimePageOpenTarget(state, "offer", "", false));
}
TEST(RuntimePageOpenTest, RejectsUnownedUnloadedAndDeletedDestinations) {
  auto state = State();
  AddWindow(state, "normal", false);
  auto* tab = state.FindDict("tabs")->FindDict("normal-tab");
  tab->Set("wakeAdoptId", "offer");
  tab->Set("windowId", "");
  EXPECT_FALSE(FindRuntimePageOpenTarget(state, "offer", "", false));
  tab->Set("windowId", "normal");
  tab->Set("unloaded", true);
  EXPECT_FALSE(FindRuntimePageOpenTarget(state, "offer", "", false));
  tab->Set("unloaded", false);
  state.FindDict("windows")->Remove("normal");
  EXPECT_FALSE(FindRuntimePageOpenTarget(state, "offer", "", false));
}
TEST(RuntimePageOpenTest, PrivateClaimsRequireTheDestinationPrivateNamespace) {
  auto state = State();
  AddWindow(state, "private", true);
  auto* tab = state.FindDict("tabs")->FindDict("private-tab");
  tab->Set("adoptId", "offer");
  auto target = FindRuntimePageOpenTarget(state, "offer", "", true);
  ASSERT_TRUE(target);
  EXPECT_EQ(target->profile, "incognito:private");
  EXPECT_FALSE(FindRuntimePageOpenTarget(state, "offer", "", false));
  tab->Set("spaceId", "incognito:other");
  EXPECT_FALSE(FindRuntimePageOpenTarget(state, "offer", "", true));
}
TEST(RuntimePageEventsTest, ReplaysLatestFactsInNativeSequenceOrder) {
  auto state = State();
  AddWindow(state, "normal", false);
  RuntimePageEventCache cache;
  auto first = cache.Record(state, "normal-tab", "", 42, "onNavigationChange",
                            base::DictValue().Set("url", "https://one.test"));
  ASSERT_TRUE(first);
  auto second = cache.Record(state, "normal-tab", "", 42, "onProgress",
                             base::DictValue().Set("progress", 0.5));
  ASSERT_TRUE(second);
  auto third = cache.Record(state, "normal-tab", "", 42, "onNavigationChange",
                            base::DictValue().Set("url", "https://two.test"));
  ASSERT_TRUE(third);
  auto replay = cache.Replay(state);
  ASSERT_EQ(replay.size(), 2u);
  EXPECT_EQ(replay[0], *second);
  EXPECT_EQ(replay[1], *third);
  EXPECT_EQ(*first->FindDouble("sequence"), 1);
  EXPECT_EQ(*third->FindDouble("sequence"), 3);
  EXPECT_EQ(cache.Replay(state), replay);
  auto next = cache.Record(state, "normal-tab", "", 42, "onMedia",
                           base::DictValue().Set("playing", true));
  ASSERT_TRUE(next);
  EXPECT_EQ(*next->FindDouble("sequence"), 4);
}
TEST(RuntimePageEventsTest, RejectsUnknownProfilesEventsAndInvalidPages) {
  auto state = State();
  AddWindow(state, "normal", false);
  RuntimePageEventCache cache;
  EXPECT_FALSE(cache.Record(state, "normal-tab", "other", 1, "onProgress",
                            base::DictValue()));
  EXPECT_FALSE(
      cache.Record(state, "missing", "", 1, "onProgress", base::DictValue()));
  EXPECT_FALSE(cache.Record(state, "normal-tab", "", 0, "onProgress",
                            base::DictValue()));
  EXPECT_FALSE(cache.Record(state, "normal-tab", "", 1, "onPageFocus",
                            base::DictValue()));
  EXPECT_FALSE(
      cache.Record(state, "normal-tab", "", 1, "onFavicon",
                   base::DictValue().Set("url", std::string(262145, 'x'))));
  auto fact =
      cache.Record(state, "normal-tab", "", 1, "onProgress", base::DictValue());
  ASSERT_TRUE(fact);
  EXPECT_EQ(*fact->FindDouble("sequence"), 1);
}
TEST(RuntimePageEventsTest, DropsClosedAndReprofiledTabsBeforeReplay) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  RuntimePageEventCache cache;
  ASSERT_TRUE(cache.Record(state, "normal-tab", "", 1, "onProgress",
                           base::DictValue()));
  ASSERT_TRUE(
      cache.Record(state, "other-tab", "", 2, "onMedia", base::DictValue()));
  state.FindDict("tabs")->Remove("normal-tab");
  EXPECT_EQ(cache.Replay(state).size(), 1u);
  state.FindDict("spaces")->FindDict("default")->Set("profileId", "Profile 2");
  EXPECT_TRUE(cache.Replay(state).empty());
}
TEST(RuntimePageEventsTest, ClearsOldTerminalFactsOnNewNavigationAndPage) {
  auto state = State();
  AddWindow(state, "normal", false);
  RuntimePageEventCache cache;
  ASSERT_TRUE(cache.Record(state, "normal-tab", "", 1, "onNavigationChange",
                           base::DictValue().Set("url", "https://one.test")));
  for (const char* event :
       {"onDownloadNavigation", "onDiscarded", "onLoadError"})
    ASSERT_TRUE(
        cache.Record(state, "normal-tab", "", 1, event, base::DictValue()));
  ASSERT_TRUE(cache.Record(
      state, "normal-tab", "", 1, "onNavigationChange",
      base::DictValue().Set("url", "https://one.test").Set("isLoading", true)));
  EXPECT_EQ(cache.Replay(state).size(), 1u);
  ASSERT_TRUE(
      cache.Record(state, "normal-tab", "", 1, "onFavicon",
                   base::DictValue().Set("url", "https://one.test/icon")));
  ASSERT_TRUE(
      cache.Record(state, "normal-tab", "", 2, "onNavigationChange",
                   base::DictValue().Set("url", "https://new-page.test")));
  auto replay = cache.Replay(state);
  ASSERT_EQ(replay.size(), 1u);
  EXPECT_EQ(replay[0].FindInt("browserId"), 2);
  cache.Remove("normal-tab");
  EXPECT_TRUE(cache.Replay(state).empty());
}
TEST(RuntimePageEventsTest, BoundsPayloadBytesAcrossTabs) {
  auto state = State();
  AddWindow(state, "normal", false);
  RuntimePageEventCache cache;
  for (int index = 0; index < 80; ++index) {
    const auto id = "tab-" + std::to_string(index);
    state.FindDict("tabs")->Set(id, base::DictValue()
                                        .Set("id", id)
                                        .Set("spaceId", "default")
                                        .Set("windowId", "normal"));
    ASSERT_TRUE(cache.Record(
        state, id, "", index + 1, "onFavicon",
        base::DictValue().Set("url", std::string(240 * 1024, 'x'))));
  }
  auto replay = cache.Replay(state);
  ASSERT_FALSE(replay.empty());
  EXPECT_LT(replay.size(), 80u);
  EXPECT_NE(*replay.front().FindString("tabId"), "tab-0");
  EXPECT_EQ(*replay.back().FindString("tabId"), "tab-79");
}
TEST(RuntimePageEventsTest, BoundsTabsWhileKeepingNewFacts) {
  auto state = State();
  AddWindow(state, "normal", false);
  RuntimePageEventCache cache;
  for (size_t index = 0; index <= RuntimePageEventCache::kMaximumTabs;
       ++index) {
    const auto id = "tab-" + std::to_string(index);
    state.FindDict("tabs")->Set(id, base::DictValue()
                                        .Set("id", id)
                                        .Set("spaceId", "default")
                                        .Set("windowId", "normal"));
    ASSERT_TRUE(cache.Record(state, id, "", static_cast<int>(index + 1),
                             "onProgress", base::DictValue()));
  }
  const auto replay = cache.Replay(state);
  ASSERT_EQ(replay.size(), RuntimePageEventCache::kMaximumTabs);
  EXPECT_EQ(*replay.front().FindString("tabId"), "tab-1");
}
TEST(RuntimeStateTest, FiltersAllPrivateSlicesForNormalWindow) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private-one", true);
  AddWindow(state, "private-two", true);
  auto projected = ProjectRuntimeState(state, "normal");
  ASSERT_TRUE(projected);
  ASSERT_TRUE(IsRuntimeState(*projected));
  const auto json = base::WriteJson(*projected).value();
  EXPECT_EQ(json.find("private-one"), std::string::npos);
  EXPECT_EQ(json.find("private-two"), std::string::npos);
  EXPECT_NE(json.find("normal-secret"), std::string::npos);
  EXPECT_TRUE(projected->FindDict("ui")->Find("focusedWindowId")->is_none());
  // Projection must never mutate browser-owned recovery state.
  EXPECT_EQ(state.FindDict("windows")->size(), 3u);
}
TEST(RuntimeStateTest, PrivateWindowOnlyReceivesOwnPrivateDataAndDownloads) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private-one", true);
  AddWindow(state, "private-two", true);
  state.FindList("downloads")
      ->Append(base::DictValue().Set("url", "legacy-public"));
  auto projected = ProjectRuntimeState(state, "private-one");
  ASSERT_TRUE(projected);
  EXPECT_EQ(base::WriteJson(*projected)->find("private-two"),
            std::string::npos);
  EXPECT_EQ(projected->FindList("downloads")->size(), 1u);
  EXPECT_EQ(*projected->FindList("downloads")
                 ->front()
                 .GetDict()
                 .FindString("profile"),
            "incognito:private-one");
  EXPECT_EQ(projected->FindDict("privateSiteMutes")->size(), 1u);
  EXPECT_TRUE(projected->FindDict("windows")->contains("normal"));
}
TEST(RuntimeStateTest, KeepsUnprofiledPublicDownloadAndRejectsPrivateAlias) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private-one", true);
  state.FindList("downloads")
      ->Append(base::DictValue().Set("url", "legacy-public"));
  auto projected = ProjectRuntimeState(state, "normal");
  ASSERT_TRUE(projected);
  EXPECT_EQ(projected->FindList("downloads")->size(), 2u);
  state.FindDict("windows")
      ->FindDict("private-one")
      ->Set("spaceId", "incognito:someone-else");
  EXPECT_FALSE(IsRuntimeState(state));
  EXPECT_FALSE(ProjectRuntimeState(state, "normal"));
}
TEST(RuntimeStateTest, FiltersPrivateBookmarkRootsAndUnreachableNodes) {
  auto state = State();
  AddWindow(state, "normal", false);
  auto* bookmarks = state.FindDict("bookmarks");
  bookmarks->FindDict("roots")->Set(
      "default", base::DictValue().Set("bar", "public-root"));
  bookmarks->FindDict("roots")->Set(
      "incognito:private", base::DictValue().Set("bar", "private-root"));
  auto* nodes = bookmarks->FindDict("nodes");
  nodes->Set(
      "public-root",
      base::DictValue().Set("children", base::ListValue().Append("shared")));
  nodes->Set(
      "private-root",
      base::DictValue().Set(
          "children", base::ListValue().Append("shared").Append("secret")));
  nodes->Set("shared", base::DictValue().Set("title", "shared-bookmark"));
  nodes->Set("secret", base::DictValue().Set("url", "private-bookmark-secret"));
  auto projected = ProjectRuntimeState(state, "normal");
  ASSERT_TRUE(projected);
  EXPECT_EQ(base::WriteJson(*projected)->find("private-bookmark-secret"),
            std::string::npos);
  EXPECT_TRUE(
      projected->FindDict("bookmarks")->FindDict("nodes")->contains("shared"));
  EXPECT_FALSE(projected->FindDict("bookmarks")
                   ->FindDict("roots")
                   ->contains("incognito:private"));
}
TEST(RuntimeStateTest, FiltersPrivateClosedRecordsIncludingLegacyFlags) {
  auto state = State();
  AddWindow(state, "normal", false);
  for (const auto* key : {"closedWindows", "closedTabs", "cleanedTabs",
                          "closedGroups", "deletedGroups"}) {
    state.FindList(key)->Append(base::DictValue().Set("url", "public-closed"));
    state.FindList(key)->Append(
        base::DictValue().Set("tab", base::DictValue()
                                         .Set("spaceId", "incognito:private")
                                         .Set("url", "private-closed-secret")));
    state.FindList(key)->Append(base::DictValue().Set(
        "window", base::DictValue()
                      .Set("incognito", true)
                      .Set("url", "private-legacy-secret")));
  }
  auto projected = ProjectRuntimeState(state, "normal");
  ASSERT_TRUE(projected);
  EXPECT_EQ(base::WriteJson(*projected)->find("private-"), std::string::npos);
  EXPECT_EQ(projected->FindList("closedWindows")->size(), 1u);
}
TEST(RuntimeStateTest, RejectsMissingOrUnknownSlicesAndContradictoryPrivacy) {
  auto state = State();
  AddWindow(state, "normal", false);
  EXPECT_TRUE(IsRuntimeState(state));
  state.Set("futurePrivateSlice", base::DictValue());
  EXPECT_FALSE(IsRuntimeState(state));
  state.Remove("futurePrivateSlice");
  state.Remove("privateSiteMutes");
  EXPECT_FALSE(ProjectRuntimeState(state, "normal"));
  state.Set("privateSiteMutes", base::DictValue());
  state.FindDict("tabs")
      ->FindDict("normal-tab")
      ->Set("spaceId", "incognito:secret");
  EXPECT_FALSE(IsRuntimeState(state));
}
TEST(RuntimeStateTest, AuthorizesOnlyCommandsOwnedByActualWindow) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private", true);
  for (const auto* method : {"activate", "closeTab", "navigate"}) {
    auto command =
        base::DictValue().Set("method", method).Set("tabId", "normal-tab");
    if (std::string_view(method) == "navigate")
      command.Set("url", "https://example.com/");
    EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
    command.Set("tabId", "private-tab");
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  }
  for (const auto* method : {"newTab", "closeWindow"}) {
    EXPECT_TRUE(CanDispatchRuntimeCommand(
        state, "normal",
        base::DictValue().Set("method", method).Set("windowId", "normal")));
    EXPECT_FALSE(CanDispatchRuntimeCommand(
        state, "normal",
        base::DictValue().Set("method", method).Set("windowId", "private")));
  }
  EXPECT_TRUE(CanDispatchRuntimeCommand(
      state, "normal", base::DictValue().Set("method", "createWindow")));
  EXPECT_FALSE(CanDispatchRuntimeCommand(
      state, "unregistered",
      base::DictValue().Set("method", "newTab").Set("windowId", "normal")));
}
TEST(RuntimeStateTest, ValidatesOrderedCommitEpochAndCompleteState) {
  auto commit = base::DictValue()
                    .Set("epoch", "epoch")
                    .Set("revision", 0)
                    .Set("state", State());
  EXPECT_TRUE(IsRuntimeCommit(commit, "epoch", 0));
  EXPECT_FALSE(IsRuntimeCommit(commit, "other-epoch", 0));
  EXPECT_FALSE(IsRuntimeCommit(commit, "epoch", 1));
  commit.Set("revision", 0.5);
  EXPECT_FALSE(IsRuntimeCommit(commit, "epoch", 0.5));
  commit.Set("revision", 9007199254740992.0);
  EXPECT_FALSE(IsRuntimeCommit(commit, "epoch", 9007199254740992.0));
  commit.Set("revision", 0);
  commit.FindDict("state")->Remove("privateSiteMutes");
  EXPECT_FALSE(IsRuntimeCommit(commit, "epoch", 0));
}
TEST(RuntimeStateTest, RejectsStaleReplayedOrMalformedCommandRequests) {
  auto request =
      base::DictValue()
          .Set("epoch", "epoch")
          .Set("clientId", "renderer-claimed-id")
          .Set("requestId", 1)
          .Set("command",
               base::DictValue().Set("method", "closeTab").Set("tabId", "t"));
  EXPECT_EQ(ValidateRuntimeRequest(request, "epoch", 0),
            RuntimeRequestStatus::kAccepted);
  EXPECT_EQ(ValidateRuntimeRequest(request, "epoch", 1),
            RuntimeRequestStatus::kExpired);
  EXPECT_EQ(ValidateRuntimeRequest(request, "new-epoch", 0),
            RuntimeRequestStatus::kStaleEpoch);
  for (double id : {-1.0, 0.0, 0.5, 9007199254740992.0}) {
    request.Set("requestId", id);
    EXPECT_EQ(ValidateRuntimeRequest(request, "epoch", 0),
              RuntimeRequestStatus::kInvalid);
  }
  request.Set("requestId", 2);
  request.Set("windowId", "forged-window");
  EXPECT_EQ(ValidateRuntimeRequest(request, "epoch", 0),
            RuntimeRequestStatus::kInvalid);
}
TEST(RuntimeStateTest, CommandReplyCannotPrecedeItsCommitOrSpoofResultType) {
  auto reply = base::DictValue()
                   .Set("epoch", "epoch")
                   .Set("revision", 3)
                   .Set("value", base::Value());
  EXPECT_TRUE(IsRuntimeReply(reply, "epoch", 2, 3, RuntimeResultKind::kNone));
  EXPECT_FALSE(
      IsRuntimeReply(reply, "other-epoch", 2, 3, RuntimeResultKind::kNone));
  EXPECT_FALSE(IsRuntimeReply(reply, "epoch", 4, 5, RuntimeResultKind::kNone));
  EXPECT_FALSE(IsRuntimeReply(reply, "epoch", 2, 2, RuntimeResultKind::kNone));
  EXPECT_FALSE(
      IsRuntimeReply(reply, "epoch", 2, 3, RuntimeResultKind::kRequiredId));
  reply.Set("value", "created-tab-id");
  EXPECT_TRUE(
      IsRuntimeReply(reply, "epoch", 2, 3, RuntimeResultKind::kRequiredId));
  EXPECT_FALSE(IsRuntimeReply(reply, "epoch", 2, 3, RuntimeResultKind::kNone));
  // A newTab routed to app UI legitimately returns an empty id.
  reply.Set("value", "");
  EXPECT_TRUE(
      IsRuntimeReply(reply, "epoch", 2, 3, RuntimeResultKind::kRequiredId));
  auto error = base::DictValue()
                   .Set("epoch", "epoch")
                   .Set("error", base::DictValue()
                                     .Set("code", "failed")
                                     .Set("message", "failed command"));
  EXPECT_TRUE(IsRuntimeReply(error, "epoch", 2, 3, RuntimeResultKind::kNone));
  error.Set("revision", 3);
  EXPECT_FALSE(IsRuntimeReply(error, "epoch", 2, 3, RuntimeResultKind::kNone));
}
TEST(RuntimeStateTest, PrivateGroupsCannotClaimAnotherPrivateNamespace) {
  auto state = State();
  AddWindow(state, "private", true);
  ASSERT_TRUE(IsRuntimeState(state));
  state.FindDict("groups")
      ->FindDict("private-group")
      ->Set("spaceId", "incognito:someone-else");
  EXPECT_FALSE(IsRuntimeState(state));
}
TEST(RuntimeStateTest, PrivateWindowKeepsOwnBookmarkRootOnly) {
  auto state = State();
  AddWindow(state, "private", true);
  auto* bookmarks = state.FindDict("bookmarks");
  bookmarks->FindDict("roots")->Set("incognito:private",
                                    base::DictValue().Set("bar", "own-root"));
  bookmarks->FindDict("roots")->Set("incognito:other",
                                    base::DictValue().Set("bar", "other-root"));
  bookmarks->FindDict("nodes")->Set(
      "own-root", base::DictValue().Set("title", "own-bookmark"));
  bookmarks->FindDict("nodes")->Set(
      "other-root", base::DictValue().Set("title", "other-private-secret"));
  auto projected = ProjectRuntimeState(state, "private");
  ASSERT_TRUE(projected);
  EXPECT_TRUE(projected->FindDict("bookmarks")
                  ->FindDict("nodes")
                  ->contains("own-root"));
  EXPECT_EQ(base::WriteJson(*projected)->find("other-private-secret"),
            std::string::npos);
}
TEST(RuntimeStateTest, LocationCommandsUseOwnedSourceAndClosedFieldAllowlist) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  auto command = base::DictValue()
                     .Set("method", "openLocation")
                     .Set("sourceTabId", "normal-tab")
                     .Set("url", "https://example.com/")
                     .Set("disposition", "current");
  for (const auto* disposition : {"current", "newTab", "backgroundTab"}) {
    command.Set("disposition", disposition);
    EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  }
  command.Set("sourceTabId", "other-tab");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Set("sourceTabId", "normal-tab");
  command.Set("disposition", "newWindow");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Set("disposition", "current");
  command.Set("spaceId", "forged-profile");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Remove("spaceId");
  command.Set("url", "   ");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
}
TEST(RuntimeStateTest, SwitchingCannotCrossPrivateWindowBoundaries) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  AddWindow(state, "private", true);
  AddWindow(state, "private-other", true);
  auto command = base::DictValue()
                     .Set("method", "switchToExistingTab")
                     .Set("sourceTabId", "normal-tab")
                     .Set("targetTabId", "other-tab");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Set("targetTabId", "private-tab");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Set("sourceTabId", "private-tab");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "private", command));
  command.Set("targetTabId", "private-other-tab");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", command));
  command.Set("targetTabId", "normal-tab");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", command));
}
TEST(RuntimeStateTest, PanelAndNewTabIntentsValidateWindowAndGroupOwnership) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  for (const auto* method : {"requestNewTab", "submitNewTab",
                             "openCommandPanel", "dismissCommandPanel"}) {
    auto command =
        base::DictValue().Set("method", method).Set("windowId", "normal");
    if (std::string_view(method) == "submitNewTab")
      command.Set("url", "https://example.com/");
    EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
    command.Set("windowId", "other");
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  }
  auto request = base::DictValue()
                     .Set("method", "requestNewTab")
                     .Set("windowId", "normal")
                     .Set("groupId", "normal-group");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", request));
  request.Set("groupId", "other-group");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", request));
  request.Set("groupId", "normal-group");
  state.FindDict("groups")
      ->FindDict("normal-group")
      ->Set("spaceId", "other-profile");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", request));
  request.Remove("groupId");
  state.FindDict("windows")->FindDict("normal")->Set("kind", "small");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", request));
}
TEST(RuntimeStateTest, RejectsUnexpectedOptionsAndMalformedPanelText) {
  auto state = State();
  AddWindow(state, "normal", false);
  auto command = base::DictValue()
                     .Set("method", "newTab")
                     .Set("windowId", "normal")
                     .Set("options", base::DictValue().Set("background", true));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  command.FindDict("options")->Set("spaceId", "forged-profile");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  command = base::DictValue()
                .Set("method", "openCommandPanel")
                .Set("windowId", "normal")
                .Set("initialText", "");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Set("initialText", false);
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Set("initialText", std::string(1024 * 1024 + 1, 'a'));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Set("initialText", "");
  command.Set("sourceTabId", "normal-tab");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Set("sourceTabId", "missing-tab");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
}
TEST(RuntimeStateTest, DetachedPublicTabsRemainSharedAndCanBeSwitchedTo) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  state.FindDict("tabs")->FindDict("normal-tab")->Set("windowId", "");
  ASSERT_TRUE(IsRuntimeState(state));
  auto projected = ProjectRuntimeState(state, "other");
  ASSERT_TRUE(projected);
  EXPECT_TRUE(projected->FindDict("tabs")->contains("normal-tab"));
  EXPECT_TRUE(projected->FindDict("groups")->contains("normal-group"));
  EXPECT_EQ(*projected->FindDict("windows")
                 ->FindDict("normal")
                 ->FindDict("activeTabIds")
                 ->FindString("default"),
            "normal-tab");
  auto command = base::DictValue()
                     .Set("method", "switchToExistingTab")
                     .Set("sourceTabId", "other-tab")
                     .Set("targetTabId", "normal-tab");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "other", command));
  state.FindDict("tabLists")
      ->FindList("default")
      ->EraseValue(base::Value("normal-tab"));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "other", command));
}
TEST(RuntimeStateTest, UnlistedPeekIsProjectedButCannotForgeAStoredTabCommand) {
  auto state = State();
  AddWindow(state, "normal", false);
  auto peek = state.FindDict("tabs")->FindDict("normal-tab")->Clone();
  peek.Set("id", "peek");
  peek.Set("peekOf", "normal-tab");
  peek.Set("url", "peek-url");
  state.FindDict("tabs")->Set("peek", std::move(peek));
  state.FindDict("peeks")->Set(
      "normal",
      base::DictValue().Set("tabId", "peek").Set("fromId", "normal-tab"));
  ASSERT_TRUE(IsRuntimeState(state));
  auto projected = ProjectRuntimeState(state, "normal");
  ASSERT_TRUE(projected);
  EXPECT_TRUE(projected->FindDict("tabs")->contains("peek"));
  EXPECT_TRUE(projected->FindDict("peeks")->contains("normal"));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal",
                                         base::DictValue()
                                             .Set("method", "openLocation")
                                             .Set("sourceTabId", "peek")
                                             .Set("url", "https://example.com/")
                                             .Set("disposition", "current")));
}
TEST(RuntimeStateTest, NewSlicesDoNotLeakForeignPrivateStateOrUndoSnapshots) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private-one", true);
  AddWindow(state, "private-two", true);
  for (const auto* id : {"normal", "private-one", "private-two"}) {
    const auto space =
        *state.FindDict("windows")->FindDict(id)->FindString("spaceId");
    state.FindDict("pinnedFolders")
        ->Set(std::string(id) + "-folder",
              base::DictValue()
                  .Set("spaceId", space)
                  .Set("name", std::string(id) + "-secret"));
    state.FindDict("peeks")->Set(id,
                                 base::DictValue()
                                     .Set("tabId", std::string(id) + "-tab")
                                     .Set("fromId", std::string(id) + "-tab"));
    state.FindDict("closedPeeks")
        ->Set(id, base::DictValue()
                      .Set("url", std::string(id) + "-secret")
                      .Set("fromId", "stale-opener"));
    state.FindList("folderMoveUndo")
        ->Append(base::DictValue()
                     .Set("spaceId", space)
                     .Set("tabIds",
                          base::ListValue().Append(std::string(id) + "-tab")));
  }
  // A public move collected global IDs and snapshots before projection.
  auto& move = state.FindList("folderMoveUndo")->front().GetDict();
  move.Set(
      "folderIds",
      base::ListValue().Append("normal-folder").Append("private-two-folder"));
  move.Set("tabs", base::DictValue().Set(
                       "private-two-tab",
                       base::DictValue().Set("pinnedUrl", "hidden-url")));
  move.Set(
      "groups",
      base::ListValue().Append(base::DictValue().Set(
          "before",
          state.FindDict("groups")->FindDict("private-two-group")->Clone())));
  auto regular = ProjectRuntimeState(state, "normal");
  ASSERT_TRUE(regular);
  EXPECT_EQ(base::WriteJson(*regular)->find("private-"), std::string::npos);
  EXPECT_EQ(base::WriteJson(*regular)->find("hidden-url"), std::string::npos);
  EXPECT_EQ(regular->FindList("folderMoveUndo")->size(), 1u);
  EXPECT_TRUE(regular->FindDict("tabLists")->contains("default"));
  auto own = ProjectRuntimeState(state, "private-one");
  ASSERT_TRUE(own);
  EXPECT_EQ(base::WriteJson(*own)->find("private-two"), std::string::npos);
  EXPECT_TRUE(own->FindDict("tabLists")->contains("incognito:private-one"));
  EXPECT_TRUE(own->FindDict("closedPeeks")->contains("private-one"));
  EXPECT_TRUE(own->FindDict("pinnedFolders")->contains("private-one-folder"));
  EXPECT_EQ(own->FindList("folderMoveUndo")->size(), 2u);
  EXPECT_TRUE(IsRuntimeState(*own));
}
TEST(RuntimeStateTest, RejectsCrossPrivateListsGroupsAndSplits) {
  auto state = State();
  AddWindow(state, "private-one", true);
  AddWindow(state, "private-two", true);
  state.FindDict("tabLists")
      ->FindList("incognito:private-one")
      ->Append("private-two-tab");
  EXPECT_FALSE(IsRuntimeState(state));
  state.FindDict("tabLists")
      ->FindList("incognito:private-one")
      ->EraseValue(base::Value("private-two-tab"));
  state.FindDict("splits")
      ->FindDict("private-one-split")
      ->FindList("tabIds")
      ->Append("private-two-tab");
  EXPECT_FALSE(IsRuntimeState(state));
}
TEST(RuntimeStateTest, WindowLookPreviewsAreAcceptedAndPrivacyScoped) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private", true);
  state.FindDict("ui")->Set(
      "previewLooks",
      base::DictValue()
          .Set("normal", base::DictValue().Set("color", "public-preview"))
          .Set("private", base::DictValue().Set("color", "private-preview")));
  ASSERT_TRUE(IsRuntimeState(state));
  auto regular = ProjectRuntimeState(state, "normal");
  ASSERT_TRUE(regular);
  EXPECT_EQ(base::WriteJson(*regular)->find("private-preview"),
            std::string::npos);
  auto own = ProjectRuntimeState(state, "private");
  ASSERT_TRUE(own);
  EXPECT_TRUE(
      own->FindDict("ui")->FindDict("previewLooks")->contains("private"));
  state.FindDict("ui")->Set("unknownPrivateField", base::DictValue());
  EXPECT_FALSE(IsRuntimeState(state));
}
TEST(RuntimeStateTest, SharedBrokerAuthorizesHarborWindowCreation) {
  auto state = State();
  AddWindow(state, "harbor", false);
  state.FindDict("windows")->FindDict("harbor")->Set("kind", "small");
  state.FindDict("tabLists")
      ->Set("harbor", state.FindDict("tabLists")->FindList("default")->Clone());
  state.FindDict("tabLists")->Remove("default");
  EXPECT_TRUE(CanDispatchRuntimeCommand(
      state, "harbor",
      base::DictValue().Set("method", "newTab").Set("windowId", "harbor")));
  auto command = base::DictValue()
                     .Set("method", "openLocation")
                     .Set("sourceTabId", "harbor-tab")
                     .Set("url", "https://example.com/");
  for (const auto* disposition : {"newTab", "backgroundTab", "newWindow"}) {
    command.Set("disposition", disposition);
    EXPECT_TRUE(CanDispatchRuntimeCommand(state, "harbor", command));
  }
  command.Set("disposition", "current");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "harbor", command));
}

TEST(RuntimeStateTest, MigratedTabListsValidateEverySourceBeforeDispatch) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  AddLittleBay(state, "harbor");
  AddWindow(state, "private", true);
  ASSERT_TRUE(IsRuntimeState(state));
  for (const auto* method : {"closeTabs", "moveTabsToWindow"}) {
    auto command = base::DictValue()
                       .Set("method", method)
                       .Set("tabIds", base::ListValue().Append("normal-tab"));
    if (std::string_view(method) == "moveTabsToWindow")
      command.Set("windowId", "other");
    EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
    // The space's list is shared: another public window's tab can be named.
    command.FindList("tabIds")->Append("other-tab");
    EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
    command.FindList("tabIds")->Append("harbor-tab");
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
    command.Set("tabIds",
                base::ListValue().Append("normal-tab").Append("private-tab"));
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
    command.Set("tabIds",
                base::ListValue().Append("normal-tab").Append("normal-tab"));
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  }
}
TEST(RuntimeStateTest, MigratedWindowTargetsCannotCrossPrivateBoundaries) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  AddWindow(state, "private", true);
  AddWindow(state, "private-other", true);
  for (const auto* method : {"activate", "showTab", "moveTabsToWindow"}) {
    auto command =
        base::DictValue().Set("method", method).Set("windowId", "other");
    if (std::string_view(method) != "moveTabsToWindow")
      command.Set("tabId", "normal-tab");
    else
      command.Set("tabIds", base::ListValue().Append("normal-tab"));
    EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
    command.Set("windowId", "private");
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
    if (std::string_view(method) != "moveTabsToWindow")
      command.Set("tabId", "private-tab");
    else
      command.Set("tabIds", base::ListValue().Append("private-tab"));
    EXPECT_TRUE(CanDispatchRuntimeCommand(state, "private", command));
    command.Set("windowId", "private-other");
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", command));
    command.Set("windowId", "normal");
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", command));
  }
  auto move = base::DictValue()
                  .Set("method", "moveTabsToWindow")
                  .Set("tabIds", base::ListValue().Append("private-tab"))
                  .Set("windowId", base::Value());
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", move));
  move.Set("method", "moveTabToSpace");
  move.Remove("tabIds");
  move.Remove("windowId");
  move.Set("tabId", "private-tab");
  move.Set("spaceId", "default");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", move));
}
TEST(RuntimeStateTest, WindowCreationCannotImportPrivateOrLittleBayTabs) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  AddLittleBay(state, "harbor");
  AddWindow(state, "private", true);
  ASSERT_TRUE(IsRuntimeState(state));
  auto command =
      base::DictValue()
          .Set("method", "createWindow")
          .Set("options",
               base::DictValue().Set("tabIds",
                                     base::ListValue().Append("normal-tab")));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Set("openPanel", true);
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Set("openPanel", "true");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Remove("openPanel");
  command.FindDict("options")->FindList("tabIds")->Append("other-tab");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  command.FindDict("options")->FindList("tabIds")->Append("harbor-tab");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  command.FindDict("options")->Set("tabIds",
                                   base::ListValue().Append("private-tab"));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", command));
  command.Set("options", base::DictValue().Set("incognito", true));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "private", command));
  command.FindDict("options")->Set("adoptId", "native-page-id");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
}
TEST(RuntimeStateTest, GlobalSettingsRejectPrivateCallersAndNativeOwnedFields) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private", true);
  auto command = base::DictValue()
                     .Set("method", "updateSettings")
                     .Set("patch", base::DictValue().Set("appearance", "dark"));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", command));
  for (const auto* field :
       {"customSearchEngines", "extensionSearchEngines", "unknown"}) {
    command.Set("patch", base::DictValue().Set(field, base::ListValue()));
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  }
  for (const auto* method : {"setSearchEngine", "removeCustomEngine"}) {
    command = base::DictValue().Set("method", method).Set("id", "google");
    EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", command));
  }
  for (const auto* method : {"addCustomEngine", "updateCustomEngine"}) {
    command = base::DictValue()
                  .Set("method", method)
                  .Set("input", base::DictValue()
                                    .Set("name", "Example")
                                    .Set("keyword", "ex")
                                    .Set("url", "https://example.com/?q=%s"));
    if (std::string_view(method) == "updateCustomEngine")
      command.Set("id", "custom:example");
    EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", command));
    command.FindDict("input")->Set("extensionId", "forged");
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  }
}
TEST(RuntimeStateTest, SpaceCommandsNamePublicSpacesFromRegularWindowsOnly) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private", true);
  AddWindow(state, "harbor", false);
  state.FindDict("windows")->FindDict("harbor")->Set("kind", "small");
  const auto allowed = [&](const char* window, base::DictValue command) {
    return CanDispatchRuntimeCommand(state, window, command);
  };
  auto create = base::DictValue()
                    .Set("method", "createSpace")
                    .Set("options", base::DictValue()
                                        .Set("name", "Work")
                                        .Set("color", "blue")
                                        .Set("shareWith", "default"));
  EXPECT_TRUE(allowed("normal", create.Clone()));
  EXPECT_TRUE(allowed("harbor", create.Clone()));
  EXPECT_FALSE(allowed("private", create.Clone()));
  EXPECT_EQ(RuntimeCommandResultKind(create), RuntimeResultKind::kRequiredId);
  for (const char* shared : {"incognito:private", "missing"}) {
    create.FindDict("options")->Set("shareWith", shared);
    EXPECT_FALSE(allowed("normal", create.Clone()));
  }
  create.FindDict("options")->Set("shareWith", base::Value());
  EXPECT_TRUE(allowed("normal", create.Clone()));
  create.FindDict("options")->Set("profileId", "default");
  EXPECT_FALSE(allowed("normal", create.Clone()));

  auto update = base::DictValue()
                    .Set("method", "updateSpace")
                    .Set("spaceId", "default")
                    .Set("patch", base::DictValue()
                                      .Set("name", "Home")
                                      .Set("cleanUpAfterHours", "app"));
  EXPECT_TRUE(allowed("normal", update.Clone()));
  EXPECT_FALSE(allowed("private", update.Clone()));
  update.FindDict("patch")->Set("profileId", "other");
  EXPECT_FALSE(allowed("normal", update.Clone()));
  update.FindDict("patch")->Remove("profileId");
  update.Set("spaceId", "incognito:private");
  EXPECT_FALSE(allowed("normal", update.Clone()));

  for (const char* method : {"deleteSpace", "setDefaultSpace"}) {
    auto command =
        base::DictValue().Set("method", method).Set("spaceId", "default");
    EXPECT_TRUE(allowed("normal", command.Clone()));
    EXPECT_FALSE(allowed("private", command.Clone()));
    command.Set("spaceId", "incognito:private");
    EXPECT_FALSE(allowed("normal", command.Clone()));
  }
  auto order =
      base::DictValue()
          .Set("method", "reorderSpaces")
          .Set("spaceIds", base::ListValue().Append("default"));
  EXPECT_TRUE(allowed("normal", order.Clone()));
  EXPECT_FALSE(allowed("private", order.Clone()));
  for (const char* id : {"default", "incognito:private", "missing"}) {
    order.Set("spaceIds", base::ListValue().Append("default").Append(id));
    EXPECT_FALSE(allowed("normal", order.Clone()));
  }
}
void AddBookmarkTree(base::DictValue& state,
                     const char* space,
                     const std::string& page) {
  const std::string bar = std::string("bar@") + space;
  const std::string other = std::string("other@") + space;
  auto* nodes = state.FindDict("bookmarks")->FindDict("nodes");
  state.FindDict("bookmarks")
      ->FindDict("roots")
      ->Set(space, base::DictValue().Set("bar", bar).Set("other", other));
  nodes->Set(bar, base::DictValue()
                      .Set("id", bar)
                      .Set("parentId", base::Value())
                      .Set("children", base::ListValue().Append(page)));
  nodes->Set(other, base::DictValue()
                        .Set("id", other)
                        .Set("parentId", base::Value())
                        .Set("children", base::ListValue()));
  nodes->Set(page, base::DictValue()
                       .Set("id", page)
                       .Set("parentId", bar)
                       .Set("url", "https://" + page));
}
TEST(RuntimeStateTest, BookmarkCommandsStayInOneRegularSpaceTree) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private", true);
  state.FindDict("spaces")->Set("work", base::DictValue().Set("id", "work"));
  AddBookmarkTree(state, "default", "page");
  AddBookmarkTree(state, "work", "work-page");
  AddBookmarkTree(state, "incognito:private", "secret");
  const auto allowed = [&](const char* window, const base::DictValue& c) {
    return CanDispatchRuntimeCommand(state, window, c);
  };
  auto add = base::DictValue()
                 .Set("method", "addBookmark")
                 .Set("options", base::DictValue()
                                     .Set("spaceId", "default")
                                     .Set("url", "https://a.example/")
                                     .Set("title", "A")
                                     .Set("parentId", "other@default"));
  EXPECT_TRUE(allowed("normal", add));
  EXPECT_TRUE(allowed("private", add)) << "a private window bookmarks too";
  EXPECT_EQ(RuntimeCommandResultKind(add), RuntimeResultKind::kRequiredId);
  for (const char* parent : {"bar@work", "bar@incognito:private", "page"}) {
    add.FindDict("options")->Set("parentId", parent);
    EXPECT_FALSE(allowed("normal", add)) << parent;
  }
  add.FindDict("options")->Remove("parentId");
  add.FindDict("options")->Set("spaceId", "incognito:private");
  EXPECT_FALSE(allowed("private", add));
  add.FindDict("options")->Set("spaceId", "default");
  add.FindDict("options")->Set("syncKey", "x");
  EXPECT_FALSE(allowed("normal", add));

  auto update = base::DictValue()
                    .Set("method", "updateBookmark")
                    .Set("bookmarkId", "page")
                    .Set("patch", base::DictValue().Set("title", "B"));
  EXPECT_TRUE(allowed("normal", update));
  for (const char* id : {"bar@default", "secret", "missing"}) {
    update.Set("bookmarkId", id);
    EXPECT_FALSE(allowed("normal", update)) << id;
  }
  auto move = base::DictValue()
                  .Set("method", "moveBookmark")
                  .Set("bookmarkId", "page")
                  .Set("parentId", "other@default")
                  .Set("index", 0);
  EXPECT_TRUE(allowed("normal", move));
  move.Set("parentId", "bar@work");
  EXPECT_FALSE(allowed("normal", move)) << "a move stays in one profile";
  move.Set("bookmarkId", "other@default");
  move.Set("parentId", "bar@default");
  EXPECT_FALSE(allowed("normal", move));
  for (const char* id : {"page", "secret"}) {
    auto remove = base::DictValue()
                      .Set("method", "removeBookmark")
                      .Set("bookmarkId", id);
    EXPECT_EQ(allowed("normal", remove), std::string_view(id) == "page");
  }

  auto toggle =
      base::DictValue()
          .Set("method", "toggleBookmark")
          .Set("spaceId", "default")
          .Set("page", base::DictValue().Set("url", "u").Set("title", "t"));
  EXPECT_TRUE(allowed("private", toggle));
  toggle.FindDict("page")->Set("pinned", true);
  EXPECT_FALSE(allowed("normal", toggle));

  auto removing =
      base::DictValue()
          .Set("method", "removeBookmarks")
          .Set("spaceId", "default")
          .Set("bookmarkIds", base::ListValue().Append("page"));
  EXPECT_TRUE(allowed("normal", removing));
  EXPECT_EQ(RuntimeCommandResultKind(removing),
            RuntimeResultKind::kOptionalId);
  removing.Set("bookmarkIds",
               base::ListValue().Append("page").Append("work-page"));
  EXPECT_FALSE(allowed("normal", removing));
  removing.Set("bookmarkIds", base::ListValue().Append("page").Append("page"));
  EXPECT_FALSE(allowed("normal", removing));

  state.FindList("bookmarkUndo")
      ->Append(base::DictValue().Set("id", "undo").Set("spaceId", "default"));
  auto restore = base::DictValue()
                     .Set("method", "restoreBookmarks")
                     .Set("undoId", "undo");
  EXPECT_TRUE(allowed("normal", restore));
  restore.Set("undoId", "missing");
  EXPECT_FALSE(allowed("normal", restore));

  auto tree = base::DictValue()
                  .Set("method", "addBookmarkTree")
                  .Set("spaceId", "default")
                  .Set("parentId", "bar@default")
                  .Set("drafts",
                       base::ListValue().Append(
                           base::DictValue()
                               .Set("title", "Tabs")
                               .Set("children", base::ListValue().Append(
                                                    base::DictValue()
                                                        .Set("title", "A")
                                                        .Set("url", "u")))));
  EXPECT_TRUE(allowed("normal", tree));
  auto deep = base::ListValue().Append(
      base::DictValue().Set("title", "leaf").Set("url", "u"));
  for (int i = 0; i < 20; ++i)
    deep = base::ListValue().Append(
        base::DictValue().Set("title", "f").Set("children", std::move(deep)));
  tree.Set("drafts", std::move(deep));
  EXPECT_FALSE(allowed("normal", tree));
  tree.Set("drafts", base::ListValue().Append(
                         base::DictValue()
                             .Set("title", "both")
                             .Set("url", "u")
                             .Set("children", base::ListValue())));
  EXPECT_FALSE(allowed("normal", tree));
}
TEST(RuntimeStateTest, HistoryEditsAndBookmarkUndoStayRegular) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private", true);
  auto remove = base::DictValue()
                    .Set("method", "removeHistory")
                    .Set("spaceId", "default")
                    .Set("urls", base::ListValue().Append("https://a/"));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", remove));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", remove));
  remove.Set("urls", base::ListValue());
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", remove));
  auto clear = base::DictValue()
                   .Set("method", "clearHistory")
                   .Set("spaceId", "default")
                   .Set("since", 1700000000000.0);
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", clear));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", clear));
  clear.Set("spaceId", "incognito:private");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", clear));

  auto* undo = state.FindList("bookmarkUndo");
  undo->Append(base::DictValue().Set("id", "public").Set("spaceId", "default"));
  undo->Append(base::DictValue()
                   .Set("id", "forged")
                   .Set("spaceId", "incognito:private"));
  auto projected = ProjectRuntimeState(state, "normal");
  ASSERT_TRUE(projected);
  ASSERT_EQ(projected->FindList("bookmarkUndo")->size(), 1u);
  EXPECT_EQ(*(*projected->FindList("bookmarkUndo"))[0].GetDict().FindString(
                "id"),
            "public");
}
TEST(RuntimeStateTest, WindowUiCommandsStayWithTheirWindowTabsAndDownloads) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  AddWindow(state, "private", true);
  auto* downloads = state.FindList("downloads");
  downloads->clear();
  downloads->Append(
      base::DictValue().Set("id", "public").Set("profile", "default"));
  downloads->Append(base::DictValue()
                        .Set("id", "secret")
                        .Set("profile", "incognito:private"));
  const auto allowed = [&](const char* window, const base::DictValue& c) {
    return CanDispatchRuntimeCommand(state, window, c);
  };
  auto open = base::DictValue()
                  .Set("method", "setDownloadsOpen")
                  .Set("windowId", "normal")
                  .Set("open", true);
  EXPECT_TRUE(allowed("normal", open));
  EXPECT_FALSE(allowed("other", open));
  open.Set("open", "yes");
  EXPECT_FALSE(allowed("normal", open));
  auto clear = base::DictValue()
                   .Set("method", "clearDownloads")
                   .Set("windowId", "private");
  EXPECT_TRUE(allowed("private", clear));
  EXPECT_FALSE(allowed("normal", clear));

  auto remove = base::DictValue()
                    .Set("method", "removeDownload")
                    .Set("windowId", "normal")
                    .Set("downloadId", "public");
  EXPECT_TRUE(allowed("normal", remove));
  remove.Set("downloadId", "secret");
  EXPECT_FALSE(allowed("normal", remove));
  remove.Set("windowId", "private");
  EXPECT_TRUE(allowed("private", remove));
  remove.Set("downloadId", "public");
  EXPECT_FALSE(allowed("private", remove));

  auto find = base::DictValue()
                  .Set("method", "setFind")
                  .Set("tabId", "normal-tab")
                  .Set("patch", base::DictValue()
                                    .Set("open", true)
                                    .Set("query", "needle"));
  EXPECT_TRUE(allowed("normal", find));
  EXPECT_FALSE(allowed("other", find));
  find.FindDict("patch")->Set("sessionId", "forged");
  EXPECT_FALSE(allowed("normal", find));

  auto details =
      base::DictValue()
          .Set("method", "updateTabDetails")
          .Set("tabId", "normal-tab")
          .Set("patch", base::DictValue().Set("customTitle", "Mine"));
  EXPECT_TRUE(allowed("normal", details));
  EXPECT_TRUE(allowed("other", details)) << "a shared public row";
  EXPECT_FALSE(allowed("private", details));
  details.Set("tabId", "private-tab");
  EXPECT_FALSE(allowed("normal", details));
  EXPECT_TRUE(allowed("private", details));
  details.FindDict("patch")->Set("url", "https://forged/");
  EXPECT_FALSE(allowed("private", details));
}
TEST(RuntimeStateTest, DownloadRenamesStayInTheirFolderAndWindowList) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private", true);
  auto* downloads = state.FindList("downloads");
  downloads->clear();
  const auto add = [&](const char* id, const char* profile, const char* done,
                       const char* path) {
    downloads->Append(base::DictValue()
                          .Set("id", id)
                          .Set("profile", profile)
                          .Set("state", done)
                          .Set("path", path));
  };
  add("public", "default", "finished", "/Users/me/Downloads/file.pdf");
  add("windows", "default", "finished", "C:\\Users\\me\\Downloads\\file.pdf");
  add("busy", "default", "downloading", "/Users/me/Downloads/busy.pdf");
  add("secret", "incognito:private", "finished", "/Users/me/Downloads/s.pdf");
  const auto rename = [](const char* id, const char* filename,
                         const char* path) {
    return base::DictValue()
        .Set("method", "updateDownloadFile")
        .Set("id", id)
        .Set("patch",
             base::DictValue().Set("filename", filename).Set("path", path));
  };
  const auto allowed = [&](const char* window, const base::DictValue& c) {
    return CanDispatchRuntimeCommand(state, window, c);
  };
  EXPECT_EQ(RuntimeCommandResultKind(rename("public", "a", "/a")),
            RuntimeResultKind::kNone);
  EXPECT_TRUE(
      allowed("normal", rename("public", "R.pdf", "/Users/me/Downloads/R.pdf")));
  EXPECT_TRUE(allowed("normal", rename("windows", "R.pdf",
                                       "C:\\Users\\me\\Downloads\\R.pdf")));
  EXPECT_FALSE(
      allowed("normal", rename("public", "R.pdf", "/Users/me/Desktop/R.pdf")));
  EXPECT_FALSE(
      allowed("normal", rename("public", "R.pdf", "/Users/me/Downloads/X.pdf")));
  EXPECT_FALSE(allowed("normal", rename("public", "..", "/Users/me/Downloads/..")));
  EXPECT_FALSE(allowed("normal", rename("public", "R.pdf", "R.pdf")))
      << "a path shorter than the download's folder";
  EXPECT_FALSE(
      allowed("normal", rename("busy", "R.pdf", "/Users/me/Downloads/R.pdf")));
  EXPECT_FALSE(allowed("normal", rename("missing", "R.pdf", "/R.pdf")));
  EXPECT_FALSE(
      allowed("normal", rename("secret", "R.pdf", "/Users/me/Downloads/R.pdf")));
  EXPECT_TRUE(
      allowed("private", rename("secret", "R.pdf", "/Users/me/Downloads/R.pdf")));
  EXPECT_FALSE(allowed("private",
                       rename("public", "R.pdf", "/Users/me/Downloads/R.pdf")));
  EXPECT_FALSE(CanDispatchRuntimeCommand(
      state, "", rename("public", "R.pdf", "/Users/me/Downloads/R.pdf"),
      /*utility=*/true));
  auto extra = rename("public", "R.pdf", "/Users/me/Downloads/R.pdf");
  extra.FindDict("patch")->Set("url", "https://forged/");
  EXPECT_FALSE(allowed("normal", extra));
}
TEST(RuntimeStateTest, SharedCollectionsLandInPublicMainWindows) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private", true);
  AddLittleBay(state, "harbor");
  const auto add = [](const char* window) {
    return base::DictValue()
        .Set("method", "addSharedCollection")
        .Set("windowId", window)
        .Set("token", "N4Ig+abc-123");
  };
  EXPECT_EQ(RuntimeCommandResultKind(add("normal")),
            RuntimeResultKind::kRequiredId);
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", add("normal")));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "harbor", add("normal")))
      << "Little Bay hands a shared link to its main window";
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "", add("normal"),
                                        /*utility=*/true));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", add("normal")));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", add("private")));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", add("harbor")));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", add("missing")));
  auto spaced = add("normal");
  spaced.Set("spaceId", "default");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", spaced));
  spaced.Set("spaceId", "incognito:private");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", spaced));
  for (const char* token : {"", "has space", "slash/", "{\"kind\":1}"}) {
    auto bad = add("normal");
    bad.Set("token", token);
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", bad)) << token;
  }
  auto huge = add("normal");
  huge.Set("token", std::string(16001, 'A'));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", huge));
  auto object = add("normal");
  object.Set("collection", base::DictValue());
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", object));
}
TEST(RuntimeStateTest, OptionalResultsAcceptNoIdWithoutWeakeningRequiredIds) {
  auto reply = base::DictValue()
                   .Set("epoch", "epoch")
                   .Set("revision", 1)
                   .Set("value", base::Value());
  EXPECT_TRUE(
      IsRuntimeReply(reply, "epoch", 0, 1, RuntimeResultKind::kOptionalId));
  EXPECT_FALSE(
      IsRuntimeReply(reply, "epoch", 0, 1, RuntimeResultKind::kRequiredId));
  reply.Set("value", "created-id");
  EXPECT_TRUE(
      IsRuntimeReply(reply, "epoch", 0, 1, RuntimeResultKind::kOptionalId));
  EXPECT_FALSE(IsRuntimeReply(reply, "epoch", 0, 1, RuntimeResultKind::kNone));
  reply.Set("value", 1);
  EXPECT_FALSE(
      IsRuntimeReply(reply, "epoch", 0, 1, RuntimeResultKind::kOptionalId));
  for (const auto* method : {"newTab", "createWindow", "addCustomEngine"})
    EXPECT_EQ(RuntimeCommandResultKind(base::DictValue().Set("method", method)),
              RuntimeResultKind::kRequiredId);
  for (const auto* method : {"duplicateTab", "moveTabsToWindow"})
    EXPECT_EQ(RuntimeCommandResultKind(base::DictValue().Set("method", method)),
              RuntimeResultKind::kOptionalId);
  EXPECT_EQ(RuntimeCommandResultKind(
                base::DictValue().Set("method", "updateSettings")),
            RuntimeResultKind::kNone);
}

TEST(RuntimeStateTest,
     RestoresRequireOwnedTargetAndSelectOnlyVisibleSnapshots) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private", true);
  AddWindow(state, "other-private", true);
  for (const auto* id : {"normal", "private", "other-private"}) {
    state.FindList("closedTabs")
        ->Append(base::DictValue()
                     .Set("id", std::string(id) + "-closed")
                     .Set("windowId", id)
                     .Set("tab", base::DictValue().Set(
                                     "spaceId",
                                     id == std::string_view("normal")
                                         ? "default"
                                         : std::string("incognito:") + id)));
  }
  for (const auto* method : {"reopenClosed", "reopenClosedTab"}) {
    auto command =
        base::DictValue().Set("method", method).Set("windowId", "normal");
    EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
    command.Set("windowId", "private");
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
    EXPECT_TRUE(CanDispatchRuntimeCommand(state, "private", command));
    command.Remove("windowId");
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
    command.Set("windowId", base::Value());
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  }
  auto command = base::DictValue()
                     .Set("method", "restoreClosed")
                     .Set("windowId", "normal")
                     .Set("entryId", "normal-closed");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Set("entryId", "private-closed");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Set("windowId", "private");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "private", command));
  command.Set("entryId", "other-private-closed");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", command));
  command.Set("entryId", "normal-closed");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", command));
}
TEST(RuntimeStateTest,
     FocusAndLayoutIntentsRejectForeignTargetsAndPrivateSettings) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private", true);
  auto command =
      base::DictValue().Set("method", "focusWindow").Set("windowId", "normal");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", command));
  command.Set("windowId", "private");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "private", command));
  command =
      base::DictValue().Set("method", "setTabLayout").Set("layout", "top");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", command));
  command.Set("layout", "unknown");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
}

TEST(RuntimeStateTest, ShowTabAcceptsPublicSharedAndRetainedTargetsOnly) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  AddWindow(state, "private", true);
  auto command =
      base::DictValue().Set("method", "showTab").Set("tabId", "other-tab");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  state.FindDict("tabs")->FindDict("other-tab")->Set("windowId", "");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Set("windowId", "normal");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Set("windowId", "private");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Remove("windowId");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", command));
  command.Set("tabId", "private-tab");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "private", command));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  command =
      base::DictValue().Set("method", "focusWindow").Set("windowId", "other");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", command));
  command.Set("windowId", "private");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
}

TEST(RuntimeStateTest, OpenInMainWindowRequiresOwnedRegularSmallWindow) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "small", false);
  AddWindow(state, "other-small", false);
  AddWindow(state, "private", true);
  for (const auto* id : {"small", "other-small", "private"})
    state.FindDict("windows")->FindDict(id)->Set("kind", "small");
  auto command = base::DictValue()
                     .Set("method", "openInMainWindow")
                     .Set("windowId", "small");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "small", command));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "other-small", command));
  command.Set("windowId", "normal");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
  command.Set("windowId", "private");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", command));
  command.Set("windowId", "small");
  command.Set("targetWindowId", "normal");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "small", command));
  EXPECT_EQ(RuntimeCommandResultKind(command), RuntimeResultKind::kNone);
}
TEST(RuntimeStateTest,
     OrganizeCommandsShareSpaceTabsButNotPrivateOrHarborTabs) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  AddWindow(state, "private", true);
  AddWindow(state, "private-other", true);
  state.FindDict("tabs")->Set("detached-tab", base::DictValue()
                                                  .Set("id", "detached-tab")
                                                  .Set("windowId", "")
                                                  .Set("spaceId", "default"));
  state.FindDict("tabLists")->FindList("default")->Append("detached-tab");
  const auto group = [](std::initializer_list<const char*> ids) {
    base::ListValue list;
    for (const auto* id : ids) {
      list.Append(id);
    }
    return base::DictValue()
        .Set("method", "createGroup")
        .Set("tabIds", std::move(list));
  };
  EXPECT_TRUE(CanDispatchRuntimeCommand(
      state, "normal", group({"normal-tab", "other-tab", "detached-tab"})));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal",
                                         group({"normal-tab", "private-tab"})));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", group({})));
  EXPECT_TRUE(
      CanDispatchRuntimeCommand(state, "private", group({"private-tab"})));
  EXPECT_FALSE(
      CanDispatchRuntimeCommand(state, "private", group({"normal-tab"})));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private",
                                         group({"private-other-tab"})));
  auto styled = group({"normal-tab"});
  styled.Set("options", base::DictValue()
                            .Set("name", "")
                            .Set("icon", base::Value())
                            .Set("color", "blue"));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", styled));
  styled.FindDict("options")->Set("color", "magenta");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", styled));
  styled.FindDict("options")->Set("color", "blue");
  styled.FindDict("options")->Set("tabIds", base::ListValue());
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", styled));

  AddWindow(state, "harbor", false);
  state.FindDict("windows")->FindDict("harbor")->Set("kind", "small");
  state.FindDict("tabLists")
      ->FindList("default")
      ->EraseValue(base::Value("harbor-tab"));
  state.FindDict("tabLists")
      ->Set("harbor", base::ListValue().Append("harbor-tab"));
  EXPECT_FALSE(
      CanDispatchRuntimeCommand(state, "normal", group({"harbor-tab"})));
  EXPECT_FALSE(
      CanDispatchRuntimeCommand(state, "harbor", group({"normal-tab"})));
  auto mute = base::DictValue()
                  .Set("method", "setMuted")
                  .Set("tabIds", base::ListValue().Append("harbor-tab"))
                  .Set("muted", true);
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "harbor", mute));
  auto ungroup =
      base::DictValue().Set("method", "ungroup").Set("groupId", "normal-group");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "other", ungroup));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "harbor", ungroup));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", ungroup));
  ungroup.Set("groupId", "private-group");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "private", ungroup));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private-other", ungroup));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", ungroup));
  for (const auto* method : {"cleanUpInactiveTabs", "closeAbandonedNewTabs"}) {
    EXPECT_FALSE(CanDispatchRuntimeCommand(
        state, "normal", base::DictValue().Set("method", method)));
  }
}
TEST(RuntimeStateTest, PlacementAndFolderReferencesStayInVisibleSpaces) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private", true);
  state.FindDict("pinnedFolders")
      ->Set("folder",
            base::DictValue().Set("id", "folder").Set("spaceId", "default"));
  auto place = base::DictValue()
                   .Set("method", "placeTabs")
                   .Set("tabIds", base::ListValue().Append("normal-tab"))
                   .Set("placement", base::DictValue()
                                         .Set("pinned", false)
                                         .Set("row", true)
                                         .Set("folderId", "folder")
                                         .Set("beforeId", base::Value()));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", place));
  place.FindDict("placement")->Set("groupId", "private-group");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", place));
  place.FindDict("placement")->Set("groupId", "normal-group");
  place.FindDict("placement")->Set("beforeId", "private-tab");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", place));
  place.FindDict("placement")->Remove("beforeId");
  place.FindDict("placement")->Remove("pinned");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", place));
  place.Set("tabIds", base::ListValue().Append("private-tab"));
  place.FindDict("placement")->Set("pinned", false);
  place.FindDict("placement")->Remove("groupId");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", place));
  place.FindDict("placement")->Remove("folderId");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "private", place));

  auto folder = base::DictValue()
                    .Set("method", "newPinnedFolder")
                    .Set("windowId", "normal")
                    .Set("options", base::DictValue()
                                        .Set("tabIds", base::ListValue())
                                        .Set("parentId", "folder")
                                        .Set("beforeId", "normal-tab"));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", folder));
  folder.FindDict("options")->Set("spaceId", "incognito:private");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", folder));
  folder.FindDict("options")->Remove("spaceId");
  folder.Set("windowId", "private");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", folder));
  auto move = base::DictValue()
                  .Set("method", "movePinnedFolder")
                  .Set("folderId", "folder")
                  .Set("beforeId", base::Value())
                  .Set("parentId", base::Value());
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", move));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", move));
  move.Set("beforeId", "private-tab");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", move));
  move.Remove("beforeId");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", move));
  EXPECT_FALSE(CanDispatchRuntimeCommand(
      state, "private",
      base::DictValue().Set("method", "undoPinnedFolderMove")));

  state.FindList("cleanedTabs")
      ->Append(base::DictValue()
                   .Set("id", "public-entry")
                   .Set("tab", base::DictValue().Set("spaceId", "default")));
  state.FindDict("privateCleanedTabs")
      ->FindList("private")
      ->Append(base::DictValue().Set("id", "private-entry"));
  auto restore = base::DictValue()
                     .Set("method", "restoreCleaned")
                     .Set("windowId", "normal")
                     .Set("entryId", "public-entry");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", restore));
  restore.Set("entryId", "private-entry");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", restore));
  restore.Set("windowId", "private");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "private", restore));
  restore.Set("entryId", "public-entry");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", restore));
  auto clean = base::DictValue()
                   .Set("method", "cleanUpTabs")
                   .Set("windowId", "private")
                   .Set("options", base::DictValue()
                                       .Set("inactiveForMs", 0)
                                       .Set("spaceId", "incognito:private"));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "private", clean));
  clean.FindDict("options")->Set("spaceId", "default");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", clean));
  clean.FindDict("options")->Set("inactiveForMs", -1);
  clean.Set("windowId", "normal");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", clean));
}
TEST(RuntimeStateTest, SplitAndPeekCommandsValidateTargetsAndResults) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  AddWindow(state, "private", true);
  auto split =
      base::DictValue()
          .Set("method", "createSplit")
          .Set("tabIds",
               base::ListValue().Append("normal-tab").Append("other-tab"))
          .Set("orientation", "vertical");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", split));
  EXPECT_EQ(RuntimeCommandResultKind(split), RuntimeResultKind::kRequiredId);
  split.Set("tabIds", base::ListValue().Append("normal-tab"));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", split));
  split.Set("tabIds",
            base::ListValue().Append("normal-tab").Append("private-tab"));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", split));

  auto sizes =
      base::DictValue()
          .Set("method", "updateSplit")
          .Set("splitId", "normal-split")
          .Set("patch",
               base::DictValue().Set(
                   "sizes", base::ListValue().Append(0.5).Append(0.5)));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "other", sizes));
  sizes.FindDict("patch")->Set("sizes", base::ListValue().Append(0).Append(1));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "other", sizes));
  sizes.FindDict("patch")->Set("sizes",
                               base::ListValue().Append(0.5).Append(0.5));
  sizes.Set("splitId", "private-split");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", sizes));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "private", sizes));

  auto pane = base::DictValue()
                  .Set("method", "openSplitPane")
                  .Set("windowId", "normal")
                  .Set("options", base::DictValue()
                                      .Set("anchorTabId", "normal-tab")
                                      .Set("side", "left")
                                      .Set("url", "x.com"));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", pane));
  EXPECT_EQ(RuntimeCommandResultKind(pane), RuntimeResultKind::kOptionalId);
  pane.FindDict("options")->Set("adoptId", "chrome-tab");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", pane));
  pane.FindDict("options")->Remove("adoptId");
  pane.FindDict("options")->Set("tabId", "private-tab");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", pane));

  auto peek = base::DictValue()
                  .Set("method", "openPeek")
                  .Set("fromTabId", "normal-tab")
                  .Set("url", "https://example.org");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", peek));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "other", peek));
  peek.Set("adoptId", "chrome-tab");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", peek));
  for (const auto* method :
       {"closePeek", "keepPeek", "splitPeek", "reopenPeekOrClosed"}) {
    auto command =
        base::DictValue().Set("method", method).Set("windowId", "normal");
    EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command));
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "other", command));
  }
  auto layout = base::DictValue()
                    .Set("method", "toggleTabLayout")
                    .Set("windowId", "private");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", layout));
  auto focus = base::DictValue()
                   .Set("method", "focusPane")
                   .Set("windowId", "normal")
                   .Set("delta", 2);
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", focus));
  focus.Set("delta", -1);
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", focus));
}
TEST(RuntimeStateTest, SidebarTabCommandsReachSharedPublicTabsOnly) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  AddLittleBay(state, "harbor");
  AddWindow(state, "private", true);
  // A public tab no window has loaded since launch.
  state.FindDict("tabs")->Set("detached-tab", base::DictValue()
                                                  .Set("id", "detached-tab")
                                                  .Set("windowId", "")
                                                  .Set("spaceId", "default")
                                                  .Set("url", "https://a.example/"));
  state.FindDict("tabLists")->FindList("default")->Append("detached-tab");
  ASSERT_TRUE(IsRuntimeState(state));
  const auto command = [](const char* method, const char* tab) {
    auto c = base::DictValue().Set("method", method).Set("tabId", tab);
    const std::string_view m(method);
    if (m == "navigate") c.Set("url", "https://example.com/");
    if (m == "moveTab") c.Set("toIndex", 0);
    if (m == "moveTabToSpace") c.Set("spaceId", "default");
    if (m == "activate") c.Set("windowId", "normal");
    return c;
  };
  for (const auto* method : {"activate", "closeTab", "removeTab", "duplicateTab", "togglePin", "navigate", "moveTab",
                             "wakeTab", "moveTabToSpace"}) {
    for (const auto* tab : {"normal-tab", "other-tab", "detached-tab"})
      EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command(method, tab))) << method << " " << tab;
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command(method, "harbor-tab"))) << method;
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command(method, "private-tab"))) << method;
    // Private windows and Little Bay still name only their own tabs.
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", command(method, "normal-tab"))) << method;
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "harbor", command(method, "normal-tab"))) << method;
  }
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "harbor", command("closeTab", "harbor-tab")));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "private", command("closeTab", "private-tab")));
  // Commands about the page a window shows stay with the window showing it.
  for (const auto* method : {"syncInternalPage", "showNewTab", "hideNewTab"}) {
    EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", command(method, "normal-tab"))) << method;
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command(method, "other-tab"))) << method;
  }
  EXPECT_FALSE(CanDispatchRuntimeCommand(
      state, "normal",
      base::DictValue().Set("method", "setFind").Set("tabId", "other-tab").Set("patch", base::DictValue())));
  EXPECT_FALSE(CanDispatchRuntimeCommand(
      state, "normal",
      base::DictValue().Set("method", "openPeek").Set("fromTabId", "other-tab").Set("url", "https://b.example/")));
}
base::DictValue Json(const char* json) {
  auto value = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
  CHECK(value);
  return std::move(*value);
}
void AddServices(base::DictValue& state) {
  state.Set("services", Json(R"({
    "live":{
      "folders":{
        "public-folder":{"id":"public-folder","spaceId":"default","kind":"pullRequests","name":"Reviews",
          "icon":null,"collapsed":false,"sources":["github"],"filters":{"authored":true,"reviewRequests":true},"createdAt":1},
        "private-folder":{"id":"private-folder","spaceId":"incognito:private","kind":"documents","name":"private-secret",
          "icon":null,"collapsed":false,"sources":[],"filters":{"authored":false,"reviewRequests":false},"createdAt":1}},
      "folderOrder":["public-folder","private-folder"],
      "items":{"public-folder":[{"id":"i","source":"github","url":"https://example.com/pr","title":"PR","subtitle":"",
        "icon":null,"updatedAt":1,"pr":{"number":1,"repo":"r","author":"a","authorAvatar":null,"draft":false,
        "headRef":"h","baseRef":"b","review":null,"mergeable":"unknown","checks":[{"name":"c","state":"success","url":null}],
        "comments":0,"unresolvedThreads":0,"additions":0,"deletions":0,"changedFiles":0}}],
        "private-folder":[{"id":"p","source":"notion","url":"https://example.com/private-secret","title":"private-secret",
        "subtitle":"","icon":null,"updatedAt":1}]},
      "unread":{"public-folder":["i"],"private-folder":["p"]},
      "status":{"public-folder":{"state":"idle","lastFetch":null,"error":null}},
      "accounts":{"github":{"login":"me","name":null,"avatar":null,"connectedAt":1}},
      "meetingGroups":{
        "public-meeting":{"groupId":"normal-group","callTabId":"normal-tab","occurrence":null,"title":"Standup",
          "start":null,"end":null,"endedAt":null},
        "private-meeting":{"groupId":"private-group","callTabId":"private-tab","occurrence":null,"title":"private-secret",
          "start":null,"end":null,"endedAt":null}},
      "dismissedAlerts":[]},
    "calendar":{"access":"authorized","calendars":[],"events":[],"loading":false,"error":null,"lastFetch":null},
    "alerts":{"event":null},
    "sync":{"status":"off","enabled":false,"folder":null,"profiles":{"default":{"syncId":"s","enabled":true}},
      "lastSyncedAt":null,"error":null,"pending":0,"devices":[],"remoteTabs":{},"remoteProfiles":[]},
    "telemetry":{"sharing":false,"decided":true,"askDone":true}
  })"));
}
TEST(RuntimeStateTest, ServicesAllowlistUiFieldsAndProjectWithBrowserPrivacy) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private", true);
  AddServices(state);
  ASSERT_TRUE(IsRuntimeState(state));
  auto projected = ProjectRuntimeState(state, "normal");
  ASSERT_TRUE(projected);
  ASSERT_TRUE(IsRuntimeState(*projected));
  const auto* live = projected->FindDict("services")->FindDict("live");
  EXPECT_TRUE(live->FindDict("folders")->contains("public-folder"));
  EXPECT_TRUE(live->FindDict("meetingGroups")->contains("public-meeting"));
  const auto json = base::WriteJson(*projected).value();
  EXPECT_EQ(json.find("private-folder"), std::string::npos);
  EXPECT_EQ(json.find("private-meeting"), std::string::npos);
  EXPECT_EQ(json.find("private-secret"), std::string::npos);
  // Live folders belong to public spaces only; a private window also gets its own meeting group.
  auto own = ProjectRuntimeState(state, "private");
  ASSERT_TRUE(own);
  EXPECT_FALSE(own->FindDict("services")->FindDict("live")->FindDict("folders")->contains("private-folder"));
  EXPECT_TRUE(own->FindDict("services")->FindDict("live")->FindDict("meetingGroups")->contains("private-meeting"));

  // A credential or recovery field added to any record fails closed.
  for (const char* path : {"live.accounts.github", "sync", "telemetry", "live.folders.public-folder", "calendar"}) {
    auto leaked = state.Clone();
    leaked.FindDictByDottedPath(std::string("services.") + path)->Set("token", "secret");
    EXPECT_FALSE(IsRuntimeState(leaked)) << path;
  }
  auto unknown = state.Clone();
  unknown.FindDict("services")->Set("vault", base::DictValue());
  EXPECT_FALSE(IsRuntimeState(unknown));
  auto item = state.Clone();
  item.FindDictByDottedPath("services.live.items")->FindList("public-folder")->front().GetDict().Set("authToken", "x");
  EXPECT_FALSE(IsRuntimeState(item));
}
TEST(RuntimeStateTest, ServiceActionsNameTheirWindowAndVisibleRecords) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  AddWindow(state, "private", true);
  AddServices(state);
  const auto action = [](const char* name, base::ListValue args) {
    return base::DictValue().Set("method", "serviceAction").Set("action", name).Set("args", std::move(args));
  };
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", action("liveCreate", base::ListValue().Append("normal").Append("pullRequests"))));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", action("liveCreate", base::ListValue().Append("other").Append("pullRequests"))));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", action("liveCreate", base::ListValue().Append("normal").Append("secrets"))));
  // Private windows reach no shared service.
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", action("calendarRefresh", base::ListValue())));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", action("calendarRefresh", base::ListValue())));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", action("liveRemove", base::ListValue().Append("public-folder"))));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", action("liveRemove", base::ListValue().Append("private-folder"))));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", action("liveRemove", base::ListValue().Append("missing"))));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", action("liveOpen", base::ListValue().Append("normal").Append("public-folder").Append("i").Append(false))));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "other", action("liveOpen", base::ListValue().Append("normal").Append("public-folder").Append("i").Append(false))));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", action("meetingGroup", base::ListValue().Append("normal-tab").Append(base::Value()))));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "other", action("meetingGroup", base::ListValue().Append("normal-tab").Append(base::Value()))));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", action("meetingGroup", base::ListValue().Append("private-tab").Append(base::Value()))));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", action("calendarSettings", base::ListValue().Append(base::DictValue().Set("alertLead", "5")))));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", action("calendarSettings", base::ListValue().Append(base::DictValue().Set("alertLead", "6")))));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", action("calendarSettings", base::ListValue().Append(base::DictValue().Set("token", true)))));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", action("setProfileSynced", base::ListValue().Append("incognito:private").Append(true))));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", action("readTokens", base::ListValue())));
  auto extra = action("syncNow", base::ListValue());
  extra.Set("windowId", "normal");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", extra));
}
TEST(RuntimeStateTest, ImportsStayInRegularPublicSpacesWithBoundedRecords) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private", true);
  const auto tabs = [] {
    return base::DictValue().Set("method", "importTabs").Set("spaceId", "default").Set("group", base::Value())
        .Set("tabs", base::ListValue().Append(base::DictValue().Set("url", "https://a.example/").Set("title", "A").Set("pinned", false)));
  };
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", tabs()));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", tabs()));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", tabs().Set("spaceId", "incognito:private")));
  auto field = tabs();
  field.FindList("tabs")->front().GetDict().Set("adoptId", "tab:1");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", field));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", tabs().Set("afterId", "private-tab")));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", tabs().Set("afterId", "normal-tab")));
  auto bookmarks = base::DictValue().Set("method", "importBookmarks").Set("spaceId", "default").Set("browserName", "Chrome")
      .Set("root", base::DictValue().Set("type", "folder").Set("title", "Imported").Set("children", base::ListValue()));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", bookmarks.Clone()));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", bookmarks.Clone().Set("parentId", "missing")));
  bookmarks.FindDict("root")->Set("type", "script");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", bookmarks));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", base::DictValue().Set("method", "importPasswords").Set("spaceId", "default")));
}
TEST(RuntimeStateTest, ServiceAndImportRepliesCarryOnlyTheirResultShapes) {
  const auto kind = [](const char* method, const char* action = nullptr) {
    auto command = base::DictValue().Set("method", method);
    if (action) command.Set("action", action);
    return RuntimeCommandResultKind(command);
  };
  EXPECT_EQ(kind("importTabs"), RuntimeResultKind::kImport);
  EXPECT_EQ(kind("serviceAction", "githubStart"), RuntimeResultKind::kGithub);
  EXPECT_EQ(kind("serviceAction", "turnOnSync"), RuntimeResultKind::kSync);
  EXPECT_EQ(kind("serviceAction", "folderInfo"), RuntimeResultKind::kFolder);
  EXPECT_EQ(kind("serviceAction", "calendarConnect"), RuntimeResultKind::kBoolean);
  EXPECT_EQ(kind("serviceAction", "syncNow"), RuntimeResultKind::kNone);
  const auto reply = [](base::Value value, RuntimeResultKind kind) {
    auto r = base::DictValue().Set("epoch", "epoch").Set("revision", 3).Set("value", std::move(value));
    return IsRuntimeReply(r, "epoch", 2, 3, kind);
  };
  EXPECT_TRUE(reply(base::Value(Json(R"({"count":2,"tabIds":["a","b"]})")), RuntimeResultKind::kImport));
  EXPECT_FALSE(reply(base::Value(Json(R"({"count":2,"cookies":[]})")), RuntimeResultKind::kImport));
  EXPECT_FALSE(reply(base::Value("id"), RuntimeResultKind::kImport));
  EXPECT_TRUE(reply(base::Value(Json(R"({"id":"d","userCode":"ABCD","verificationUri":"https://github.com/login/device","expiresAt":1})")), RuntimeResultKind::kGithub));
  EXPECT_FALSE(reply(base::Value(Json(R"({"id":"d","userCode":"ABCD","verificationUri":"u","expiresAt":1,"token":"t"})")), RuntimeResultKind::kGithub));
  EXPECT_TRUE(reply(base::Value(Json(R"({"ok":true})")), RuntimeResultKind::kSync));
  EXPECT_TRUE(reply(base::Value(Json(R"({"error":"Wrong word","count":3})")), RuntimeResultKind::kSync));
  EXPECT_FALSE(reply(base::Value(Json(R"({"ok":true,"words":["a"]})")), RuntimeResultKind::kSync));
  EXPECT_TRUE(reply(base::Value(), RuntimeResultKind::kFolder));
  EXPECT_TRUE(reply(base::Value(true), RuntimeResultKind::kBoolean));
  EXPECT_FALSE(reply(base::Value(), RuntimeResultKind::kBoolean));
  // A service with no result cannot smuggle an object into a window.
  EXPECT_FALSE(reply(base::Value(Json(R"({"ok":true})")), RuntimeResultKind::kNone));
}
TEST(RuntimeStateTest, UtilityWindowsReadPublicStateAndActForPublicMainWindows) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddLittleBay(state, "harbor");
  AddWindow(state, "private", true);
  AddServices(state);
  ASSERT_TRUE(IsRuntimeState(state));
  // A utility window has no record: it reads what a public window reads.
  EXPECT_FALSE(ProjectRuntimeState(state, "settings"));
  auto projected = ProjectRuntimeState(state, "settings", /*utility=*/true);
  ASSERT_TRUE(projected);
  ASSERT_TRUE(IsRuntimeState(*projected));
  const auto json = base::WriteJson(*projected).value();
  EXPECT_NE(json.find("normal-secret"), std::string::npos);
  EXPECT_EQ(json.find("private-secret"), std::string::npos);
  EXPECT_EQ(json.find("incognito:private"), std::string::npos);
  EXPECT_TRUE(projected->FindDict("ui")->Find("focusedWindowId")->is_none());

  const auto can = [&](base::DictValue command) {
    return CanDispatchRuntimeCommand(state, "settings", command, /*utility=*/true);
  };
  EXPECT_FALSE(CanDispatchRuntimeCommand(
      state, "settings", base::DictValue().Set("method", "updateSettings").Set("patch", base::DictValue())));
  EXPECT_TRUE(can(base::DictValue().Set("method", "updateSettings").Set("patch", base::DictValue())));
  // Commands that name a window name a public main window, never a Little Bay or a private one.
  const auto new_tab = [](const char* window) {
    return base::DictValue().Set("method", "newTab").Set("windowId", window).Set(
        "options", base::DictValue().Set("url", "https://example.com/"));
  };
  EXPECT_TRUE(can(new_tab("normal")));
  EXPECT_FALSE(can(new_tab("harbor")));
  EXPECT_FALSE(can(new_tab("private")));
  EXPECT_FALSE(can(new_tab("settings")));
  EXPECT_TRUE(can(base::DictValue().Set("method", "showTab").Set("tabId", "normal-tab")));
  EXPECT_FALSE(can(base::DictValue().Set("method", "showTab").Set("tabId", "private-tab")));
  const auto action = [](const char* name, base::ListValue args) {
    return base::DictValue().Set("method", "serviceAction").Set("action", name).Set("args", std::move(args));
  };
  EXPECT_TRUE(can(action("googleConnect", base::ListValue().Append("normal").Append("id").Append("secret"))));
  EXPECT_FALSE(can(action("googleConnect", base::ListValue().Append("private").Append("id").Append("secret"))));
  auto imported = base::DictValue().Set("method", "importTabs").Set("spaceId", "default").Set("group", base::Value())
      .Set("tabs", base::ListValue().Append(base::DictValue().Set("url", "https://a.example/").Set("title", "A").Set("pinned", false)));
  EXPECT_TRUE(can(imported.Clone()));
  imported.Set("spaceId", "incognito:private");
  EXPECT_FALSE(can(std::move(imported)));
  // It shows no page, so commands about a shown page have nothing to name.
  EXPECT_FALSE(can(base::DictValue().Set("method", "setFind").Set("tabId", "normal-tab").Set("patch", base::DictValue())));
}
}  // namespace
TEST(RuntimeLocalFilesTest, ValidatesMetadataAndFiltersPathsIncludingUndo) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "private", true);
  AddLittleBay(state, "small");
  auto file = base::DictValue()
                  .Set("id", "file")
                  .Set("spaceId", "default")
                  .Set("path", "/Users/test/private-notes")
                  .Set("name", "Notes")
                  .Set("kind", "file")
                  .Set("createdAt", 1)
                  .Set("order", 0)
                  .Set("expanded", false);
  state.FindDict("localFiles")->Set("file", file.Clone());
  state.FindDict("sidebarUndo")->Set(
      "normal", base::ListValue().Append(base::DictValue().Set("id", "undo-1").Set(
                    "changes", base::ListValue().Append(base::DictValue()
                        .Set("key", "localFiles").Set("before", file.Clone())))));
  EXPECT_TRUE(IsRuntimeState(state));
  auto normal = ProjectRuntimeState(state, "normal");
  ASSERT_TRUE(normal);
  EXPECT_TRUE(normal->FindDict("localFiles")->contains("file"));
  const auto* stack = normal->FindDict("sidebarUndo")->FindList("normal");
  ASSERT_TRUE(stack);
  EXPECT_EQ(stack->size(), 1u);
  EXPECT_EQ(*(*stack)[0].GetDict().FindString("id"), "undo-1");
  EXPECT_TRUE((*stack)[0].GetDict().FindList("changes")->empty());
  for (const char* window : {"private", "small"}) {
    auto projection = ProjectRuntimeState(state, window);
    ASSERT_TRUE(projection);
    EXPECT_TRUE(projection->FindDict("localFiles")->empty());
    EXPECT_FALSE(projection->FindDict("sidebarUndo")->contains("normal"));
    const auto json = base::WriteJson(*projection);
    ASSERT_TRUE(json);
    EXPECT_EQ(json->find("/Users/test/private-notes"), std::string::npos);
  }
  auto& edit = (*state.FindDict("sidebarUndo")->FindList("normal"))[0].GetDict();
  edit.Set("id", 123);
  EXPECT_FALSE(IsRuntimeState(state));
  edit.Set("id", "undo-2");
  auto updated = ProjectRuntimeState(state, "normal");
  ASSERT_TRUE(updated);
  EXPECT_EQ(*(*updated->FindDict("sidebarUndo")->FindList("normal"))[0]
                 .GetDict().FindString("id"), "undo-2");
  auto* stored = state.FindDict("localFiles")->FindDict("file");
  stored->Set("nativeHandle", "forged");
  EXPECT_FALSE(IsRuntimeState(state));
  stored->Remove("nativeHandle");
  stored->Set("spaceId", "incognito:private");
  EXPECT_FALSE(IsRuntimeState(state));
  stored->Set("spaceId", "default");
  stored->Set("path", "/tmp/../secret");
  EXPECT_FALSE(IsRuntimeState(state));
}

TEST(RuntimeLocalFilesTest, GatesCommandsByOriginAndRejectsNativeFields) {
  auto state = State();
  AddWindow(state, "normal", false);
  AddWindow(state, "other", false);
  AddWindow(state, "private", true);
  AddLittleBay(state, "small");
  auto pin = base::DictValue()
                 .Set("method", "pinLocalFiles")
                 .Set("windowId", "normal")
                 .Set("files", base::ListValue().Append(base::DictValue()
                     .Set("path", "/tmp/notes").Set("name", "Notes")
                     .Set("kind", "file")));
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", pin));
  for (const char* window : {"other", "private", "small"})
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, window, pin));
  pin.Set("windowId", "private");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", pin));
  pin.Set("windowId", "small");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "small", pin));
  pin.Set("windowId", "normal");
  auto& metadata = (*pin.FindList("files"))[0].GetDict();
  metadata.Set("grant", "forged");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", pin));
  metadata.Remove("grant");
  metadata.Set("path", "/tmp/../secret");
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", pin));
  state.FindDict("localFiles")->Set("file", base::DictValue().Set("spaceId", "default"));
  for (const char* method : {"renameLocalFile", "removeLocalFile", "moveLocalFile", "setLocalFileExpanded"}) {
    auto c = base::DictValue().Set("method", method).Set("id", "file");
    if (std::string_view(method) == "renameLocalFile") c.Set("name", "Renamed");
    if (std::string_view(method) == "moveLocalFile") c.Set("beforeId", base::Value());
    if (std::string_view(method) == "setLocalFileExpanded") c.Set("expanded", true);
    EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", c));
    EXPECT_TRUE(CanDispatchRuntimeCommand(state, "other", c));
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", c));
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "small", c));
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", c, true));
    c.Set("native", true);
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", c));
  }
  auto undo = base::DictValue().Set("method", "undoSidebarEdit").Set("windowId", "normal");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "normal", undo));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "other", undo));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "private", undo));
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", undo, true));
}

TEST(RuntimeLocalFilesTest, RequiresBoundedIdListReplies) {
  const auto c = base::DictValue().Set("method", "pinLocalFiles");
  EXPECT_EQ(RuntimeCommandResultKind(c), RuntimeResultKind::kIdList);
  auto reply = base::DictValue().Set("epoch", "epoch").Set("revision", 1)
                   .Set("value", base::ListValue().Append("file").Append("file"));
  EXPECT_TRUE(IsRuntimeReply(reply, "epoch", 1, 1, RuntimeResultKind::kIdList));
  reply.Set("value", base::ListValue());
  EXPECT_TRUE(IsRuntimeReply(reply, "epoch", 1, 1, RuntimeResultKind::kIdList));
  reply.Set("value", base::ListValue().Append(""));
  EXPECT_FALSE(IsRuntimeReply(reply, "epoch", 1, 1, RuntimeResultKind::kIdList));
  reply.Set("value", base::ListValue().Append(1));
  EXPECT_FALSE(IsRuntimeReply(reply, "epoch", 1, 1, RuntimeResultKind::kIdList));
  reply.Set("value", "file");
  EXPECT_FALSE(IsRuntimeReply(reply, "epoch", 1, 1, RuntimeResultKind::kIdList));
  base::ListValue ids;
  for (int i = 0; i < 10001; ++i) ids.Append("file");
  reply.Set("value", std::move(ids));
  EXPECT_FALSE(IsRuntimeReply(reply, "epoch", 1, 1, RuntimeResultKind::kIdList));
}

}  // namespace bay
