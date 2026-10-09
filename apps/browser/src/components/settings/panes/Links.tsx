import { Symbol } from "@bay/shell";
import { Pressable, Text, View } from "react-native";
import { APP_NAME } from "../../../lib/constants";
import { useTheme } from "../../../lib/theme";
import { useBrowser } from "../../../store/browser";
import { Group, SectionHeader, SettingToggle, useFormColors } from "../controls";

export function LinksPane() {
  const theme = useTheme();
  const small = useBrowser((s) => s.settings.openLinksInLittleBay);

  return (
    <View>
      <SectionHeader title="Links from other apps" description="Where a link you click in Discord, Slack or Mail opens." />
      <View style={{ flexDirection: "row", gap: 14 }}>
        <OpenInChoice small title="Little Bay" selected={small} />
        <OpenInChoice small={false} title={`A new tab in ${APP_NAME}`} selected={!small} />
      </View>
      <Text style={{ marginTop: 12, paddingHorizontal: 2, fontSize: 12, lineHeight: 16, color: theme.textSecondary }}>
        {small
          ? `Little Bay is a small window of its own, for a quick look at a link. ⌘O moves it into ${APP_NAME}; closing it throws it away.`
          : `The link opens as a new tab in your ${APP_NAME} window, in the default space.`}
      </Text>

      <SectionHeader title="Clicking links" />
      <Group>
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

// A picture of where the link lands: a small floating window over the browser, or a new tab in its sidebar.
function OpenInChoice({ small, title, selected }: { small: boolean; title: string; selected: boolean }) {
  const theme = useTheme();
  const colors = useFormColors();
  const update = useBrowser((s) => s.updateSettings);
  const bar = theme.dark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.16)";
  const page = theme.dark ? "rgba(255,255,255,0.08)" : "#FFFFFF";
  return (
    <Pressable onPress={() => update({ openLinksInLittleBay: small })} style={{ flex: 1, alignItems: "center", gap: 8 }}>
      <View
        style={{
          width: "100%",
          height: 104,
          borderRadius: 10,
          padding: 8,
          borderWidth: selected ? 2.5 : 1,
          borderColor: selected ? colors.accent : colors.groupBorder,
          backgroundColor: theme.dark ? "#2A2A2C" : "#E9E9EB",
          flexDirection: "row",
          gap: 5,
        }}
      >
        <View style={{ width: "26%", gap: 4, paddingTop: 10 }}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={{ height: 7, borderRadius: 3, backgroundColor: !small && i === 3 ? colors.accent : bar }} />
          ))}
        </View>
        <View style={{ flex: 1, borderRadius: 5, backgroundColor: page }} />
        {small && (
          <View
            style={{
              position: "absolute",
              left: "30%",
              right: "18%",
              top: 18,
              bottom: 14,
              borderRadius: 6,
              padding: 4,
              gap: 3,
              backgroundColor: theme.dark ? "#3A3A3C" : "#F6F6F8",
              borderWidth: 1.5,
              borderColor: colors.accent,
              shadowColor: "#000000",
              shadowOpacity: 0.18,
              shadowRadius: 6,
              shadowOffset: { width: 0, height: 3 },
            }}
          >
            <View style={{ height: 5, width: "45%", borderRadius: 2.5, backgroundColor: bar }} />
            <View style={{ flex: 1, borderRadius: 3, backgroundColor: page }} />
          </View>
        )}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        {selected && <Symbol name="checkmark.circle.fill" size={12} color={colors.accent} style={{ width: 14, height: 14 }} />}
        <Text style={{ fontSize: 12, color: selected ? theme.textPrimary : theme.textSecondary }}>{title}</Text>
      </View>
    </Pressable>
  );
}
