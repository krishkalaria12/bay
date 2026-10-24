import {
  clearSiteData,
  getContentBlocker,
  getExternalAppAllowances,
  getSiteSettings,
  getSiteSettingsOrigins,
  getZoomLevels,
  onContentBlockerChange,
  removeExternalAppAllowance,
  resetSiteSettings,
  setContentBlockerAllowed,
  setContentBlockerEnabled,
  setFilterListEnabled,
  setSiteSetting,
  setZoom,
  type ContentBlockerState,
  type ExternalAppAllowance,
  type FilterList,
  type FilterListCategory,
  type SiteSettings,
  type SiteSettingType,
  type SiteSettingValue,
} from "@bay/nncore";
import { confirm } from "@bay/shell";
import { useEffect, useState } from "react";
import { Image, ScrollView, Text, View } from "react-native";
import { useTheme } from "../../../lib/theme";
import { useBrowser } from "../../../store/browser";
import { useSpaces } from "../../../store/hooks";
import { engineProfile } from "../../../store/model";
import { Favicon } from "../../primitives";
import { Button, Checkbox, Group, PopUp, Row, SectionHeader, Sheet, Toggle } from "../controls";
import { SETTINGS, type SettingId } from "../definitions";
import { closeSettingsSheet, showSettingsSheet } from "../sheet";
import { ShareDiagnosticsSection } from "./ShareDiagnostics";

const CATEGORIES: { id: FilterListCategory; toggle: string; settingId?: SettingId; section: string }[] = [
  { id: "ads", toggle: SETTINGS.blockAds.title, settingId: SETTINGS.blockAds.id, section: "Ad blockers" },
  { id: "trackers", toggle: SETTINGS.blockTrackers.title, settingId: SETTINGS.blockTrackers.id, section: "Trackers" },
  { id: "cookies", toggle: "", section: "Cookie banners" },
  { id: "annoyances", toggle: "", section: "Annoyances" },
  { id: "security", toggle: "", section: "Malware and scams" },
  { id: "regional", toggle: "", section: "Regional blockers" },
];

const filtersText = (n: number) => `${n.toLocaleString()} ${n === 1 ? "filter" : "filters"}`;

function useContentBlocker() {
  const [state, setState] = useState<ContentBlockerState | null>(null);
  const refresh = () =>
    void getContentBlocker()
      .then(setState)
      .catch(() => {});
  useEffect(() => {
    refresh();
    const sub = onContentBlockerChange(refresh);
    return () => sub.remove();
  }, []);
  return [state, refresh] as const;
}

const categoryOn = (s: ContentBlockerState, c: FilterListCategory) => s.enabled && s.lists.some((l) => l.category === c && l.enabled);

async function setCategory(s: ContentBlockerState, c: FilterListCategory, on: boolean) {
  const lists = s.lists.filter((l) => l.category === c);
  for (const l of on ? lists.filter((l) => l.defaultOn || l.enabled) : lists.filter((l) => l.enabled)) await setFilterListEnabled(l.id, on);
  const anyOn = CATEGORIES.some((x) => (x.id === c ? on : categoryOn(s, x.id)));
  if (anyOn !== s.enabled) await setContentBlockerEnabled(anyOn);
}

export function PrivacyPane() {
  const theme = useTheme();
  const [blocker, refresh] = useContentBlocker();

  const toggleCategory = async (c: FilterListCategory, on: boolean) => {
    if (!blocker) return;
    if (!on && c === "ads") {
      const { confirmed } = await confirm({
        title: "Turn Off Ad Blocker?",
        message: "Bay's Ad Blocker hides ads so pages load faster and feel cleaner.",
        confirmTitle: "Turn Off",
      });
      if (!confirmed) return;
    }
    // A change that fails changed nothing (or only the lists before it): show what the blocker has.
    await setCategory(blocker, c, on).finally(refresh);
  };

  return (
    <View>
      <SectionHeader title="Content blocking" description="Built on EasyList and EasyPrivacy. Blocking happens on this Mac." />
      <Group>
        {CATEGORIES.filter((c) => c.toggle).map((c) => (
          <Row key={c.id} settingId={c.settingId} title={c.toggle}>
            <Toggle value={!!blocker && categoryOn(blocker, c.id)} disabled={!blocker} onChange={(v) => void toggleCategory(c.id, v)} />
          </Row>
        ))}
        <Row
          settingId={SETTINGS.contentBlockerFilters.id}
          title={SETTINGS.contentBlockerFilters.title}
          description="Block common components found across the web by using additional rules and filters."
        >
          <Button title="Advanced…" disabled={!blocker} onPress={() => showSettingsSheet(<FilterListsSheet />)} />
        </Row>
      </Group>

      {!!blocker?.allowedHosts.length && (
        <>
          <SectionHeader title="Sites without blocking" description="Turned off from a site's controls. Blocking applies to subdomains too." />
          <Group>
            {blocker.allowedHosts.map((host) => (
              <Row key={host} icon={<Favicon url={`https://${host}`} />} title={host}>
                <Button title="Block Again" onPress={() => void setContentBlockerAllowed(host, false).then(refresh)} />
              </Row>
            ))}
          </Group>
        </>
      )}

      <SitePermissions />
      <AppLinks />
      <ZoomLevels />
      {blocker && (
        <Text style={{ marginTop: 14, fontSize: 11.5, color: theme.textTertiary }}>
          {`${(blocker.stats.networkFilters ?? 0).toLocaleString()} network and ${(blocker.stats.cosmeticFilters ?? 0).toLocaleString()} cosmetic rules loaded.`}
        </Text>
      )}
      <ShareDiagnosticsSection />
    </View>
  );
}

