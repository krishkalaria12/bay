import { Symbol } from "@bay/shell";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "../../../lib/theme";
import { useBrowser } from "../../../store/browser";
import { Button, Checkbox, Group, PopUp, Row, SectionHeader, SettingToggle, TextField, Toggle, useFormColors } from "../controls";
import { SETTINGS } from "../definitions";
import { CLEAN_UP_CHOICES } from "../constants";
import { updateCalendarSettings, useLive } from "../../../live/store";
import { normalizeAwakeSite } from "../../../lib/awakeSites";

export function TabsPane() {
  const settings = useBrowser((s) => s.settings);
  const update = useBrowser((s) => s.updateSettings);
  const top = settings.tabLayout === "top";

  return (
    <View>
      <SectionHeader settingId={SETTINGS.tabLayout.id} title={SETTINGS.tabLayout.title} />
      <View style={{ flexDirection: "row", gap: 14 }}>
        <LayoutChoice layout="sidebar" title="Tab layout in the sidebar" selected={!top} />
        <LayoutChoice layout="top" title="Tab layout across the top of the window" selected={top} />
      </View>
      <Group style={{ marginTop: 14 }}>
        <SettingToggle
          setting="hideToolbarWhileScrolling"
          settingId={SETTINGS.hideToolbarWhileScrolling.id}
          title={SETTINGS.hideToolbarWhileScrolling.title}
          description="With tabs across the top, scrolling down tucks the toolbar into a thin strip with the site's name. Scroll up, or click the strip, to bring it back."
        />
      </Group>

      <SectionHeader title="General" />
      <Group>
        <Row settingId={SETTINGS.newTabPosition.id} title={top ? SETTINGS.newTabPosition.topTabsTitle : SETTINGS.newTabPosition.title}>
          <Toggle value={settings.newTabPosition === "top"} onChange={(v) => update({ newTabPosition: v ? "top" : "bottom" })} />
        </Row>
        <SettingToggle setting="warnBeforeClosingLastTab" settingId={SETTINGS.warnBeforeClosingLastTab.id} title={SETTINGS.warnBeforeClosingLastTab.title} />
        <SettingToggle setting="tabReorderHaptics" settingId={SETTINGS.tabReorderHaptics.id} title={SETTINGS.tabReorderHaptics.title} />
        <SettingToggle setting="extendWebsiteColor" settingId={SETTINGS.extendWebsiteColor.id} title={SETTINGS.extendWebsiteColor.title} />
        <SettingToggle
          setting="autoPictureInPicture"
          settingId={SETTINGS.autoPictureInPicture.id}
          title={SETTINGS.autoPictureInPicture.title}
          description="A video or call you're watching pops out when you switch tabs or leave the window, and returns when you come back."
        />
        <SettingToggle
          setting="unreadBadges"
          settingId={SETTINGS.unreadBadges.id}
          title={SETTINGS.unreadBadges.title}
          description="Gmail, Slack, X, Discord and other sites that put a count in their title show it on their tile, also while asleep."
        />
      </Group>

      <SectionHeader title="Tab groups" />
      <Group>
        <SettingToggle setting="autoGroupMeetingTabs" settingId={SETTINGS.autoGroupMeetingTabs.id} title={SETTINGS.autoGroupMeetingTabs.title} />
      </Group>

      <AwakeSites />

      <SectionHeader
        settingId={SETTINGS.previews.id}
        title={SETTINGS.previews.title}
        description="Hover a closed folder or group, or a pinned or favorite tab on one of these sites, to see what's there without opening it."
      />
      <Group>
        <SettingToggle setting="previewFolders" title="Folders and groups" description="Their tabs." />
        <CalendarPreviewToggle />
        <SettingToggle setting="previewGmail" title="Gmail" description="Unread mail, and Compose." />
        <SettingToggle
          setting="previewGithub"
          title="GitHub"
          description="Your open pull requests and the ones waiting on your review, and whether they're approved."
        />
      </Group>

      <SectionHeader
        settingId={SETTINGS.cleanUpInactiveTabsAfterHours.id}
        title={SETTINGS.cleanUpInactiveTabsAfterHours.title}
        description="Closes tabs you haven't used (and duplicates) automatically, like the tab menu's Clean Up Daily. Pinned, playing and selected tabs stay; cleaned tabs are listed under Recently Cleaned. A space can have its own time, in its settings."
      />
      <Group>
        <Row
          title={
            <Checkbox
              value={settings.cleanUpInactiveTabsAfterHours !== null}
              onChange={(v) => update({ cleanUpInactiveTabsAfterHours: v ? 24 : null })}
              label="Clean up tabs I haven't used in:"
            />
          }
        >
          <PopUp
            value={String(settings.cleanUpInactiveTabsAfterHours ?? 24)}
            options={CLEAN_UP_CHOICES}
            disabled={settings.cleanUpInactiveTabsAfterHours === null}
            onChange={(v) => update({ cleanUpInactiveTabsAfterHours: Number(v) })}
          />
        </Row>
      </Group>
    </View>
  );
}

