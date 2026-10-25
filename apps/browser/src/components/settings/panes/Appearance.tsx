import { appIcons, currentAppIcon, setAppearance, setAppIcon, Symbol, type AppIcon } from "@bay/shell";
import { useEffect, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { useTheme } from "../../../lib/theme";
import { useBrowser } from "../../../store/browser";
import type { Settings } from "../../../store/settings";
import { useHover } from "../../primitives";
import { Group, SectionHeader, SettingToggle, useFormColors } from "../controls";
import { SETTINGS } from "../definitions";
import { APP_ICON_CHOICE_SIZE } from "../constants";

const MODES: { value: Settings["appearance"]; title: string; description: string }[] = [
  { value: "auto", title: "Automatic", description: "Follow the system appearance setting" },
  { value: "light", title: "Light", description: "Use the light application appearance" },
  { value: "dark", title: "Dark", description: "Use the dark application appearance" },
];

export function AppearancePane() {
  const appearance = useBrowser((s) => s.settings.appearance);
  const choose = (mode: Settings["appearance"]) => {
    useBrowser.getState().updateSettings({ appearance: mode });
    void setAppearance(mode);
  };
  return (
    <View>
      <SectionHeader
        settingId={SETTINGS.appearance.id}
        title={SETTINGS.appearance.title}
        description="Also in View › Appearance. Incognito windows are always dark."
      />
      <View style={{ flexDirection: "row", gap: 14 }}>
        {MODES.map((m) => (
          <ModeChoice
            key={m.value}
            mode={m.value}
            title={m.title}
            description={m.description}
            selected={appearance === m.value}
            onPress={() => choose(m.value)}
          />
        ))}
      </View>
      <DensityPicker />
      <MaterialPicker />
      <SidebarPositionPicker />
      <AddressBarPicker />
      <AppIconPicker />
    </View>
  );
}

function DensityPicker() {
  const density = useBrowser((s) => s.settings.density);
  const theme = useTheme();
  const colors = useFormColors();
  return (
    <>
      <SectionHeader
        settingId={SETTINGS.density.id}
        title={SETTINGS.density.title}
        description="Resize sidebar rows, pinned tiles and the address field together."
      />
      <View style={{ flexDirection: "row", gap: 14 }}>
        {(["comfortable", "compact"] as const).map((value) => (
          <Pressable
            key={value}
            onPress={() => useBrowser.getState().updateSettings({ density: value })}
            accessibilityRole="radio"
            accessibilityState={{ checked: density === value }}
            style={{
              flex: 1,
              padding: 12,
              borderRadius: 9,
              borderWidth: density === value ? 2 : 1,
              borderColor: density === value ? colors.accent : colors.groupBorder,
            }}
          >
            <Text style={{ fontSize: 13, color: theme.textPrimary }}>{value === "comfortable" ? "Comfortable" : "Compact"}</Text>
            <Text style={{ marginTop: 4, fontSize: 12, color: theme.textSecondary }}>
              {value === "comfortable" ? "36-point rows, 16-point icons" : "30-point rows, 14-point icons"}
            </Text>
          </Pressable>
        ))}
      </View>
    </>
  );
}

function MaterialPicker() {
  const material = useBrowser((s) => s.settings.windowMaterial);
  const choose = (value: Settings["windowMaterial"]) => useBrowser.getState().updateSettings({ windowMaterial: value });
  return (
    <>
      <SectionHeader
        settingId={SETTINGS.windowMaterial.id}
        title={SETTINGS.windowMaterial.title}
        description="Solid fills the window with the page’s colour, or your space’s when it has none. Glass lets the desktop show through it."
      />
      <View style={{ flexDirection: "row", gap: 14 }}>
        <MaterialChoice value="solid" title="Solid" selected={material === "solid"} onPress={() => choose("solid")} />
        <MaterialChoice value="glass" title="Glass" selected={material === "glass"} onPress={() => choose("glass")} />
      </View>
    </>
  );
}

function MaterialChoice({ value, title, selected, onPress }: { value: Settings["windowMaterial"]; title: string; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  const colors = useFormColors();
  const glass = value === "glass";
  const bar = theme.dark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.16)";
  const page = theme.dark ? "#2C2C2F" : "#FFFFFF";
  return (
    <Pressable onPress={onPress} style={{ flex: 1, alignItems: "center", gap: 7 }}>
      <View
        style={{
          width: "100%",
          height: 84,
          borderRadius: 9,
          overflow: "hidden",
          borderWidth: selected ? 2.5 : 1,
          borderColor: selected ? colors.accent : colors.groupBorder,
          backgroundColor: glass ? (theme.dark ? "#3A2F45" : "#D9D2EC") : theme.dark ? "#1E1E21" : "#EBEBED",
        }}
      >
        {/* Glass: the desktop's colours, softened through the window. */}
        {glass && (
          <>
            <View style={{ position: "absolute", left: -18, top: -20, width: 90, height: 90, borderRadius: 45, backgroundColor: "#E58BB0", opacity: 0.45 }} />
            <View style={{ position: "absolute", left: 30, bottom: -36, width: 90, height: 90, borderRadius: 45, backgroundColor: "#6FA8F2", opacity: 0.4 }} />
            <View
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: 0,
                bottom: 0,
                backgroundColor: theme.dark ? "rgba(30,30,33,0.45)" : "rgba(235,235,237,0.45)",
              }}
            />
          </>
        )}
        <View style={{ flex: 1, padding: 6, flexDirection: "row", gap: 5 }}>
          <View style={{ width: "28%", gap: 3, paddingTop: 8 }}>
            {[0, 1, 2].map((i) => (
              <View key={i} style={{ height: 5, borderRadius: 2.5, backgroundColor: bar }} />
            ))}
          </View>
          <View style={{ flex: 1, borderRadius: 4, backgroundColor: page }} />
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        {selected && <Symbol name="checkmark.circle.fill" size={12} color={colors.accent} style={{ width: 14, height: 14 }} />}
        <Text style={{ fontSize: 12, color: selected ? theme.textPrimary : theme.textSecondary }}>{title}</Text>
      </View>
    </Pressable>
  );
}