// Turning a list on turns the blocker on too.
async function enableFilterList(l: FilterList, on: boolean, blocker: ContentBlockerState | null) {
  await setFilterListEnabled(l.id, on);
  if (on && blocker && !blocker.enabled) await setContentBlockerEnabled(true);
}

function FilterListsSheet() {
  const theme = useTheme();
  const [blocker, refresh] = useContentBlocker();
  const toggle = (l: FilterList, on: boolean) => enableFilterList(l, on, blocker).finally(refresh);
  return (
    <Sheet width={500} onClose={closeSettingsSheet}>
      <Text style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>Advanced Ad Block Settings</Text>
      <Text style={{ fontSize: 12, marginTop: 4, color: theme.textSecondary }}>
        Block common components found across the web by using additional rules and filters.
      </Text>
      <ScrollView style={{ maxHeight: 420, marginTop: 8 }}>
        {CATEGORIES.map((c) => {
          const lists = blocker?.lists.filter((l) => l.category === c.id) ?? [];
          if (!lists.length) return null;
          return (
            <View key={c.id}>
              <SectionHeader title={c.section} />
              <Group>
                {lists.map((l) => (
                  <Row
                    key={l.id}
                    title={<Checkbox value={l.enabled} onChange={(v) => void toggle(l, v)} label={l.title} />}
                    description={l.defaultOn ? `${filtersText(l.filters)} · On by default` : filtersText(l.filters)}
                  />
                ))}
              </Group>
            </View>
          );
        })}
      </ScrollView>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 16 }}>
        <Text style={{ flex: 1, fontSize: 11.5, color: theme.textTertiary }}>
          {blocker?.version ? `Blocking by uBlock Origin ${blocker.version}, included with Bay. Its lists update on their own.` : ""}
        </Text>
        <Button title="Done" kind="primary" onPress={closeSettingsSheet} />
      </View>
    </Sheet>
  );
}

// MARK: Zoom levels

function ZoomLevels() {
  const spaceId = useBrowser((s) => s.settings.defaultSpaceId);
  const profiles = useSpaces();
  const [selected, setSelected] = useState(spaceId);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const load = () =>
    void getZoomLevels(engineProfile(selected))
      .then(setLevels)
      .catch(() => {});
  useEffect(load, [selected]);
  const hosts = Object.keys(levels).sort();
  if (!hosts.length) return null;
  return (
    <>
      <SectionHeader
        settingId={SETTINGS.zoomLevels.id}
        title={SETTINGS.zoomLevels.title}
        action={
          profiles.length > 1 ? <PopUp value={selected} options={profiles.map((p) => ({ value: p.id, title: p.name }))} onChange={setSelected} /> : undefined
        }
      />
      <Group>
        {hosts.map((host) => (
          <Row key={host} icon={<Favicon url={`https://${host}`} />} title={host} description={`${Math.round(levels[host]! * 100)}%`}>
            <Button title="Reset" onPress={() => void setZoom(engineProfile(selected), host, 1).then(load)} />
          </Row>
        ))}
      </Group>
    </>
  );
}

// MARK: Site permissions

const SETTING_LABELS: [SiteSettingType, string][] = [
  ["popups", "Pop-ups and redirects"],
  ["camera", "Camera"],
  ["microphone", "Microphone"],
  ["location", "Location"],
  ["notifications", "Notifications"],
  ["sound", "Sound"],
  ["autoplay", "Autoplay"],
  ["javascript", "JavaScript"],
  ["images", "Images"],
  ["clipboard", "Clipboard"],
  ["automaticDownloads", "Automatic downloads"],
  ["cookies", "Cookies"],
  ["midi", "MIDI devices"],
  ["windowManagement", "Window management"],
  ["localFonts", "Fonts"],
  ["storageAccess", "Embedded content"],
  ["fileSystem", "File editing"],
];

const VALUE_OPTIONS: { value: SiteSettingValue; title: string }[] = [
  { value: "default", title: "Default" },
  { value: "allow", title: "Allow" },
  { value: "block", title: "Block" },
  { value: "ask", title: "Ask" },
];

