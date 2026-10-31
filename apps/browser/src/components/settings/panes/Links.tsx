import { View } from "@bay/platform";
import { Group, SectionHeader, SettingToggle } from "../controls";
import { SETTINGS } from "../definitions";
import { LinkRules } from "./LinkRules";
import { LittleBaySettings } from "./LittleBaySettings";

export function LinksPane() {
  return (
    <View>
      <LinkRules />

      <LittleBaySettings />

      <SectionHeader title="Clicking links" />
      <Group>
        <SettingToggle
          setting="peekLinksFromPinnedTabs"
          settingId={SETTINGS.peekLinksFromPinnedTabs.id}
          title={SETTINGS.peekLinksFromPinnedTabs.title}
          description="From pinned tabs and favorites, as Arc does. ⌘W or Esc closes it; ⌘O opens it as a tab."
        />
        <SettingToggle setting="cmdClickCreatesTabGroup" settingId={SETTINGS.cmdClickCreatesTabGroup.id} title={SETTINGS.cmdClickCreatesTabGroup.title} />
        <SettingToggle
          setting="optShiftClickOpensInGroup"
          settingId={SETTINGS.optShiftClickOpensInGroup.id}
          title={SETTINGS.optShiftClickOpensInGroup.title}
          description="⌥⇧-click a tab to open it in a group with the current tab. (⌥⇧-clicking a link opens it in a split.)"
        />
      </Group>
    </View>
  );
}
