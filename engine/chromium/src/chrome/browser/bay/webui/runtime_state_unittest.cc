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
    "tabLists":{},"peeks":{},"closedPeeks":{},
    "tabs":{},"live":{},"closedTabs":[],"groups":{},"selection":{},
    "cleanedTabs":[],"privateCleanedTabs":{},"privateSiteMutes":{},
    "closedGroups":[],"deletedGroups":[],"splits":{},"history":{},
    "historyReady":{},"historyFloor":{},"bookmarks":{"nodes":{},"roots":{}},
    "bookmarksReady":{},"settings":{},
    "ui":{"focusedWindowId":null,"focusOrder":[],"appDark":true},
    "windowUi":{},"find":{},"downloads":[]
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
  EXPECT_FALSE(CanDispatchRuntimeCommand(
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
  EXPECT_TRUE(IsRuntimeReply(reply, "epoch", 2, 3, false));
  EXPECT_FALSE(IsRuntimeReply(reply, "other-epoch", 2, 3, false));
  EXPECT_FALSE(IsRuntimeReply(reply, "epoch", 4, 5, false));
  EXPECT_FALSE(IsRuntimeReply(reply, "epoch", 2, 2, false));
  EXPECT_FALSE(IsRuntimeReply(reply, "epoch", 2, 3, true));
  reply.Set("value", "created-tab-id");
  EXPECT_TRUE(IsRuntimeReply(reply, "epoch", 2, 3, true));
  EXPECT_FALSE(IsRuntimeReply(reply, "epoch", 2, 3, false));
  // A newTab routed to app UI legitimately returns an empty id.
  reply.Set("value", "");
  EXPECT_TRUE(IsRuntimeReply(reply, "epoch", 2, 3, true));
  auto error = base::DictValue()
                   .Set("epoch", "epoch")
                   .Set("error", base::DictValue()
                                     .Set("code", "failed")
                                     .Set("message", "failed command"));
  EXPECT_TRUE(IsRuntimeReply(error, "epoch", 2, 3, false));
  error.Set("revision", 3);
  EXPECT_FALSE(IsRuntimeReply(error, "epoch", 2, 3, false));
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
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", command));
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
  EXPECT_FALSE(CanDispatchRuntimeCommand(state, "normal", request));
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
TEST(RuntimeStateTest, HarborTabCreationCannotBypassTheNewWindowGate) {
  auto state = State();
  AddWindow(state, "harbor", false);
  state.FindDict("windows")->FindDict("harbor")->Set("kind", "small");
  state.FindDict("tabLists")
      ->Set("harbor", state.FindDict("tabLists")->FindList("default")->Clone());
  state.FindDict("tabLists")->Remove("default");
  EXPECT_FALSE(CanDispatchRuntimeCommand(
      state, "harbor",
      base::DictValue().Set("method", "newTab").Set("windowId", "harbor")));
  auto command = base::DictValue()
                     .Set("method", "openLocation")
                     .Set("sourceTabId", "harbor-tab")
                     .Set("url", "https://example.com/");
  for (const auto* disposition : {"newTab", "backgroundTab", "newWindow"}) {
    command.Set("disposition", disposition);
    EXPECT_FALSE(CanDispatchRuntimeCommand(state, "harbor", command));
  }
  command.Set("disposition", "current");
  EXPECT_TRUE(CanDispatchRuntimeCommand(state, "harbor", command));
}
}  // namespace
}  // namespace bay
