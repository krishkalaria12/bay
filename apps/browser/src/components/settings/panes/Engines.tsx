import type { PageEngine } from "@bay/nncore";
import { resolveInput } from "@bay/core";
import { useState } from "react";
import { Text, View } from "react-native";
import { setWebsiteEngine } from "../../../lib/engines";
import { useTheme } from "../../../lib/theme";
import { useBrowser } from "../../../store/browser";
import { defaultEngine, ENGINE_NAMES, PROTECTED_VIDEO_SITES, RECOMMENDED_ENGINE, siteOf } from "../../../store/engines";
import { Favicon, IconButton } from "../../primitives";
import { Button, Group, PopUp, Row, SectionHeader, SettingToggle, Sheet, TextField } from "../controls";
import { SETTINGS } from "../definitions";
import { closeSettingsSheet, showSettingsSheet } from "../sheet";

// Where pages open (store/engines.ts): Chromium, or WebKit for sites whose protected video only plays there.

const ENGINE_OPTIONS: { value: PageEngine; title: string }[] = [
  { value: "chromium", title: ENGINE_NAMES.chromium },
  { value: "webkit", title: ENGINE_NAMES.webkit },
];

const siteLabel = (site: string) => site.replace(/^https:\/\//, "");

export function EnginesPane() {
  const engine = useBrowser((s) => defaultEngine(s));
  const rules = useBrowser((s) => s.settings.websiteEngines);
  const sites = Object.keys(rules ?? {}).sort((a, b) => siteLabel(a).localeCompare(siteLabel(b)));
  const setDefault = (value: PageEngine) => useBrowser.getState().updateSettings({ pageEngine: value });

  return (
    <View>
      <SectionHeader title="Default engine" />
      <Group>
        <Row settingId={SETTINGS.defaultEngine.id} title={SETTINGS.defaultEngine.title} description="New pages open here unless their site opens elsewhere.">
          <PopUp value={engine} options={ENGINE_OPTIONS} onChange={setDefault} />
        </Row>
        <Row title="Use Recommended Default" description="Chromium runs extensions and the ad blocker. Sites that need protected video still open in WebKit.">
          <Button title="Use Recommended" disabled={engine === RECOMMENDED_ENGINE} onPress={() => setDefault(RECOMMENDED_ENGINE)} />
        </Row>
        <SettingToggle
          setting="protectedVideoInWebKit"
          settingId={SETTINGS.protectedVideoInWebKit.id}
          title={SETTINGS.protectedVideoInWebKit.title}
          description={`Netflix, Disney+, Max, Prime Video, Hulu, Apple TV+, Spotify and others play their video only there. A website rule wins. (${PROTECTED_VIDEO_SITES.length} sites)`}
        />
      </Group>

      <SectionHeader
        settingId={SETTINGS.websiteEngines.id}
        title={SETTINGS.websiteEngines.title}
        description="Sites that always open in a chosen engine. Links a page opens stay on that page's engine."
        action={<Button title="Add…" icon="plus" onPress={() => showSettingsSheet(<RuleSheet />)} />}
      />
      <Group>
        {sites.length === 0 ? (
          <Row title="No website rules" description="Choose “Opens in” in a site's controls, or add a rule here." />
        ) : (
          sites.map((site) => <RuleRow key={site} site={site} engine={rules[site]!} />)
        )}
      </Group>

      <SectionHeader title="How engines differ" />
      <Group>
        <Row
          settingId={SETTINGS.engineSignIns.id}
          title={SETTINGS.engineSignIns.title}
          description="Each engine keeps its own cookies and site data in every space, so a site may ask you to sign in again in WebKit. Tabs, history and settings are shared."
        />
        <Row title="Extensions and ad blocking are Chromium only" description="WebKit pages run without extensions or the ad blocker for now." />
        <Row
          title="Passkeys"
          description="WebKit pages can't use passkeys until Apple grants Bay its browser passkey entitlement. Sign in with a passkey in Chromium meanwhile."
        />
      </Group>
    </View>
  );
}

function RuleRow({ site, engine }: { site: string; engine: PageEngine }) {
  return (
    <Row icon={<Favicon url={site} />} title={siteLabel(site)}>
      <PopUp value={engine} options={ENGINE_OPTIONS} onChange={(value) => setWebsiteEngine(site, value)} minWidth={110} />
      <IconButton icon="pencil" size={11} box={24} radius={6} onPress={() => showSettingsSheet(<RuleSheet site={site} engine={engine} />)} tooltip="Edit" />
      <IconButton icon="trash" size={11} box={24} radius={6} onPress={() => setWebsiteEngine(site, null)} tooltip="Remove" />
    </Row>
  );
}

function RuleSheet({ site, engine: initial }: { site?: string; engine?: PageEngine }) {
  const theme = useTheme();
  const [address, setAddress] = useState(site ? siteLabel(site) : "");
  const [engine, setEngine] = useState<PageEngine>(initial ?? "webkit");
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const typed = address.trim();
    const target = siteOf(/^[a-z][\w+.-]*:\/\//i.test(typed) ? typed : resolveInput(typed, ""));
    if (!target) return setError("Enter a website address, like netflix.com.");
    if (site && site !== target) setWebsiteEngine(site, null);
    setWebsiteEngine(target, engine);
    closeSettingsSheet();
  };
  return (
    <Sheet width={440} onClose={closeSettingsSheet}>
      <Text style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>{site ? "Edit Website Rule" : "Add Website Rule"}</Text>
      <Text style={{ fontSize: 12, marginTop: 6, color: theme.textSecondary }}>
        A rule matches the site's address exactly: its scheme, host and port. Subdomains need their own rule.
      </Text>
      <View style={{ marginTop: 12 }}>
        <Text style={{ fontSize: 11.5, marginBottom: 5, color: theme.textSecondary }}>Website</Text>
        <TextField value={address} onChangeText={setAddress} placeholder="netflix.com" autoFocus onSubmit={save} onEscape={closeSettingsSheet} />
      </View>
      <View style={{ marginTop: 12, flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={{ fontSize: 11.5, color: theme.textSecondary }}>Opens in</Text>
        <PopUp value={engine} options={ENGINE_OPTIONS} onChange={setEngine} />
      </View>
      {error && <Text style={{ fontSize: 12, marginTop: 10, color: "#FF453A" }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 18 }}>
        {site && (
          <Button
            title="Remove"
            kind="destructive"
            onPress={() => {
              setWebsiteEngine(site, null);
              closeSettingsSheet();
            }}
          />
        )}
        <View style={{ flex: 1 }} />
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title={site ? "Save" : "Add"} kind="primary" onPress={save} />
      </View>
    </Sheet>
  );
}