function SidebarPositionPicker() {
  const position = useBrowser((s) => s.settings.sidebarPosition);
  const topTabs = useBrowser((s) => s.settings.tabLayout === "top");
  const choose = (value: Settings["sidebarPosition"]) => useBrowser.getState().updateSettings({ sidebarPosition: value });
  return (
    <>
      <SectionHeader
        settingId={SETTINGS.sidebarPosition.id}
        title={SETTINGS.sidebarPosition.title}
        description={
          topTabs
            ? "Tabs are across the top of the window. With tabs in the sidebar, it docks on the side you choose."
            : "Choose which side of the window the sidebar docks on. On the right, the page runs up to the window’s top, and the window buttons show when you point there."
        }
      />
      <View style={{ flexDirection: "row", gap: 14 }}>
        <SidebarPositionChoice value="left" title="On the left" selected={position !== "right"} onPress={() => choose("left")} />
        <SidebarPositionChoice value="right" title="On the right" selected={position === "right"} onPress={() => choose("right")} />
      </View>
      {topTabs ? null : (
        <Group style={{ marginTop: 14 }}>
          <SettingToggle
            setting="showSidebarOnOption"
            settingId={SETTINGS.showSidebarOnOption.id}
            title={SETTINGS.showSidebarOnOption.title}
            description="With the sidebar hidden (⌘S), it slides out while you hold Option and away when you let go."
          />
        </Group>
      )}
    </>
  );
}

