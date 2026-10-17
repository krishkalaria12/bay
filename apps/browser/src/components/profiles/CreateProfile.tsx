import { Pressable, View } from "@bay/platform";
import { showMenu, Symbol } from "@bay/shell";
import { useMemo, useState } from "react";
import { Text } from "react-native";
import { create } from "zustand";
import { PROFILE_COLORS, useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { useWindowId } from "../../store/hooks";
import { dataGroups, unusedProfileColor } from "../../store/profiles";
import type { ProfileColor } from "../../store/types";
import { Button, Sheet, TextField, useFormColors } from "../settings/controls";
import { closeSettingsSheet, showSettingsSheet } from "../settings/sheet";
import { iconMenuItems, PROFILE_SYMBOLS, ProfileBadge, profileSymbol } from "./icons";

// The icons offered in a row (one row in the sheet, with the initial, a chosen other icon and More); the rest, and
// emoji, through More.
const QUICK_SYMBOLS = PROFILE_SYMBOLS.slice(0, 7).map((s) => `symbol:${s.name}`);

export type CreateProfilePreset = { name?: string; shareWith?: string };

type Request = { windowId: string; preset: CreateProfilePreset; resolve: (id: string | null) => void };

const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

export function requestCreateProfile(windowId?: string, preset: CreateProfilePreset = {}): Promise<string | null> {
  return new Promise((resolve) => {
    if (windowId && useBrowser.getState().windows[windowId]) {
      useRequest.getState().request?.resolve(null);
      useRequest.setState({ request: { windowId, preset, resolve } });
      return;
    }
    const done = (id: string | null) => {
      closeSettingsSheet();
      resolve(id);
    };
    showSettingsSheet(<CreateProfileSheet windowId={null} preset={preset} onDone={done} />);
  });
}

export function CreateProfileHost() {
  const windowId = useWindowId();
  const request = useRequest((r) => (r.request?.windowId === windowId ? r.request : null));
  if (!request) return null;
  const done = (id: string | null) => {
    useRequest.setState({ request: null });
    request.resolve(id);
  };
  return <CreateProfileSheet windowId={windowId} preset={request.preset} onDone={done} />;
}

export function profileNames(names: string[]): string {
  if (names.length <= 2) return names.join(" & ");
  return `${names.slice(0, 2).join(", ")}, & ${names.length - 2} more`;
}

function CreateProfileSheet({ windowId, preset, onDone }: { windowId: string | null; preset: CreateProfilePreset; onDone: (id: string | null) => void }) {
  const theme = useTheme();
  const colors = useFormColors();
  const profiles = useBrowser((s) => s.profiles);
  const profileOrder = useBrowser((s) => s.profileOrder);
  const groups = useMemo(() => dataGroups({ profiles, profileOrder }), [profiles, profileOrder]);
  const current = useBrowser((s) => (windowId && !s.windows[windowId]?.incognito ? s.windows[windowId]!.profileId : s.settings.defaultProfileId));
  const [name, setName] = useState(preset.name ?? "");
  const [color, setColor] = useState<ProfileColor>(() => unusedProfileColor(useBrowser.getState().profiles));
  const [icon, setIcon] = useState<string | null>(null);
  // As Arc: a new space uses the current space's profile (its logins and cookies) unless a new one is chosen.
  const [shareWith, setShareWith] = useState<string | null>(preset.shareWith ?? current);
  const selectedGroup = shareWith === null ? null : (groups.find((g) => g.profileIds.includes(shareWith)) ?? groups[0]);

  const submit = () => {
    const id = useBrowser.getState().createProfile({ name, color, icon, shareWith: selectedGroup?.profileIds[0] ?? null });
    onDone(id);
  };
  const moreIcons = async () => {
    const choice = await showMenu(iconMenuItems(icon));
    if (choice?.startsWith("icon:")) setIcon(choice.slice("icon:".length) || null);
  };

  return (
    <Sheet width={420} onClose={() => onDone(null)}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <ProfileBadge profile={{ name: name || "Space", color, icon }} size={30} />
        <Text style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>Create a Space</Text>
      </View>
      <Text style={{ fontSize: 12.5, lineHeight: 17, marginTop: 8, color: theme.textSecondary }}>
        Spaces keep their own tabs, pinned tabs and theme. Each uses a profile for its logins, cookies, passwords, extensions, bookmarks and history.
      </Text>

      <TextField value={name} onChangeText={setName} placeholder="Space name" autoFocus onSubmit={submit} onEscape={() => onDone(null)} style={{ marginTop: 16 }} />

      <Label>Icon</Label>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <IconChoice selected={!icon} tooltip="Initial" onPress={() => setIcon(null)}>
          <Text style={{ fontSize: 13, fontWeight: "700", color: theme.textPrimary }}>{(name.trim()[0] ?? "A").toUpperCase()}</Text>
        </IconChoice>
        {QUICK_SYMBOLS.map((s) => (
          <IconChoice key={s} selected={icon === s} tooltip={PROFILE_SYMBOLS.find((p) => `symbol:${p.name}` === s)?.title} onPress={() => setIcon(s)}>
            <Symbol name={profileSymbol(s)!} size={13} weight="semibold" color={theme.textPrimary} style={{ width: 16, height: 16 }} />
          </IconChoice>
        ))}
        {icon && !QUICK_SYMBOLS.includes(icon) ? (
          <IconChoice selected tooltip="Chosen icon" onPress={() => void moreIcons()}>
            {profileSymbol(icon) ? (
              <Symbol name={profileSymbol(icon)!} size={13} weight="semibold" color={theme.textPrimary} style={{ width: 16, height: 16 }} />
            ) : (
              <Text style={{ fontSize: 15 }}>{icon}</Text>
            )}
          </IconChoice>
        ) : null}
        <IconChoice selected={false} tooltip="More Icons and Emoji" onPress={() => void moreIcons()}>
          <Symbol name="ellipsis" size={13} weight="semibold" color={theme.textSecondary} style={{ width: 16, height: 16 }} />
        </IconChoice>
      </View>

      <Label>Theme</Label>
      <View style={{ flexDirection: "row", gap: 7 }}>
        {(Object.keys(PROFILE_COLORS) as ProfileColor[]).map((c) => (
          <Pressable key={c} onPress={() => setColor(c)} tooltip={PROFILE_COLORS[c].name}>
            <View style={{ width: 22, height: 22, borderRadius: 11, padding: 2, borderWidth: 2, borderColor: color === c ? PROFILE_COLORS[c].swatch : "transparent" }}>
              <View style={{ flex: 1, borderRadius: 9, backgroundColor: PROFILE_COLORS[c].swatch }} />
            </View>
          </Pressable>
        ))}
      </View>

      <Label>Profile</Label>
      <View style={{ borderRadius: 8, backgroundColor: colors.field, borderWidth: 1, borderColor: colors.fieldBorder, overflow: "hidden" }}>
        {groups.map((g, i) => (
          <Pressable key={g.dataId} onPress={() => setShareWith(g.profileIds[0]!)}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, height: 32, paddingHorizontal: 10, borderTopWidth: i ? 1 : 0, borderColor: colors.separator }}>
              <RadioDot on={g === selectedGroup} />
              <ColorStack colors={g.profileIds.map((id) => PROFILE_COLORS[profiles[id]!.color]?.swatch ?? "#888888")} />
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: theme.textPrimary }}>
                Same as {profileNames(g.profileIds.map((id) => profiles[id]!.name))}
              </Text>
            </View>
          </Pressable>
        ))}
        <Pressable onPress={() => setShareWith(null)}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, height: 32, paddingHorizontal: 10, borderTopWidth: 1, borderColor: colors.separator }}>
            <RadioDot on={!selectedGroup} />
            <Symbol name="person.crop.circle.badge.plus" size={12} color={theme.textSecondary} style={{ width: 14, height: 14 }} />
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: theme.textPrimary }}>New profile</Text>
          </View>
        </Pressable>
      </View>
      <Text style={{ fontSize: 11.5, lineHeight: 15, marginTop: 6, color: theme.textSecondary }}>
        {selectedGroup
          ? "Shares logins, cookies, passwords, extensions, bookmarks and history with those spaces. Tabs stay separate."
          : "Starts with its own logins, cookies, passwords, extensions, bookmarks and history."}
      </Text>

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

