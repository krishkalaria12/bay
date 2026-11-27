import type { PageEngine } from "@bay/chromium";
import { useState } from "react";
import { Text, View } from "react-native";
import { reportBrowserCommand } from "../../../runtime/commands";
import { updateSettings } from "../../../runtime/settingsActions";
import { useTheme } from "../../../lib/theme";
import { siteFromInput } from "../../../lib/siteDomain";
import { PROTECTED_VIDEO_SITES } from "../../../store/engines";
import { useBrowserRead } from "../../../store/read";
import type { EngineMode, Settings } from "../../../store/settings";
import { Favicon, IconButton } from "../../ui/primitives";
import { Button, Group, PopUp, Row, SectionHeader, SettingToggle, Sheet, TextField, Toggle, type Option } from "../controls";
import { SETTINGS } from "../definitions";
import { closeSettingsSheet, showSettingsSheet } from "../sheet";
import { PasskeysRow } from "../PasskeysRow";

// Which engine pages open in (store/engines.ts): the mode, the default engine, site rules, streaming sites and what
// a stalled protected video does. Shown only on a build with WebKit (macOS). Site Controls' "Learn more" comes here.

const ENGINE_OPTIONS: Option<PageEngine>[] = [
  { value: "chromium", title: "Chromium" },
  { value: "webkit", title: "WebKit" },
];

const MODE_OPTIONS: Option<EngineMode>[] = [
  { value: "automatic", title: "Automatic" },
  { value: "chromium", title: "Chromium" },
  { value: "webkit", title: "WebKit" },
];

const MODE_DESCRIPTIONS: Record<EngineMode, string> = {
  automatic: "Most pages open in the default engine. Streaming sites open in WebKit to play protected video, and your site rules apply.",
  chromium: "Every page opens in Chromium. Streaming sites whose video needs FairPlay won't play.",
  webkit: "Every page opens in WebKit, except Bay's own pages and extensions' pages. WebKit pages have no extensions, and a few ads get through there.",
};

const FALLBACK_OPTIONS: Option<Settings["protectedVideoFallback"]>[] = [
  { value: "move", title: "Move to WebKit" },
  { value: "ask", title: "Ask" },
  { value: "stay", title: "Stay in Chromium" },
];

const patch = (settings: Partial<Settings>) => reportBrowserCommand(updateSettings(settings));

function setRule(rules: Readonly<Record<string, PageEngine>>, site: string, engine: PageEngine | null, replacing?: string) {
  const next = Object.fromEntries(Object.entries(rules).filter(([key]) => key !== site && key !== replacing));

  if (engine) next[site] = engine;
  patch({ siteEngines: next });
}

export function EnginesPane() {
  const mode = useBrowserRead((s) => s.settings.engineMode);
  const defaultEngine = useBrowserRead((s) => s.settings.defaultEngine);
  const rules = useBrowserRead((s) => s.settings.siteEngines);
  const streaming = useBrowserRead((s) => s.settings.streamingInWebKit);
  const fallback = useBrowserRead((s) => s.settings.protectedVideoFallback);
  const automatic = mode === "automatic";
  const sites = Object.keys(rules).sort();
  const streamingNames = PROTECTED_VIDEO_SITES.slice(0, 3).join(", ");

  return (
    <View>
      <SectionHeader title="Engines" />
      <Group>
        <Row settingId={SETTINGS.engineMode.id} title={SETTINGS.engineMode.title} description={MODE_DESCRIPTIONS[mode]}>
          <PopUp value={mode} options={MODE_OPTIONS} onChange={(engineMode) => patch({ engineMode })} minWidth={130} />
        </Row>
        <Row
          settingId={SETTINGS.defaultEngine.id}
          title={SETTINGS.defaultEngine.title}
          description={automatic ? "Pages without a rule open here." : "Used in Automatic mode."}
        >
          <PopUp
            value={defaultEngine}
            disabled={!automatic}
            options={[
              { value: "chromium", title: "Chromium (recommended)" },
              { value: "webkit", title: "WebKit" },
            ]}
            onChange={(engine) => patch({ defaultEngine: engine })}
            minWidth={180}
          />
        </Row>
      </Group>

      <SectionHeader
        settingId={SETTINGS.siteEngines.id}
        title={SETTINGS.siteEngines.title}
        description={automatic ? "A rule covers the site's subdomains too." : "Rules apply in Automatic mode."}
        action={<Button title="Add Rule…" icon="plus" disabled={!automatic} onPress={() => showSettingsSheet(<RuleSheet rules={rules} />)} />}
      />
      <Group>
        <Row
          settingId={SETTINGS.protectedMedia.id}
          icon={<Favicon url="https://www.netflix.com" />}
          title={SETTINGS.protectedMedia.title}
          description={`${streamingNames} and ${PROTECTED_VIDEO_SITES.length - 3} more open in WebKit, which has the FairPlay their protected video needs.`}
        >
          <Toggle value={streaming} disabled={!automatic} onChange={(on) => patch({ streamingInWebKit: on })} />
        </Row>
        {sites.map((site) => (
          <Row key={site} icon={<Favicon url={`https://${site}`} />} title={site} description="And its subdomains">
            <PopUp value={rules[site]!} disabled={!automatic} options={ENGINE_OPTIONS} onChange={(engine) => setRule(rules, site, engine)} minWidth={110} />
            <IconButton icon="pencil" size={11} box={24} radius={6} tooltip="Edit" onPress={() => showSettingsSheet(<RuleSheet rules={rules} site={site} />)} />
            <IconButton icon="trash" size={11} box={24} radius={6} tooltip="Remove" onPress={() => setRule(rules, site, null)} />
          </Row>
        ))}
      </Group>

      <SectionHeader title="Protected video" />
      <Group>
        <Row
          settingId={SETTINGS.protectedVideoFallback.id}
          title={SETTINGS.protectedVideoFallback.title}
          description="When a Chromium page's DRM video stalls, WebKit can usually play it."
        >
          <PopUp value={fallback} options={FALLBACK_OPTIONS} onChange={(protectedVideoFallback) => patch({ protectedVideoFallback })} minWidth={150} />
        </Row>
      </Group>

      <SectionHeader title="Switching engines" />
      <Group>
        <SettingToggle
          setting="engineSwitchKeepsPage"
          settingId={SETTINGS.engineSwitchKeepsPage.id}
          title={SETTINGS.engineSwitchKeepsPage.title}
          description="The page stays on screen until the other engine shows it, at the same scroll position and zoom."
        />
        <SettingToggle
          setting="engineSwitchCarriesSignIns"
          settingId={SETTINGS.engineSignIns.id}
          title={SETTINGS.engineSignIns.title}
          description="Copies the site's cookies and storage to the other engine, so you stay signed in. Never in private windows."
        />
      </Group>

      <SectionHeader title="WebKit pages" />
      <Group>
        <SettingToggle
          setting="webKitFraudWarnings"
          settingId={SETTINGS.webKitFraudWarnings.id}
          title={SETTINGS.webKitFraudWarnings.title}
          description="Shows a warning before a page WebKit knows to be deceptive or harmful. WebKit checks with Safe Browsing through Apple."
        />
        <PasskeysRow />
        <Row settingId={SETTINGS.engineDifferences.id} title={SETTINGS.engineDifferences.title} onPress={() => showSettingsSheet(<DifferencesSheet />)} />
      </Group>
    </View>
  );
}