function SidebarPositionChoice({
  value,
  title,
  selected,
  onPress,
}: {
  value: Settings["sidebarPosition"];
  title: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const colors = useFormColors();
  const bar = theme.dark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.16)";
  const page = theme.dark ? "rgba(255,255,255,0.08)" : "#FFFFFF";
  const right = value === "right";
  return (
    <Pressable onPress={onPress} style={{ flex: 1, alignItems: "center", gap: 7 }}>
      <View
        style={{
          width: "100%",
          height: 84,
          borderRadius: 9,
          padding: 6,
          flexDirection: right ? "row-reverse" : "row",
          gap: 5,
          borderWidth: selected ? 2.5 : 1,
          borderColor: selected ? colors.accent : colors.groupBorder,
          backgroundColor: theme.dark ? "#2A2A2C" : "#E9E9EB",
        }}
      >
        {/* The window buttons, top left either way: over the page, and faint (they show on hover), on the right. */}
        <View style={{ position: "absolute", zIndex: 1, left: right ? 9 : 6, top: right ? 8 : 5, flexDirection: "row", gap: 2.5, opacity: right ? 0.45 : 1 }}>
          {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
            <View key={c} style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: c }} />
          ))}
        </View>
        <View style={{ width: "28%", gap: 3, paddingTop: 8 }}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ height: 5, borderRadius: 2.5, backgroundColor: i === 0 ? colors.accent : bar }} />
          ))}
        </View>
        <View style={{ flex: 1, borderRadius: 4, backgroundColor: page }} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        {selected && <Symbol name="checkmark.circle.fill" size={12} color={colors.accent} style={{ width: 14, height: 14 }} />}
        <Text style={{ fontSize: 12, color: selected ? theme.textPrimary : theme.textSecondary }}>{title}</Text>
      </View>
    </Pressable>
  );
}

function AddressBarPicker() {
  const addressBar = useBrowser((s) => s.settings.addressBar);
  const topTabs = useBrowser((s) => s.settings.tabLayout === "top");
  const choose = (value: Settings["addressBar"]) => useBrowser.getState().updateSettings({ addressBar: value });
  return (
    <>
      <SectionHeader
        settingId={SETTINGS.addressBar.id}
        title={SETTINGS.addressBar.title}
        description={
          topTabs
            ? "Tabs are across the top of the window, so the address bar stays in the toolbar. Also in View › Show Address Bar in Sidebar."
            : "Choose where the address bar appears. When the sidebar is hidden, it moves above the page. Also in View › Show Address Bar in Sidebar."
        }
      />
      <View style={{ flexDirection: "row", gap: 14 }}>
        <AddressBarChoice value="sidebar" title="In the sidebar" selected={addressBar === "sidebar"} onPress={() => choose("sidebar")} />
        <AddressBarChoice value="toolbar" title="Above the page" selected={addressBar !== "sidebar"} onPress={() => choose("toolbar")} />
      </View>
    </>
  );
}

function AddressBarChoice({ value, title, selected, onPress }: { value: Settings["addressBar"]; title: string; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  const colors = useFormColors();
  const bar = theme.dark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.16)";
  const field = theme.dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.08)";
  const page = theme.dark ? "rgba(255,255,255,0.08)" : "#FFFFFF";
  const sidebar = value === "sidebar";
  return (
    <Pressable onPress={onPress} style={{ flex: 1, alignItems: "center", gap: 7 }}>
      <View
        style={{
          width: "100%",
          height: 84,
          borderRadius: 9,
          padding: 6,
          flexDirection: "row",
          gap: 5,
          borderWidth: selected ? 2.5 : 1,
          borderColor: selected ? colors.accent : colors.groupBorder,
          backgroundColor: theme.dark ? "#2A2A2C" : "#E9E9EB",
        }}
      >
        <View style={{ width: "28%", gap: 3, paddingTop: sidebar ? 3 : 8 }}>
          {sidebar && <View style={{ height: 8, borderRadius: 3, marginBottom: 2, backgroundColor: field, borderWidth: 1, borderColor: colors.accent }} />}
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ height: 5, borderRadius: 2.5, backgroundColor: bar }} />
          ))}
        </View>
        <View style={{ flex: 1, borderRadius: 4, backgroundColor: page, overflow: "hidden" }}>
          {!sidebar && (
            <View
              style={{ height: 13, flexDirection: "row", alignItems: "center", paddingHorizontal: 5, gap: 5, borderBottomWidth: 1, borderBottomColor: field }}
            >
              <View style={{ width: 14, height: 4, borderRadius: 2, backgroundColor: bar }} />
              <View style={{ flex: 1, height: 7, borderRadius: 2.5, backgroundColor: field, borderWidth: 1, borderColor: colors.accent }} />
            </View>
          )}
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        {selected && <Symbol name="checkmark.circle.fill" size={12} color={colors.accent} style={{ width: 14, height: 14 }} />}
        <Text style={{ fontSize: 12, color: selected ? theme.textPrimary : theme.textSecondary }}>{title}</Text>
      </View>
    </Pressable>
  );
}