function IconChoice({ selected, tooltip, onPress, children }: { selected: boolean; tooltip?: string; onPress(): void; children: React.ReactNode }) {
  const colors = useFormColors();
  return (
    <Pressable onPress={onPress} tooltip={tooltip}>
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.field,
          borderWidth: selected ? 2 : 1,
          borderColor: selected ? colors.accent : colors.fieldBorder,
        }}
      >
        {children}
      </View>
    </Pressable>
  );
}

function RadioDot({ on }: { on: boolean }) {
  const colors = useFormColors();
  return (
    <View
      style={{
        width: 14,
        height: 14,
        borderRadius: 7,
        borderWidth: on ? 0 : 1,
        borderColor: colors.fieldBorder,
        backgroundColor: on ? colors.accent : colors.control,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {on && <Symbol name="circle.fill" size={6} color="#FFFFFF" style={{ width: 8, height: 8 }} />}
    </View>
  );
}

export function ColorStack({ colors: swatches, size = 12 }: { colors: string[]; size?: number }) {
  const theme = useTheme();
  const shown = swatches.slice(0, 4);
  return (
    <View style={{ flexDirection: "row", width: size + (shown.length - 1) * (size * 0.6) }}>
      {shown.map((c, i) => (
        <View
          key={i}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            marginLeft: i ? -size * 0.4 : 0,
            backgroundColor: c,
            borderWidth: 1,
            borderColor: theme.dark ? "rgba(0,0,0,0.35)" : "#FFFFFF",
          }}
        />
      ))}
    </View>
  );
}
