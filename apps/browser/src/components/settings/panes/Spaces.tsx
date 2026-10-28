import { ContextMenuArea, showMenu, Symbol } from "@bay/shell";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { createSpace, deleteSpace } from "../../../lib/actions";
import { hex, SPACE_COLORS, useTheme } from "../../../lib/theme";
import { useBrowser, type BrowserState } from "../../../store/browser";
import { useSpaces } from "../../../store/hooks";
import { plural, resolveWindowId } from "../../../store/model";
import type { Space, SpaceColor } from "../../../store/types";
import { ClearDataDialog } from "../../pages/ClearDataDialog";
import { useHover } from "../../primitives";
import { IconGrid } from "../../IconGrid";
import { SpaceBadge, SPACE_SYMBOLS, spaceIconTitle } from "../../spaces/icons";
import { useSpaceDrag, useSpaceReorder, type SpaceReorder } from "../../spaces/reorder";
import { openThemeEditor } from "../../spaces/ThemeEditor";
import { Button, Group, PopUp, Row, SectionHeader, TextField, useFormColors } from "../controls";
import { SETTINGS } from "../definitions";
import { closeSettingsSheet, showSettingsSheet } from "../sheet";
import { useSettingsNav } from "../windows";
import { CLEAN_UP_CHOICES, PROFILE_ROW_HEIGHT, SPACE_PANE_ICON_COLUMNS } from "../constants";

const cleanUpTitle = (hours: number) => CLEAN_UP_CHOICES.find((c) => c.value === String(hours))?.title ?? plural(hours, "hour");

// A space's clean-up time as its menu has it: the app's setting ("app", unset), "never" (null), or hours.
function cleanUpChoice(hours: number | null | undefined): string {
  if (hours === undefined) return "app";
  if (hours === null) return "never";
  return String(hours);
}

function cleanUpHoursOf(choice: string): number | null | undefined {
  if (choice === "app") return undefined;
  if (choice === "never") return null;
  return Number(choice);
}

export function SpacesPane() {
  const theme = useTheme();
  const spaces = useSpaces();
  const defaultId = useBrowser((s) => s.settings.defaultSpaceId);

  return (
    <View>
      <Text style={{ marginTop: 20, fontSize: 12.5, lineHeight: 17, color: theme.textSecondary }}>
        Each space has its own browsing profile, with separate tabs, pinned tabs, history, logins, cookies, passwords, extensions and bookmarks. Its icon and
        theme help you tell it apart.
      </Text>

      <SectionHeader title="New windows open with" />
      <Group>
        <Row settingId={SETTINGS.defaultSpaceId.id} title={SETTINGS.defaultSpaceId.title} description="Used for new windows.">
          <PopUp
            value={defaultId}
            options={spaces.map((p) => ({ value: p.id, title: p.name }))}
            onChange={(id) => useBrowser.getState().setDefaultSpace(id)}
            minWidth={160}
          />
        </Row>
      </Group>

      <SectionHeader
        title="Spaces"
        description="Drag to reorder. ⌃1–⌃9 switch to the first nine."
        action={<Button title="Create Space" icon="plus" onPress={() => void createSpace()} />}
      />
      <SpaceList />
    </View>
  );
}

function SpaceList() {
  const colors = useFormColors();
  const order = useBrowser((s) => s.spaceOrder);
  const { reorder, dragging } = useSpaceReorder(PROFILE_ROW_HEIGHT);

  return (
    <View style={{ borderRadius: 10, backgroundColor: colors.group, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: colors.groupBorder }}>
      {order.map((id, i) => (
        <SpaceRow key={id} spaceId={id} first={i === 0} offset={reorder.offsetOf(id)} lifted={dragging === id} reorder={reorder} />
      ))}
    </View>
  );
}

