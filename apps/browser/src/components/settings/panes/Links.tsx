import { View } from "react-native";
import { Group, SectionHeader, SettingToggle } from "../controls";
import { LinkRules } from "./LinkRules";

export function LinksPane() {
  return (
    <View>
      <LinkRules />

      <SectionHeader title="Clicking links" />
      <Group>
        <SettingToggle
          setting="peekLinksFromPinnedTabs"
          title="Open a Peek window when clicking links to other sites"
          description="From pinned tabs and favorites, as Arc does. ⌘W or Esc closes it; ⌘O opens it as a tab."
        />
        <SettingToggle setting="cmdClickCreatesTabGroup" title="⌘-clicking links creates tab groups" />
        <SettingToggle
          setting="optShiftClickOpensInGroup"
          title="⌥⇧-click opens tab in group"
          description="⌥⇧-click a tab to open it in a group with the current tab. (⌥⇧-clicking a link opens it in a split.)"
        />
      </Group>
    </View>
  );
}
