import { View } from "@bay/platform";
import type { PluginManifest, PluginSetting } from "@bay/chromium";
import { Symbol } from "@bay/desktop";
import { useState } from "react";
import * as v from "valibot";
import { Text } from "react-native";
import { switchedOff, useKillSwitches } from "../../../lib/killSwitches";
import { platformWords } from "../../../lib/platformWords";
import {
  addPlugin,
  deletePluginEverywhere,
  enablePlugin,
  pluginSummary,
  reloadPluginList,
  savePluginSecret,
  savePluginSetting,
  showPluginsFolder,
} from "../../../lib/plugins/pluginActions";
import { usePlugins, type PluginEntry } from "../../../lib/plugins/pluginStore";
import { useTheme } from "../../../lib/theme";
import { Button, Group, PopUp, Row, SectionHeader, Sheet, TextField, Toggle } from "../controls";
import { SETTINGS } from "../definitions";
import { closeSettingsSheet, showSettingsSheet } from "../sheet";

// Settings › Plugins (lib/plugins): the plugins in Bay's plugins folder, each on or off, its settings (secrets in the
// system's keychain), and the folders there Bay can't run.

function statusText(entry: PluginEntry): string {
  if (!entry.enabled) return entry.manifest.description || "Off";

  switch (entry.status) {
    case "starting":
      return "Starting…";
    case "failed":
      return entry.error ?? "Stopped";
    case "off":
      return entry.error ?? "Off";
    default:
      return entry.error ? `On · last error: ${entry.error}` : entry.manifest.description || "On";
  }
}

export function PluginsPane() {
  const { plugins, problems, loaded } = usePlugins();
  const halted = useKillSwitches(() => switchedOff("plugins"));
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);

    try {
      await addPlugin();
    } catch {}

    setBusy(false);
  };

  return (
    <>
      <SectionHeader
        settingId={SETTINGS.plugins.id}
        title="Plugins"
        description="A plugin is a folder with a manifest.json and a script. Bay runs each in a page of its own, apart from your pages, and it reaches only what its manifest asks for."
        action={
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Button title={`Show in ${platformWords.fileManager}`} onPress={() => void showPluginsFolder()} />
            <Button title="Add Plugin…" kind="primary" disabled={busy || halted} onPress={() => void add()} />
          </View>
        }
      />
      {halted ? (
        <Group>
          <Row title="Bay turned plugins off for this release" description="Settings › Advanced says why. They start again when Bay turns them back on." />
        </Group>
      ) : null}
      <Group>
        {plugins.length ? (
          plugins.map((entry) => <PluginRow key={entry.manifest.id} entry={entry} />)
        ) : (
          <Row
            title={loaded ? "No plugins yet" : "Loading…"}
            description="Add a plugin's folder to try it. Bay keeps a copy, so changing the original changes nothing until you add it again."
          />
        )}
      </Group>
      {problems.length ? (
        <>
          <SectionHeader
            title="Folders Bay Can't Run"
            description="These folders in the plugins folder aren't plugins this Bay reads."
            action={<Button title="Check Again" onPress={() => void reloadPluginList()} />}
          />
          <Group>
            {problems.map((p) => (
              <Row key={p.folder} title={p.folder} description={p.error} />
            ))}
          </Group>
        </>
      ) : null}
    </>
  );
}

function PluginRow({ entry }: { entry: PluginEntry }) {
  const theme = useTheme();
  const { manifest } = entry;

  return (
    <Row
      icon={<Symbol name="puzzlepiece.extension" size={14} color={theme.textSecondary} style={{ width: 20, height: 20 }} />}
      title={`${manifest.name} ${manifest.version}`}
      description={statusText(entry)}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Button title="Details…" onPress={() => showSettingsSheet(<PluginSheet id={manifest.id} />)} />
        <Toggle value={entry.enabled} onChange={(on) => void enablePlugin(manifest.id, on)} />
      </View>
    </Row>
  );
}

function PluginSheet({ id }: { id: string }) {
  const theme = useTheme();
  const entry = usePlugins((s) => s.plugins.find((p) => p.manifest.id === id));

  if (!entry) return null;
  const { manifest } = entry;

  const remove = () => {
    closeSettingsSheet();
    void deletePluginEverywhere(id);
  };

  return (
    <Sheet width={460} onClose={closeSettingsSheet}>
      <Text style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>
        {manifest.name} {manifest.version}
      </Text>
      <Text style={{ fontSize: 12, marginTop: 4, lineHeight: 16, color: theme.textSecondary }}>
        {[manifest.description, manifest.author ? `By ${manifest.author}` : ""].filter(Boolean).join(" · ")}
      </Text>
      <Text style={{ fontSize: 12, marginTop: 12, fontWeight: "600", color: theme.textPrimary }}>It can</Text>
      {pluginSummary(manifest).map((line) => (
        <Text key={line} style={{ fontSize: 12, marginTop: 3, lineHeight: 16, color: theme.textSecondary }}>
          • {line}
        </Text>
      ))}
      {manifest.settings.length ? (
        <Group style={{ marginTop: 14 }}>
          {manifest.settings.map((setting) => (
            <SettingRow key={setting.key} manifest={manifest} setting={setting} />
          ))}
        </Group>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 18 }}>
        <Button title="Remove Plugin" kind="destructive" onPress={remove} />
        <View style={{ flex: 1 }} />
        <Button title="Done" kind="primary" onPress={closeSettingsSheet} />
      </View>
    </Sheet>
  );
}

function SettingRow({ manifest, setting }: { manifest: PluginManifest; setting: PluginSetting }) {
  const saved = usePlugins((s) => s.settings[manifest.id]?.[setting.key]);
  const secretSet = usePlugins((s) => !!s.secrets[manifest.id]?.includes(setting.key));
  const value = saved ?? setting.default;
  const [draft, setDraft] = useState(v.is(v.string(), value) ? value : "");
  const save = (next: string | boolean) => void savePluginSetting(manifest.id, setting.key, next).catch(() => {});

  if (setting.type === "toggle")
    return (
      <Row title={setting.title} description={setting.description}>
        <Toggle value={value === true} onChange={save} />
      </Row>
    );

  if (setting.type === "choice")
    return (
      <Row title={setting.title} description={setting.description}>
        <PopUp value={String(value)} options={setting.options.map((o) => ({ value: o.value, title: o.title }))} onChange={save} />
      </Row>
    );

  if (setting.type === "secret")
    return (
      <Row title={setting.title} description={setting.description ?? (secretSet ? `Kept in ${platformWords.secretStore}` : "Not set")}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <TextField
            value={draft}
            secure
            placeholder={secretSet ? "••••••••" : "Paste it here"}
            onChangeText={setDraft}
            onSubmit={() => draft && void savePluginSecret(manifest.id, setting.key, draft).then(() => setDraft(""))}
            style={{ width: 150 }}
          />
          {secretSet ? <Button title="Forget" onPress={() => void savePluginSecret(manifest.id, setting.key, null)} /> : null}
          <Button title="Save" disabled={!draft} onPress={() => void savePluginSecret(manifest.id, setting.key, draft).then(() => setDraft(""))} />
        </View>
      </Row>
    );

  return (
    <Row title={setting.title} description={setting.description}>
      <TextField value={draft} onChangeText={setDraft} onSubmit={() => save(draft)} onBlur={() => draft !== value && save(draft)} style={{ width: 180 }} />
    </Row>
  );
}