function SitePermissions() {
  const profiles = useSpaces();
  const [spaceId, setSpaceId] = useState(() => useBrowser.getState().settings.defaultSpaceId);
  const [origins, setOrigins] = useState<string[] | null>(null);
  const refresh = () =>
    void getSiteSettingsOrigins(engineProfile(spaceId))
      .then(setOrigins)
      .catch(() => setOrigins([]));
  useEffect(refresh, [spaceId]);

  return (
    <>
      <SectionHeader
        settingId={SETTINGS.sitePermissions.id}
        title={SETTINGS.sitePermissions.title}
        description="Pop-ups, camera, location and other permissions you've set for sites."
        action={
          profiles.length > 1 ? <PopUp value={spaceId} options={profiles.map((p) => ({ value: p.id, title: p.name }))} onChange={setSpaceId} /> : undefined
        }
      />
      <Group>
        {origins === null ? null : origins.length === 0 ? (
          <Row title="No sites yet" description="Sites appear here after you allow or block something for them." />
        ) : (
          origins.map((origin) => (
            <Row
              key={origin}
              icon={<Favicon url={origin} />}
              title={origin.replace(/^https?:\/\//, "")}
              onPress={() => showSettingsSheet(<SiteSheet spaceId={spaceId} origin={origin} onChanged={refresh} />)}
            />
          ))
        )}
      </Group>
    </>
  );
}

function AppLinks() {
  const profiles = useSpaces();
  const [spaceId, setSpaceId] = useState(() => useBrowser.getState().settings.defaultSpaceId);
  const [allowed, setAllowed] = useState<ExternalAppAllowance[] | null>(null);
  const refresh = () =>
    void getExternalAppAllowances(engineProfile(spaceId))
      .then(setAllowed)
      .catch(() => setAllowed([]));
  useEffect(refresh, [spaceId]);

  return (
    <>
      <SectionHeader
        settingId={SETTINGS.externalAppAllowances.id}
        title={SETTINGS.externalAppAllowances.title}
        description="Sites that open another app without asking first."
        action={
          profiles.length > 1 ? <PopUp value={spaceId} options={profiles.map((p) => ({ value: p.id, title: p.name }))} onChange={setSpaceId} /> : undefined
        }
      />
      <Group>
        {allowed === null ? null : allowed.length === 0 ? (
          <Row title="No apps yet" description="Check “Always allow” when a site opens an app, and it shows up here." />
        ) : (
          allowed.map((a) => (
            <Row
              key={`${a.origin}|${a.scheme}`}
              icon={a.icon ? <Image source={{ uri: a.icon }} style={{ width: 20, height: 20 }} /> : <Favicon url={a.origin} />}
              title={a.origin.replace(/^https?:\/\//, "")}
              description={`Opens ${a.scheme}: links in ${a.app ?? "an app that's no longer installed"}`}
            >
              <Button title="Remove" onPress={() => void removeExternalAppAllowance(engineProfile(spaceId), a.origin, a.scheme).then(refresh)} />
            </Row>
          ))
        )}
      </Group>
    </>
  );
}

function SiteSheet({ spaceId, origin, onChanged }: { spaceId: string; origin: string; onChanged: () => void }) {
  const theme = useTheme();
  const profile = engineProfile(spaceId);
  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [status, setStatus] = useState("");
  const load = () =>
    void getSiteSettings(profile, origin)
      .then(setSettings)
      .catch(() => {});
  useEffect(load, []);
  const set = async (type: SiteSettingType, value: SiteSettingValue) => {
    await setSiteSetting(profile, origin, type, value);
    load();
    onChanged();
  };
  return (
    <Sheet width={460} onClose={closeSettingsSheet}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Favicon url={origin} size={20} />
        <Text style={{ flex: 1, fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>{origin.replace(/^https?:\/\//, "")}</Text>
      </View>
      <ScrollView style={{ maxHeight: 380, marginTop: 12 }}>
        <Group>
          {SETTING_LABELS.filter(([type]) => settings?.[type]).map(([type, label]) => (
            <Row key={type} title={label} description={settings![type].isDefault ? `Default (${settings![type].value})` : undefined}>
              <PopUp
                value={settings![type].isDefault ? "default" : settings![type].value}
                options={VALUE_OPTIONS}
                onChange={(v) => void set(type, v)}
                minWidth={100}
              />
            </Row>
          ))}
        </Group>
      </ScrollView>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 16 }}>
        <Button
          title="Reset Permissions"
          onPress={() =>
            void resetSiteSettings(profile, origin).then(() => {
              load();
              onChanged();
            })
          }
        />
        <Button
          title="Clear Site Data"
          onPress={() =>
            void clearSiteData(profile, origin).then((r) =>
              setStatus(r.cookies === false ? "Site data cleared." : `Cleared ${r.cookies} cookie${r.cookies === 1 ? "" : "s"} and site data.`),
            )
          }
        />
        <Text style={{ flex: 1, fontSize: 12, color: theme.textSecondary }}>{status}</Text>
        <Button title="Done" kind="primary" onPress={closeSettingsSheet} />
      </View>
    </Sheet>
  );
}
