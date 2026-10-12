import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { create } from "zustand";
import { SPACE_COLORS, useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { useWindowId } from "../../store/hooks";
import { SPACE_LOOKS, themeOfColor, unusedSpaceLook } from "../../store/spaces";
import type { SpaceColor } from "../../store/types";
import { Button, Sheet, TextField, useFormColors } from "../settings/controls";
import { closeSettingsSheet, showSettingsSheet } from "../settings/sheet";
import { CREATE_SPACE_ICON_COLUMNS } from "./constants";
import { SpaceBadge, SPACE_EMOJI, unusedSpaceIcon } from "./icons";
import { NewSpacePanel } from "./NewSpace";

export type CreateSpacePreset = { name?: string };

type Request = { windowId: string; preset: CreateSpacePreset; resolve: (id: string | null) => void; key: number };

const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

export function requestCreateSpace(windowId?: string, preset: CreateSpacePreset = {}): Promise<string | null> {
  return new Promise((resolve) => {
    if (windowId && useBrowser.getState().windows[windowId]) {
      useRequest.getState().request?.resolve(null);
      useRequest.setState({ request: { windowId, preset, resolve, key: Date.now() } });
      return;
    }
    const done = (id: string | null) => {
      closeSettingsSheet();
      resolve(id);
    };
    showSettingsSheet(<CreateSpaceSheet preset={preset} onDone={done} />);
  });
}

export function CreateSpaceHost() {
  const windowId = useWindowId();
  const request = useRequest((r) => (r.request?.windowId === windowId ? r.request : null));
  if (!request) return null;
  const done = (id: string | null) => {
    useRequest.setState({ request: null });
    request.resolve(id);
  };
  // In a window: yab's panel at the sidebar's foot. (Settings, which has no sidebar, keeps the sheet.)
  return <NewSpacePanel key={request.key} windowId={windowId} presetName={request.preset.name} onDone={done} />;
}

function CreateSpaceSheet({ preset, onDone }: { preset: CreateSpacePreset; onDone: (id: string | null) => void }) {
  const theme = useTheme();
  const colors = useFormColors();
  const [name, setName] = useState(preset.name ?? "");
  const [look, setLook] = useState(() => unusedSpaceLook(useBrowser.getState().spaces));
  const [icon, setIcon] = useState(() => unusedSpaceIcon(useBrowser.getState().spaces));

  const submit = () => {
    const id = useBrowser.getState().createSpace({ name, color: look.color, theme: look.theme, icon });
    onDone(id);
  };

  return (
    <Sheet width={420} onClose={() => onDone(null)}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <SpaceBadge profile={{ name: name || "Space", color: look.color, theme: look.theme, icon }} size={30} />
        <Text style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>Create a Space</Text>
      </View>
      <Text style={{ fontSize: 12.5, lineHeight: 17, marginTop: 8, color: theme.textSecondary }}>
        Each space has its own tabs, pinned tabs, theme, history, logins, cookies, passwords, extensions and bookmarks.
      </Text>

      <TextField
        value={name}
        onChangeText={setName}
        placeholder="Space name"
        autoFocus
        onSubmit={submit}
        onEscape={() => onDone(null)}
        style={{ marginTop: 16 }}
      />

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Label>Icon</Label>
      </View>
      {/* The space emoji (the sidebar's space panel has the same): a random free one is chosen to start with. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", width: CREATE_SPACE_ICON_COLUMNS * 30 }}>
        {SPACE_EMOJI.map((e) => (
          <Pressable key={e} onPress={() => setIcon(e)} accessibilityLabel={e}>
            {({ pressed }) => (
              <View
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: e === icon || pressed ? colors.selected : undefined,
                }}
              >
                <Text style={{ fontSize: 19 }}>{e}</Text>
              </View>
            )}
          </Pressable>
        ))}
      </View>

      <Label>Theme</Label>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
        {[...SPACE_LOOKS, ...(Object.keys(SPACE_COLORS) as SpaceColor[]).map((c) => ({ name: SPACE_COLORS[c].name, ...themeOfColor(c) }))].map((l) => {
          const on = l.theme.colors.join() === look.theme.colors.join();
          return (
            <Pressable key={l.name} onPress={() => setLook({ color: l.color, theme: l.theme })} tooltip={l.name}>
              <View style={{ width: 22, height: 22, borderRadius: 11, padding: 2, borderWidth: 2, borderColor: on ? l.theme.colors[0] : "transparent" }}>
                <View style={{ flex: 1, borderRadius: 9, overflow: "hidden", flexDirection: "row" }}>
                  {l.theme.colors.map((c) => (
                    <View key={c} style={{ flex: 1, backgroundColor: c }} />
                  ))}
                </View>
              </View>
            </Pressable>
          );
        })}
      </View>

      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Button title="Cancel" onPress={() => onDone(null)} />
        <Button title="Create Space" kind="primary" onPress={submit} />
      </View>
    </Sheet>
  );
}

function Label({ children }: { children: string }) {
  const theme = useTheme();
  return <Text style={{ fontSize: 12, fontWeight: "600", color: theme.textSecondary, marginTop: 16, marginBottom: 7 }}>{children}</Text>;
}
