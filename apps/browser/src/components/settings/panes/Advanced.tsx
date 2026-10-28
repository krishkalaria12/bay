import { View } from "@bay/platform";
import { engineInfo, listComponents, WIDEVINE_COMPONENT_ID, type EngineComponent, type EngineInfo } from "@bay/nncore";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { reportBrowserCommand } from "../../../runtime/commands";
import { updateSettings } from "../../../runtime/settingsActions";
import { useBrowserRead } from "../../../store/read";
import { useTheme } from "../../../lib/theme";
import { openInternalPage } from "../../pages/urls";
import { Button, Group, Row, SectionHeader, Toggle } from "../controls";
import { SETTINGS } from "../definitions";
import { setBoostsOn, startBoosts, useBoosts } from "../../boosts/state";
import { openLibrary } from "../../library/actions";

export function AdvancedPane() {
  const theme = useTheme();
  const settings = useBrowserRead((s) => s.settings);
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [widevine, setWidevine] = useState<EngineComponent | null | undefined>(undefined);
  useEffect(() => {
    void engineInfo()
      .then(setInfo)
      .catch(() => {});
    void listComponents()
      .then((list) => setWidevine(list.find((c) => c.id === WIDEVINE_COMPONENT_ID) ?? null))
      .catch(() => setWidevine(null));
  }, []);
  const widevineVersion = widevine && widevine.version !== "0.0.0.0" ? widevine.version : null;

  return (
    <View>
      <SectionHeader title="Browsing" />
      <Group>
        <Row settingId={SETTINGS.showFullUrl.id} title={SETTINGS.showFullUrl.title} description="Instead of the site alone.">
          <Toggle value={settings.showFullUrl} onChange={(v) => reportBrowserCommand(updateSettings({ showFullUrl: v }))} />
        </Row>
        <Row
          settingId={SETTINGS.warnBeforeMovingTabsToSpace.id}
          title={SETTINGS.warnBeforeMovingTabsToSpace.title}
          description="Some site data doesn't come along."
        >
          <Toggle value={settings.warnBeforeMovingTabsToSpace} onChange={(v) => reportBrowserCommand(updateSettings({ warnBeforeMovingTabsToSpace: v }))} />
        </Row>
        <Row settingId={SETTINGS.showBookmarksImport.id} title={SETTINGS.showBookmarksImport.title} description="On an empty bookmarks bar.">
          <Toggle value={!settings.hideBookmarksBarImport} onChange={(v) => reportBrowserCommand(updateSettings({ hideBookmarksBarImport: !v }))} />
        </Row>
      </Group>

      <SectionHeader title="Websites" />
      <Group>
        <BoostsRow />
      </Group>

      <SectionHeader title="Data" />
      <Group>
        <Row settingId={SETTINGS.history.id} title={SETTINGS.history.title} description="Every page you visited, by day.">
          <Button title="Show History" onPress={() => openInternalPage("history")} />
        </Row>
        <Row settingId={SETTINGS.downloads.id} title={SETTINGS.downloads.title} description="Files you downloaded, with where they're saved.">
          <Button title="Show Downloads" onPress={() => openInternalPage("downloads")} />
        </Row>
      </Group>

      <SectionHeader title="Web engine" />
      <Group>
        <Row settingId={SETTINGS.chromium.id} title={SETTINGS.chromium.title} description={info ? "NNCore" : undefined}>
          <Text selectable style={{ fontSize: 13, color: theme.textSecondary }}>
            {info?.chromiumVersion ?? "…"}
          </Text>
        </Row>
        <Row
          title="Widevine (protected video)"
          description={
            widevine === undefined
              ? "Checking…"
              : widevineVersion
                ? `Version ${widevineVersion}`
                : "Not available in this build: video that needs it, like Netflix or Disney+, won't play."
          }
        />
      </Group>
    </View>
  );
}

// Every Boost on or off at once (Arc's Boosts; each site's are in Site Controls and Library › Boosts).
function BoostsRow() {
  const on = useBoosts((s) => s.on);
  const count = useBoosts((s) => Object.keys(s.boosts).length);
  useEffect(() => startBoosts(), []);
  return (
    <Row
      settingId={SETTINGS.boosts.id}
      title={SETTINGS.boosts.title}
      description={`Your changes to how sites look${count ? ` (${count} ${count === 1 ? "Boost" : "Boosts"})` : ""}. Off shows every site as it is.`}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Button title="Show Boosts" onPress={() => openLibrary(null, "boosts")} />
        <Toggle value={on} onChange={setBoostsOn} />
      </View>
    </Row>
  );
}