function AwakeSites() {
  const sites = useBrowser((s) => s.settings.awakeSites);
  const theme = useTheme();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const site = normalizeAwakeSite(input);
    if (!site) {
      setError("Enter a website such as example.com.");
      return;
    }
    const s = useBrowser.getState();
    if (!s.settings.awakeSites.includes(site)) s.updateSettings({ awakeSites: [...s.settings.awakeSites, site] });
    setInput("");
    setError(null);
  };
  const remove = (site: string) => {
    const s = useBrowser.getState();
    s.updateSettings({ awakeSites: s.settings.awakeSites.filter((item) => item !== site) });
  };
  return (
    <View>
      <SectionHeader
        settingId={SETTINGS.awakeSites.id}
        title={SETTINGS.awakeSites.title}
        description="Idle tabs can sleep after two hours. These sites and their subdomains stay awake unless memory is critical, when they sleep last."
      />
      <Group>
        {sites.map((site) => (
          <Row key={site} title={site}>
            <Button title="Remove" kind="plain" onPress={() => remove(site)} />
          </Row>
        ))}
        <View style={{ padding: 12, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <TextField
            value={input}
            onChangeText={(value) => {
              setInput(value);
              setError(null);
            }}
            placeholder="example.com"
            onSubmit={add}
            style={{ flex: 1 }}
          />
          <Button title="Add" disabled={!input.trim()} onPress={add} />
        </View>
      </Group>
      {error && <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 6 }}>{error}</Text>}
    </View>
  );
}

function LayoutChoice({ layout, title, selected }: { layout: "sidebar" | "top"; title: string; selected: boolean }) {
  const theme = useTheme();
  const colors = useFormColors();
  const choose = () => {
    const s = useBrowser.getState();
    s.updateSettings({ tabLayout: layout });
    for (const w of Object.values(s.windows)) {
      if ((w.tabLayout ?? s.settings.tabLayout) !== layout) useBrowser.getState().toggleTabLayout(w.id);
    }
    useBrowser.getState().updateSettings({ tabLayout: layout });
  };
  const bar = theme.dark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.16)";
  const page = theme.dark ? "rgba(255,255,255,0.08)" : "#FFFFFF";
  return (
    <Pressable onPress={choose} style={{ flex: 1, alignItems: "center", gap: 8 }}>
      <View
        style={{
          width: "100%",
          height: 104,
          borderRadius: 10,
          padding: 8,
          borderWidth: selected ? 2.5 : 1,
          borderColor: selected ? colors.accent : colors.groupBorder,
          backgroundColor: theme.dark ? "#2A2A2C" : "#E9E9EB",
          flexDirection: layout === "sidebar" ? "row" : "column",
          gap: 5,
        }}
      >
        {layout === "sidebar" ? (
          <View style={{ width: "26%", gap: 4, paddingTop: 10 }}>
            {[0, 1, 2, 3].map((i) => (
              <View key={i} style={{ height: 7, borderRadius: 3, backgroundColor: i === 1 ? colors.accent : bar }} />
            ))}
          </View>
        ) : (
          <View style={{ height: 10, flexDirection: "row", gap: 4, paddingLeft: 26 }}>
            {[0, 1, 2].map((i) => (
              <View key={i} style={{ flex: 1, borderRadius: 3, backgroundColor: i === 1 ? colors.accent : bar }} />
            ))}
          </View>
        )}
        <View style={{ flex: 1, borderRadius: 5, backgroundColor: page }} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        {selected && <Symbol name="checkmark.circle.fill" size={12} color={colors.accent} style={{ width: 14, height: 14 }} />}
        <Text style={{ fontSize: 12, color: selected ? theme.textPrimary : theme.textSecondary }}>{title}</Text>
      </View>
    </Pressable>
  );
}

// The calendar's own setting (Settings › Calendar), listed with the other previews.
function CalendarPreviewToggle() {
  const on = useLive((s) => s.calendar.showPreview);
  return (
    <Row title="Calendar" description="Today's events, with Join.">
      <Toggle value={on} onChange={(v) => updateCalendarSettings({ showPreview: v })} />
    </Row>
  );
}
