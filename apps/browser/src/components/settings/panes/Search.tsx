import { View } from "@bay/platform";
import { engineHost, POPULAR_SITE_SEARCHES, validateEngine, type EngineInput, type SearchEngine } from "@bay/core";
import { Symbol } from "@bay/shell";
import { useState } from "react";
import { Text } from "react-native";
import { reportBrowserCommand } from "../../../runtime/commands";
import { updateSettings, setSearchEngine, addCustomEngine, updateCustomEngine, removeCustomEngine } from "../../../runtime/settingsActions";
import { useBrowserRead } from "../../../store/read";
import { useTheme } from "../../../lib/theme";
import { controllingSearchExtension, defaultSearchEngine, searchEngines } from "../../../store/settings";
import { setEnabled } from "../../extensions/state";
import { Favicon, IconButton } from "../../primitives";
import { Button, Group, PopUp, Row, SectionHeader, Sheet, TextField, Toggle, useFormColors } from "../controls";
import { SETTINGS } from "../definitions";
import { closeSettingsSheet, showSettingsSheet } from "../sheet";
import { openSettings } from "../windows";

export function SearchPane() {
  const settings = useBrowserRead((s) => s.settings);
  const colors = useFormColors();
  const engines = searchEngines(settings);
  const builtIn = engines.filter((e) => !e.custom && !e.extension);
  const custom = engines.filter((e) => e.custom);
  const fromExtensions = engines.filter((e) => e.extension);
  const selectedId = defaultSearchEngine(settings).id;
  const controlling = controllingSearchExtension(settings);
  const locked = !!controlling;
  const duckduckgo = settings.searchShortcutMode === "duckduckgo";
  const customKeywords = new Set(custom.map((e) => e.keyword.toLowerCase()));
  const common = POPULAR_SITE_SEARCHES.filter(
    (site, index, sites) => site.keyword && !customKeywords.has(site.keyword) && sites.findIndex((s) => s.keyword === site.keyword) === index,
  );

  return (
    <View>
      <SectionHeader title="Search shortcuts" />
      <Group>
        <Row
          settingId={SETTINGS.searchShortcutMode.id}
          title={SETTINGS.searchShortcutMode.title}
          description={
            duckduckgo
              ? "Type !shortcut followed by your query, like !yt funny cats. Your default search engine stays the same."
              : "Type a shortcut, press Tab, then enter your query, like yt → Tab → funny cats."
          }
        >
          <PopUp
            value={settings.searchShortcutMode}
            options={[
              { value: "arc", title: "Arc-style" },
              { value: "duckduckgo", title: "DuckDuckGo-style" },
            ]}
            onChange={(v) => reportBrowserCommand(updateSettings({ searchShortcutMode: v }))}
            minWidth={160}
          />
        </Row>
      </Group>

      <SectionHeader settingId={SETTINGS.searchEngine.id} title={SETTINGS.searchEngine.title} description="Used by the command bar and the New Tab page." />
      <Group>
        {controlling && (
          <Row
            icon={<Symbol name="puzzlepiece.extension" size={13} color={colors.accent} style={{ width: 18, height: 18 }} />}
            title={`${controlling.extensionName || "An extension"} is controlling this setting`}
            description="To change your default search engine, disable the extension or manage its settings."
          >
            <Button title="Manage" onPress={() => openSettings("extensions")} />
            <Button title="Disable" onPress={() => void setEnabled(controlling.profile, controlling.extensionId, false)} />
          </Row>
        )}
        {builtIn.map((e) => (
          <EngineRow key={e.id} engine={e} selected={selectedId === e.id} locked={locked} />
        ))}
      </Group>

      <SectionHeader
        settingId={SETTINGS.otherSearchEngines.id}
        title={SETTINGS.otherSearchEngines.title}
        description={
          duckduckgo
            ? "Custom shortcuts work as bangs: a shortcut named yt becomes !yt. Custom shortcuts override matching built-in bangs."
            : "Configure shortcuts here for either mode. Type a shortcut and press Tab to search a site directly."
        }
        action={<Button title="Add…" icon="plus" onPress={() => showSettingsSheet(<EngineSheet />)} />}
      />
      <Group>
        {custom.length === 0 ? (
          <Row title="No custom search engines" description="Add one with a URL where %s stands for the search terms." />
        ) : (
          custom.map((e) => <EngineRow key={e.id} engine={e} selected={selectedId === e.id} locked={locked} editable={e.id !== "custom"} />)
        )}
      </Group>

      {common.length > 0 && (
        <>
          <SectionHeader title="Common shortcuts" description="Edit one to save a custom shortcut with your own search URL." />
          <Group>
            {common.map((site) => (
              <Row
                key={site.host}
                icon={<Favicon url={`https://${site.host}`} />}
                title={site.name}
                description={duckduckgo ? `!${site.keyword} query` : `${site.keyword} → Tab → query`}
              >
                <Button title="Edit…" onPress={() => showSettingsSheet(<EngineSheet preset={{ name: site.name, keyword: site.keyword!, url: site.url }} />)} />
              </Row>
            ))}
          </Group>
        </>
      )}

      {fromExtensions.length > 0 && (
        <>
          <SectionHeader title="Extensions" description="Some extensions can add search engines to Bay." />
          <Group>
            {fromExtensions.map((e) => (
              <EngineRow key={e.id} engine={e} selected={selectedId === e.id} locked={locked} />
            ))}
          </Group>
        </>
      )}

      <SectionHeader title="Suggestions" />
      <Group>
        <Row
          settingId={SETTINGS.searchSuggestions.id}
          title={SETTINGS.searchSuggestions.title}
          description="Sends what you type to your search engine to suggest searches."
        >
          <Toggle value={settings.searchSuggestions} onChange={(v) => reportBrowserCommand(updateSettings({ searchSuggestions: v }))} />
        </Row>
      </Group>
      <SectionHeader title="Command bar" />
      <Group>
        <Row
          settingId={SETTINGS.calculatorEnabled.id}
          title={SETTINGS.calculatorEnabled.title}
          description="Show answers for math, unit conversions and currency conversions. Currency rates require an internet connection."
        >
          <Toggle value={settings.calculatorEnabled} onChange={(v) => reportBrowserCommand(updateSettings({ calculatorEnabled: v }))} />
        </Row>
      </Group>
    </View>
  );
}