function RuleSheet({ rules, site }: { rules: Readonly<Record<string, PageEngine>>; site?: string }) {
  const theme = useTheme();
  const [input, setInput] = useState(site ?? "");
  const [engine, setEngine] = useState<PageEngine>(site ? (rules[site] ?? "webkit") : "webkit");
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const domain = siteFromInput(input);

    if (!domain) return setError("Enter a site, like figma.com.");
    setRule(rules, domain, engine, site);
    closeSettingsSheet();
  };

  return (
    <Sheet width={400} onClose={closeSettingsSheet}>
      <Text style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>{site ? "Edit Site Rule" : "Add Site Rule"}</Text>
      <Text style={{ fontSize: 11.5, marginTop: 12, marginBottom: 5, color: theme.textSecondary }}>Site</Text>
      <TextField value={input} onChangeText={setInput} placeholder="figma.com" onSubmit={save} onEscape={closeSettingsSheet} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12 }}>
        <Text style={{ fontSize: 13, color: theme.textPrimary }}>Opens in</Text>
        <PopUp value={engine} options={ENGINE_OPTIONS} onChange={setEngine} minWidth={110} />
      </View>
      {error && <Text style={{ fontSize: 12, marginTop: 10, color: "#FF453A" }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 18 }}>
        <View style={{ flex: 1 }} />
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title={site ? "Save" : "Add"} kind="primary" onPress={save} />
      </View>
    </Sheet>
  );
}

const DIFFERENCES: [string, string][] = [
  [
    "Sign-ins",
    "Each engine keeps its own cookies and site data in every space. With Bring sign-ins along on, a switch copies the site's sign-in to the other engine.",
  ],
  ["Extensions", "Extensions run only in Chromium. Pages they open stay in Chromium in every mode."],
  [
    "Ad blocking",
    "Both engines use your filter lists. WebKit pages get their network and element-hiding rules; script-based filters can't run there, so a few ads get through.",
  ],
  ["DevTools", "DevTools open only on Chromium pages."],
  ["Shared", "Tabs, history, bookmarks, passwords and settings are the same in both engines."],
];

function DifferencesSheet() {
  const theme = useTheme();

  return (
    <Sheet width={460} onClose={closeSettingsSheet}>
      <Text style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>How Engines Differ</Text>
      <Group style={{ marginTop: 14 }}>
        {DIFFERENCES.map(([title, description]) => (
          <Row key={title} title={title} description={description} />
        ))}
      </Group>
      <View style={{ flexDirection: "row", marginTop: 18 }}>
        <View style={{ flex: 1 }} />
        <Button title="Done" kind="primary" onPress={closeSettingsSheet} />
      </View>
    </Sheet>
  );
}