function SpaceRow({
  spaceId,
  first,
  offset,
  lifted,
  reorder,
}: {
  spaceId: string;
  first: boolean;
  offset: SharedValue<number>;
  lifted: boolean;
  reorder: SpaceReorder;
}) {
  const theme = useTheme();
  const colors = useFormColors();
  const profile = useBrowser((s) => s.spaces[spaceId]);
  const isDefault = useBrowser((s) => s.settings.defaultSpaceId === spaceId);
  const { hovered, hoverProps } = useHover();
  const go = useSettingsNav((n) => n.go);
  const panHandlers = useSpaceDrag(reorder, spaceId, "y");
  const offsetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: offset.get() }] }), [offset]);
  if (!profile) return null;

  const description = isDefault ? "Default" : null;
  const openMenu = async () => {
    const s = useBrowser.getState();
    const choice = await showMenu([
      { id: "details", title: "Show Space Details" },
      { id: "default", title: "Make Default Space", enabled: !isDefault },
      { separator: true },
      { id: "delete", title: "Delete Space…", enabled: s.spaceOrder.length > 1 },
    ]);
    if (choice === "details") go("spaces", spaceId);
    else if (choice === "default") s.setDefaultSpace(spaceId);
    else if (choice === "delete") void deleteSpace(spaceId);
  };

  return (
    <Animated.View
      {...panHandlers}
      style={[
        {
          zIndex: lifted ? 1 : 0,
          borderRadius: lifted ? 8 : 0,
          backgroundColor: lifted ? hex(theme.panel) : undefined,
          borderWidth: lifted ? StyleSheet.hairlineWidth * 2 : 0,
          borderColor: colors.groupBorder,
        },
        offsetStyle,
      ]}
    >
      {!first && !lifted && <View style={{ height: StyleSheet.hairlineWidth * 2, marginHorizontal: 12, backgroundColor: colors.separator }} />}
      <ContextMenuArea onContextMenu={() => void openMenu()}>
        <View {...hoverProps}>
          <Pressable onPress={() => go("spaces", spaceId)}>
            <View
              style={{
                height: PROFILE_ROW_HEIGHT - (first ? 0 : StyleSheet.hairlineWidth * 2),
                paddingLeft: 8,
                paddingRight: 12,
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                backgroundColor: hovered && !lifted ? colors.selected : undefined,
              }}
            >
              <View tooltip="Drag to reorder">
                <Symbol name="line.3.horizontal" size={11} color={theme.textTertiary} style={{ width: 14, height: 14 }} />
              </View>
              <SpaceBadge profile={profile} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, color: theme.textPrimary }}>{profile.name}</Text>
                {description ? <Text style={{ fontSize: 11.5, marginTop: 2, color: theme.textSecondary }}>{description}</Text> : null}
              </View>
              <Symbol name="chevron.right" size={11} weight="semibold" color={theme.textTertiary} style={{ width: 12, height: 14 }} />
            </View>
          </Pressable>
        </View>
      </ContextMenuArea>
    </Animated.View>
  );
}

function bookmarkCount(s: BrowserState, spaceId: string): number {
  const roots = s.bookmarks.roots[spaceId];
  let count = 0;
  const walk = (id: string) => {
    const n = s.bookmarks.nodes[id];
    if (n?.kind === "url") count++;
    if (n?.kind === "folder") n.children.forEach(walk);
  };
  if (roots) [roots.bar, roots.other].forEach(walk);
  return count;
}