function EngineRow({ engine, selected, locked, editable }: { engine: SearchEngine; selected: boolean; locked: boolean; editable?: boolean }) {
  const theme = useTheme();
  const colors = useFormColors();
  const duckduckgo = useBrowserRead((s) => s.settings.searchShortcutMode === "duckduckgo");
  const shortcutError = engine.custom ? validateEngine(engine, []) : null;
  const description = engine.extension
    ? `${engine.keyword ? `${engine.keyword} · ` : ""}Added by ${engine.extension.name || "an extension"}`
    : engine.custom
      ? `${duckduckgo ? "!" : ""}${engine.keyword.replace(/^!/, "")} · ${shortcutError ?? engine.url}`
      : engine.keyword;
  return (
    <Row icon={<Favicon url={`https://${engineHost(engine)}`} />} title={engine.name} description={description}>
      {editable && <IconButton icon="pencil" size={11} box={24} radius={6} onPress={() => showSettingsSheet(<EngineSheet engine={engine} />)} tooltip="Edit" />}
      {selected ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, minWidth: 92, justifyContent: "flex-end" }}>
          <Symbol name="checkmark" size={11} weight="semibold" color={colors.accent} style={{ width: 14, height: 14 }} />
          <Text style={{ fontSize: 12, color: theme.textSecondary }}>Default</Text>
        </View>
      ) : (
        <Button title="Make Default" disabled={locked} onPress={() => reportBrowserCommand(setSearchEngine(engine.id))} style={{ minWidth: 92 }} />
      )}
    </Row>
  );
}

function EngineSheet({ engine, preset }: { engine?: SearchEngine; preset?: EngineInput }) {
  const theme = useTheme();
  const initial = engine ?? preset;
  const [name, setName] = useState(initial?.name ?? "");
  const [keyword, setKeyword] = useState(initial?.keyword ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const input = { name, keyword, url };
    setError(null);
    try {
      if (engine) await updateCustomEngine(engine.id, input);
      else await addCustomEngine(input);
      closeSettingsSheet();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save the search engine.");
    }
  };
  const remove = async () => {
    if (!engine) return;
    setError(null);
    try {
      await removeCustomEngine(engine.id);
      closeSettingsSheet();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't delete the search engine.");
    }
  };
  const field = (label: string, value: string, set: (v: string) => void, placeholder: string) => (
    <View style={{ marginTop: 12 }}>
      <Text style={{ fontSize: 11.5, marginBottom: 5, color: theme.textSecondary }}>{label}</Text>
      <TextField value={value} onChangeText={set} placeholder={placeholder} onSubmit={save} onEscape={closeSettingsSheet} />
    </View>
  );
  return (
    <Sheet width={440} onClose={closeSettingsSheet}>
      <Text style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>
        {engine ? "Edit Search Engine" : preset ? "Customize Search Shortcut" : "Add Search Engine"}
      </Text>
      {field("Name", name, setName, "Wikipedia")}
      {field("Shortcut", keyword, setKeyword, "w")}
      <Text style={{ fontSize: 11.5, marginTop: 5, color: theme.textSecondary }}>
        Enter the shortcut without !. For example, yt works as !yt in DuckDuckGo-style mode.
      </Text>
      {field("URL with %s in place of the query", url, setUrl, "https://en.wikipedia.org/w/index.php?search=%s")}
      {error && <Text style={{ fontSize: 12, marginTop: 10, color: "#FF453A" }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 18 }}>
        {engine && <Button title="Delete" kind="destructive" onPress={() => void remove()} />}
        <View style={{ flex: 1 }} />
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title={engine ? "Save" : "Add"} kind="primary" onPress={save} />
      </View>
    </Sheet>
  );
}
