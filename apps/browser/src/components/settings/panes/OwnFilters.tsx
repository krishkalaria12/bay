import { TextInput, View } from "@bay/platform";
import {
  addFilterList,
  canAddFilterLists,
  getUserFilters,
  MY_FILTERS_ID,
  removeFilterList,
  setContentBlockerEnabled,
  setFilterListEnabled,
  setUserFilters,
  type ContentBlockerState,
} from "@bay/chromium";
import { openTextFile, saveTextFile } from "@bay/desktop";
import { useEffect, useState } from "react";
import { StyleSheet, Text } from "react-native";
import { MONO_FONT } from "../../../lib/constants";
import { useTheme } from "../../../lib/theme";
import { Favicon, IconButton } from "../../ui/primitives";
import { Button, Checkbox, Group, Row, SectionHeader, Sheet, TextField, useFormColors } from "../controls";
import { SETTINGS } from "../definitions";
import { closeSettingsSheet, showSettingsSheet } from "../sheet";

// The person's own lists and rules (Settings › Privacy): lists added by URL, updated with the built-in ones, and My
// Filters, rules in adblock syntax. bay-lists keeps both (packages/rust/bay-lists), so every platform has them, and
// WebKit pages get them too.

const filtersText = (n: number) => `${n.toLocaleString()} ${n === 1 ? "filter" : "filters"}`;

export function OwnFilters({ blocker, refresh }: { blocker: ContentBlockerState | null; refresh: () => void }) {
  if (!canAddFilterLists()) return null;
  const custom = blocker?.lists.flatMap((l) => (l.category === "custom" && l.url ? [{ ...l, url: l.url }] : [])) ?? [];
  const mine = blocker?.lists.find((l) => l.id === MY_FILTERS_ID);

  const toggle = async (id: string, on: boolean) => {
    await setFilterListEnabled(id, on);

    if (on && blocker && !blocker.enabled) await setContentBlockerEnabled(true);
  };

  return (
    <>
      <SectionHeader
        settingId={SETTINGS.ownFilterLists.id}
        title={SETTINGS.ownFilterLists.title}
        description="Lists you add update with the built-in ones."
        action={<Button title="Add List…" icon="plus" disabled={!blocker} onPress={() => showSettingsSheet(<AddListSheet onDone={refresh} />)} />}
      />
      <Group>
        {custom.map((l) => (
          <Row
            key={l.id}
            icon={<Favicon url={l.url} />}
            title={<Checkbox value={l.enabled} onChange={(on) => void toggle(l.id, on).finally(refresh)} label={l.title} />}
            description={`${l.url} · ${filtersText(l.filters)}`}
          >
            <IconButton icon="trash" size={11} box={24} radius={6} tooltip="Remove" onPress={() => void removeFilterList(l.id).finally(refresh)} />
          </Row>
        ))}
        <Row
          settingId={SETTINGS.myFilters.id}
          title={SETTINGS.myFilters.title}
          description={mine?.enabled ? filtersText(mine.filters) : "Your own rules, in the same syntax as the lists."}
        >
          <Button title="Edit…" disabled={!blocker} onPress={() => showSettingsSheet(<MyFiltersSheet onDone={refresh} />)} />
        </Row>
      </Group>
    </>
  );
}

function AddListSheet({ onDone }: { onDone: () => void }) {
  const theme = useTheme();
  const colors = useFormColors();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const add = async () => {
    if (!/^https?:\/\/\S+$/i.test(url.trim())) return setError("Enter the list's address, starting with https://.");
    setAdding(true);
    setError(null);

    try {
      await addFilterList(url.trim(), title.trim());
      onDone();
      closeSettingsSheet();
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "Couldn't add the list.");
      onDone();
    } finally {
      setAdding(false);
    }
  };

  return (
    <Sheet width={460} onClose={closeSettingsSheet}>
      <Text style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>Add Filter List</Text>
      <Text style={{ fontSize: 11.5, marginTop: 12, marginBottom: 5, color: theme.textSecondary }}>Address</Text>
      <TextField
        value={url}
        onChangeText={setUrl}
        placeholder="https://example.com/filters.txt"
        onSubmit={() => void add()}
        onEscape={closeSettingsSheet}
        autoFocus
      />
      <Text style={{ fontSize: 11.5, marginTop: 12, marginBottom: 5, color: theme.textSecondary }}>Name (optional)</Text>
      <TextField value={title} onChangeText={setTitle} placeholder="My list" onSubmit={() => void add()} onEscape={closeSettingsSheet} />
      <Text style={{ fontSize: 11.5, marginTop: 10, lineHeight: 15, color: error ? colors.destructive : theme.textTertiary }}>
        {error ?? "Lists in adblock (uBlock Origin, AdGuard) syntax. Only add lists you trust: a list decides what pages can load."}
      </Text>
      <View style={{ flexDirection: "row", gap: 8, marginTop: 18 }}>
        <View style={{ flex: 1 }} />
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title={adding ? "Adding…" : "Add"} kind="primary" disabled={adding} onPress={() => void add()} />
      </View>
    </Sheet>
  );
}

function MyFiltersSheet({ onDone }: { onDone: () => void }) {
  const theme = useTheme();
  const colors = useFormColors();
  const [text, setText] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    void getUserFilters()
      .then((saved) => live && setText(saved))
      .catch(() => live && setText(""));

    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    if (text === null) return;
    setSaving(true);

    try {
      await setUserFilters(text);
      onDone();
      closeSettingsSheet();
    } catch (failure) {
      setStatus(failure instanceof Error && failure.message ? failure.message : "Couldn't save your filters.");
    } finally {
      setSaving(false);
    }
  };

  const importFile = async () => {
    const imported = await openTextFile(["txt"]).catch(() => null);

    if (imported) setText((current) => [current ?? "", imported].filter((part) => part.trim()).join("\n"));
  };

  const exportFile = async () => {
    const saved = await saveTextFile("Bay filters.txt", text ?? "").catch(() => false);
    setStatus(saved ? "Exported." : null);
  };

  return (
    <Sheet width={560} onClose={closeSettingsSheet}>
      <Text style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>My Filters</Text>
      <Text style={{ fontSize: 12, marginTop: 4, lineHeight: 16, color: theme.textSecondary }}>
        One rule a line, in adblock syntax: ||ads.example.com^ blocks a host, example.com##.banner hides an element, @@||example.com^ allows one.
      </Text>
      <View
        style={{
          marginTop: 12,
          height: 260,
          borderRadius: 7,
          padding: 8,
          backgroundColor: colors.field,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: colors.fieldBorder,
        }}
      >
        <TextInput
          value={text ?? ""}
          editable={text !== null}
          onChangeText={setText}
          multiline
          autoFocus
          placeholder="||ads.example.com^"
          placeholderTextColor={theme.textTertiary}
          selectionColor={theme.selection}
          enableFocusRing={false}
          autoCorrect={false}
          spellCheck={false}
          style={{ flex: 1, fontSize: 12, lineHeight: 17, color: theme.textPrimary, fontFamily: MONO_FONT }}
        />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14 }}>
        <Button title="Import…" onPress={() => void importFile()} />
        <Button title="Export…" disabled={!text} onPress={() => void exportFile()} />
        <Text style={{ flex: 1, fontSize: 11.5, color: theme.textTertiary }}>{status ?? ""}</Text>
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title={saving ? "Saving…" : "Save"} kind="primary" disabled={saving || text === null} onPress={() => void save()} />
      </View>
    </Sheet>
  );
}