export function SpaceDetailsPane({ spaceId }: { spaceId: string }) {
  const theme = useTheme();
  const profile = useBrowser((s) => s.spaces[spaceId]);
  const isDefault = useBrowser((s) => s.settings.defaultSpaceId === spaceId);
  const only = useBrowser((s) => s.spaceOrder.length <= 1);
  const appCleanUp = useBrowser((s) => s.settings.cleanUpInactiveTabsAfterHours);
  const stats = useBrowser((s) => `${plural((s.history[spaceId] ?? []).length, "page")} in history · ${plural(bookmarkCount(s, spaceId), "bookmark")}`);
  const [name, setName] = useState(profile?.name ?? "");
  const [picking, setPicking] = useState(false);
  const colors = useFormColors();
  if (!profile) return null;
  const update = (patch: Partial<Pick<Space, "name" | "color" | "icon" | "theme" | "cleanUpAfterHours">>) => useBrowser.getState().updateSpace(spaceId, patch);
  // The editor shows in a browser window (settings is its own), on this space, so the window is its preview.
  const customize = () => {
    const windowId = resolveWindowId(useBrowser.getState());
    if (windowId) openThemeEditor(windowId, spaceId);
  };
  const commitName = () => (name.trim() ? update({ name: name.trim() }) : setName(profile.name));

  return (
    <View>
      <View style={{ alignItems: "center", marginTop: 24, gap: 10 }}>
        <Pressable onPress={() => setPicking(!picking)} tooltip="Change Icon">
          <SpaceBadge profile={profile} size={64} />
        </Pressable>
        <Text style={{ fontSize: 12, color: theme.textSecondary }}>{stats}</Text>
      </View>

      <SectionHeader title="Space" />
      <Group>
        <Row title="Name">
          <TextField value={name} onChangeText={setName} onSubmit={commitName} onBlur={commitName} style={{ width: 220 }} />
        </Row>
        <Row title="Icon" description={spaceIconTitle(profile.icon)}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button title={picking ? "Done" : "Change…"} onPress={() => setPicking(!picking)} />
          </View>
        </Row>
        {picking ? (
          <View style={{ padding: 12, alignItems: "center" }}>
            <IconGrid
              symbols={SPACE_SYMBOLS}
              current={profile.icon}
              onChoose={(icon) => update({ icon })}
              columns={SPACE_PANE_ICON_COLUMNS}
              cell={30}
              rows={4}
              highlight={colors.selected}
              bold
            />
          </View>
        ) : null}
        <Row title="Theme colour" description="Tints this space's windows and New Tab page.">
          <View style={{ flexDirection: "row", gap: 7 }}>
            {(Object.keys(SPACE_COLORS) as SpaceColor[]).map((c) => (
              <Pressable key={c} onPress={() => update({ color: c, theme: null })} tooltip={SPACE_COLORS[c].name}>
                <View
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    padding: 2,
                    borderWidth: 2,
                    borderColor: !profile.theme && profile.color === c ? SPACE_COLORS[c].swatch : "transparent",
                  }}
                >
                  <View style={{ flex: 1, borderRadius: 8, backgroundColor: SPACE_COLORS[c].swatch }} />
                </View>
              </Pressable>
            ))}
          </View>
        </Row>
        <Row
          title="Custom theme"
          description={
            profile.theme
              ? `${plural(profile.theme.colors.length, "colour")}, its own intensity and grain.`
              : "Your own colours, intensity and grain, as Arc's theme editor."
          }
        >
          {profile.theme ? (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button title="Remove" onPress={() => update({ theme: null })} />
              <Button title="Edit…" onPress={customize} />
            </View>
          ) : (
            <Button title="Customize…" onPress={customize} />
          )}
        </Row>
      </Group>

      <SectionHeader title="Tabs" />
      <Group>
        <Row title="Clean up tabs I haven't used in" description="Pinned, kept, grouped and playing tabs stay. Cleaned tabs are listed under Recently Cleaned.">
          <PopUp
            value={cleanUpChoice(profile.cleanUpAfterHours)}
            options={[
              { value: "app", title: `Tabs setting (${appCleanUp === null ? "never" : cleanUpTitle(appCleanUp)})` },
              ...CLEAN_UP_CHOICES.map((c, i) => (i === 0 ? { ...c, separatorBefore: true } : c)),
              { value: "never", title: "Never", separatorBefore: true },
            ]}
            onChange={(v) => update({ cleanUpAfterHours: cleanUpHoursOf(v) })}
            minWidth={180}
          />
        </Row>
      </Group>

      <SectionHeader title="Browsing Data" />
      <Group>
        <Row title="Make Default Space" description={isDefault ? "New windows already open with this space." : "Open new windows with this space."}>
          <Button title="Make Default" disabled={isDefault} onPress={() => useBrowser.getState().setDefaultSpace(spaceId)} />
        </Row>
        <Row title="Clear Browsing Data" description="History, cookies, site data and cached files for this space.">
          <Button title="Clear…" onPress={() => showSettingsSheet(<ClearDataDialog spaceId={spaceId} onClose={closeSettingsSheet} />)} />
        </Row>
        <Row
          title="Delete Selected Space"
          description={only ? "You can't delete your only space." : "Removes its tabs, history, bookmarks, passwords, extensions and site data."}
        >
          <Button
            title="Delete…"
            kind="destructive"
            disabled={only}
            onPress={() =>
              void deleteSpace(spaceId).then(() => {
                if (!useBrowser.getState().spaces[spaceId]) useSettingsNav.getState().go("spaces");
              })
            }
          />
        </Row>
      </Group>
    </View>
  );
}