function AppIconPicker() {
  const [icons, setIcons] = useState<AppIcon[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    void Promise.all([appIcons(APP_ICON_CHOICE_SIZE), currentAppIcon()]).then(([list, id]) => {
      setIcons(list);
      setCurrent(id);
    });
  }, []);
  if (icons.length < 2) return null;
  const choose = (id: string) => {
    setCurrent(id);
    void setAppIcon(id);
  };
  return (
    <>
      <SectionHeader
        settingId={SETTINGS.appIcon.id}
        title={SETTINGS.appIcon.title}
        description="Shown in the Dock and the app switcher. The Dock keeps it after you quit."
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 6, rowGap: 10 }}>
        {icons.map((icon) => (
          <IconChoice key={icon.id} icon={icon} selected={icon.id === current} onPress={() => choose(icon.id)} />
        ))}
      </View>
    </>
  );
}

function IconChoice({ icon, selected, onPress }: { icon: AppIcon; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  const colors = useFormColors();
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable onPress={onPress} {...hoverProps} style={{ width: 72, alignItems: "center", gap: 5 }} tooltip={icon.name}>
      <View
        style={{
          width: 70,
          height: 70,
          borderRadius: 16,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 2.5,
          borderColor: selected ? colors.accent : "transparent",
          backgroundColor: hovered && !selected ? colors.selected : "transparent",
        }}
      >
        {icon.preview ? <Image source={{ uri: icon.preview }} style={{ width: APP_ICON_CHOICE_SIZE, height: APP_ICON_CHOICE_SIZE }} /> : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        {selected && <Symbol name="checkmark.circle.fill" size={11} color={colors.accent} style={{ width: 13, height: 13 }} />}
        <Text numberOfLines={1} style={{ fontSize: 12, color: selected ? theme.textPrimary : theme.textSecondary }}>
          {icon.name}
        </Text>
      </View>
    </Pressable>
  );
}

function ModeChoice({
  mode,
  title,
  description,
  selected,
  onPress,
}: {
  mode: Settings["appearance"];
  title: string;
  description: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const colors = useFormColors();
  return (
    <Pressable onPress={onPress} style={{ flex: 1, alignItems: "center", gap: 7 }} tooltip={description}>
      <View
        style={{
          width: "100%",
          height: 84,
          borderRadius: 9,
          overflow: "hidden",
          flexDirection: "row",
          borderWidth: selected ? 2.5 : 1,
          borderColor: selected ? colors.accent : colors.groupBorder,
        }}
      >
        {mode === "auto" ? (
          <>
            <MiniWindow dark={false} />
            <MiniWindow dark />
          </>
        ) : (
          <MiniWindow dark={mode === "dark"} />
        )}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        {selected && <Symbol name="checkmark.circle.fill" size={12} color={colors.accent} style={{ width: 14, height: 14 }} />}
        <Text style={{ fontSize: 12, color: selected ? theme.textPrimary : theme.textSecondary }}>{title}</Text>
      </View>
    </Pressable>
  );
}

// A window in miniature, light or dark: a sidebar's rows beside a page.
function MiniWindow({ dark }: { dark: boolean }) {
  return (
    <View style={{ flex: 1, backgroundColor: dark ? "#2B2226" : "#EDE6EA", padding: 6, flexDirection: "row", gap: 5 }}>
      <View style={{ width: "24%", gap: 3, paddingTop: 8 }}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={{ height: 5, borderRadius: 2.5, backgroundColor: dark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.12)" }} />
        ))}
      </View>
      <View style={{ flex: 1, borderRadius: 4, backgroundColor: dark ? "#1A1618" : "#FFFFFF" }} />
    </View>
  );
}
