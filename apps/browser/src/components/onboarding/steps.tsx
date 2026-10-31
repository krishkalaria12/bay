import { reportBrowserCommand } from "../../runtime/commands";
import type { DeepReadonly } from "../../runtime/projection";
import { updateSettings } from "../../runtime/settingsActions";
import { updateSpace } from "../../runtime/spaceActions";
import { toggleTabLayout } from "../../runtime/splitActions";
import { Pressable, View, shortcutForCommand, capabilities, isMac, shortcutLabel } from "@bay/platform";
import { addToDock, isDefaultBrowser, isInDock, launchAtLoginStatus, setAsDefaultBrowser, setLaunchAtLogin, Symbol } from "@bay/shell";
import { useEffect, useState, type ReactNode } from "react";
import { Image, StyleSheet, Text } from "react-native";
import { interpolateColor } from "@bay/platform/motion";
import { SPACE_COLORS, spaceThemeKey, themeFor, useTheme } from "../../lib/theme";
import { useBrowserRead as useBrowser } from "../../store/read";
import type { Settings } from "../../store/settings";
import type { SpaceColor, SpaceTheme } from "../../store/types";
import { Favicon, useHover } from "../primitives";
import { PERSONALIZE_COPY, TabLayoutPicker, ThemeColorPicker } from "./personalize";
import { PINNABLE_SITES, pinSites, preselectedSites } from "./sites";
import { finishOnboarding, nextStep, recordDefaultBrowserTrial, skipStep, STEPS, useOnboarding } from "./state";
import { CheckMark, CheckRow, Reveal, SecondaryButton, SectionLabel, SelectTile, StepActions, StepProgress, StepTitle, useOnboardingColors } from "./ui";
import { APP_ICON } from "../../lib/assets";

export function StepLayout({ children, actions, preview }: { children: ReactNode; actions: ReactNode; preview: ReactNode }) {
  const colors = useOnboardingColors();
  return (
    <View style={{ flex: 1, flexDirection: "row" }}>
      <View style={{ width: 460, paddingHorizontal: 40, paddingTop: 34, paddingBottom: 32, justifyContent: "space-between" }}>
        <View style={{ gap: 20 }}>
          <Reveal>
            <StepProgress />
          </Reveal>
          {children}
        </View>
        <Reveal delay={240} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {actions}
        </Reveal>
      </View>
      <View
        style={{
          flex: 1,
          margin: 12,
          marginLeft: 0,
          borderRadius: 14,
          backgroundColor: colors.preview,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: colors.previewBorder,
          overflow: "hidden",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Reveal delay={120} style={{ alignItems: "center", justifyContent: "center" }}>
          {preview}
        </Reveal>
      </View>
    </View>
  );
}

// The step column's width inside its padding, for tiles four to a row.
const COLUMN = 380;
const TILE_GAP = 8;
export const QUARTER_TILE = (COLUMN - TILE_GAP * 3) / 4;

// MARK: Personalization

const APPEARANCES: { value: Settings["appearance"]; title: string; picked: string }[] = [
  { value: "auto", title: "Auto", picked: `Light and dark follow ${isMac ? "your Mac" : "your system"}` },
  { value: "light", title: "Light", picked: "Always light" },
  { value: "dark", title: "Dark", picked: "Always dark" },
];

type Look = {
  spaceId?: string;
  color?: SpaceColor;
  theme: DeepReadonly<SpaceTheme> | null;
  tabLayout: Settings["tabLayout"];
  appearance: Settings["appearance"];
};

function lookOf(windowId: string): Look {
  const s = useBrowser.getState();
  const spaceId = s.windows[windowId]?.spaceId;
  const space = spaceId ? s.spaces[spaceId] : undefined;
  return {
    spaceId,
    color: space?.color,
    theme: space?.theme ?? null,
    tabLayout: s.windows[windowId]?.tabLayout ?? s.settings.tabLayout,
    appearance: s.settings.appearance,
  };
}

// The pickers change the window as you choose, so Skip puts the look back as the step found it.
function restoreLook(windowId: string, look: Look) {
  const b = useBrowser.getState();
  const theme = look.theme ? { ...look.theme, colors: [...look.theme.colors] } : null;
  if (look.spaceId && look.color) reportBrowserCommand(updateSpace(look.spaceId, { color: look.color, theme }));
  if (lookOf(windowId).tabLayout !== look.tabLayout) reportBrowserCommand(toggleTabLayout(windowId));
  if (b.settings.appearance !== look.appearance) reportBrowserCommand(updateSettings({ appearance: look.appearance }));
}

export function PersonalizeStep() {
  const windowId = useOnboarding((s) => s.windowId) ?? "";
  const appearance = useBrowser((s) => s.settings.appearance);
  const [before] = useState(() => lookOf(windowId));

  const done = () => {
    const look = lookOf(windowId);
    const theme = look.theme ? "Twilight" : look.color ? SPACE_COLORS[look.color]?.name : undefined;
    const appearance = APPEARANCES.find((a) => a.value === look.appearance)?.picked;
    nextStep([
      ...(theme ? [`${theme} theme`] : []),
      look.tabLayout === "sidebar" ? "Tabs down the side" : "Tabs along the top",
      ...(appearance ? [appearance] : []),
    ]);
  };

  const skip = () => {
    restoreLook(windowId, before);
    skipStep();
  };

  return (
    <StepLayout actions={<StepActions onContinue={done} onSkip={skip} />} preview={<WindowPreview windowId={windowId} />}>
      <Reveal delay={60}>
        <StepTitle title={PERSONALIZE_COPY.title} subtitle={PERSONALIZE_COPY.subtitle} />
      </Reveal>
      <Reveal delay={140} style={{ gap: 18 }}>
        <ThemeColorPicker windowId={windowId} size={32} />
        <View style={{ gap: 10 }}>
          <SectionLabel title={PERSONALIZE_COPY.layouts} />
          <TabLayoutPicker windowId={windowId} />
        </View>
        <View style={{ flexDirection: "row", gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel="Appearance">
          {APPEARANCES.map((a) => (
            <Segment
              key={a.value}
              title={a.title}
              selected={appearance === a.value}
              onPress={() => reportBrowserCommand(updateSettings({ appearance: a.value }))}
            />
          ))}
        </View>
      </Reveal>
    </StepLayout>
  );
}

function Segment({ title, selected, onPress }: { title: string; selected: boolean; onPress: () => void }) {
  const colors = useOnboardingColors();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps} style={{ flex: 1 }}>
      <Pressable onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={title}>
        <View
          style={{
            height: 30,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: selected || hovered ? colors.button : colors.row,
            borderWidth: selected ? 1.5 : StyleSheet.hairlineWidth * 2,
            borderColor: selected ? colors.title : colors.rowBorder,
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: "500", color: selected ? colors.title : colors.subtitle }}>{title}</Text>
        </View>
      </Pressable>
    </View>
  );
}

// The preview's gradient: bands this many, top to bottom.
const PREVIEW_BANDS = 16;

function WindowPreview({ windowId }: { windowId: string }) {
  const colors = useOnboardingColors();
  const dark = useTheme().dark;
  // The space's whole look, as its window shows it: a gradient theme (a new install's Twilight) or a preset colour.
  const key = useBrowser((s) => spaceThemeKey(s.spaces[s.windows[windowId]?.spaceId ?? ""], dark));
  const accent = useBrowser((s) => {
    const space = s.spaces[s.windows[windowId]?.spaceId ?? ""];
    return space?.theme?.colors[0] ?? SPACE_COLORS[space?.color ?? "plum"]?.swatch ?? SPACE_COLORS.plum.swatch;
  });
  const layout = useBrowser((s) => s.windows[windowId]?.tabLayout ?? s.settings.tabLayout);
  const theme = themeFor(key);
  const [top, bottom] = theme.windowTint;
  const line = { height: 6, borderRadius: 3, backgroundColor: colors.progressTrack };
  return (
    <View
      style={{
        width: 280,
        height: 184,
        borderRadius: 12,
        padding: 7,
        gap: 6,
        backgroundColor: top,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: colors.rowBorder,
        flexDirection: layout === "sidebar" ? "row" : "column",
        overflow: "hidden",
      }}
    >
      {/* Top to bottom, the window's two colours (one, for a preset), in bands fine enough to read as a gradient. */}
      {top !== bottom
        ? Array.from({ length: PREVIEW_BANDS }, (_, i) => (
            <View
              key={i}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: `${(i / PREVIEW_BANDS) * 100}%`,
                height: `${100 / PREVIEW_BANDS + 1}%`,
                backgroundColor: interpolateColor(i / (PREVIEW_BANDS - 1), [0, 1], [top, bottom]),
              }}
            />
          ))
        : null}
      {layout === "sidebar" ? (
        <View style={{ width: 70, gap: 6, paddingTop: 4 }}>
          <View style={{ flexDirection: "row", gap: 4, marginBottom: 6 }}>
            {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
              <View key={c} style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: c }} />
            ))}
          </View>
          <View style={[line, { width: "90%", height: 16, borderRadius: 5, backgroundColor: theme.card }]} />
          {[0.8, 0.6, 0.7].map((w, i) => (
            <View key={i} style={[line, { width: `${w * 100}%` }]} />
          ))}
        </View>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 18 }}>
          <View style={{ flexDirection: "row", gap: 4, marginRight: 6 }}>
            {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
              <View key={c} style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: c }} />
            ))}
          </View>
          <View style={[line, { width: 56, height: 14, borderRadius: 5, backgroundColor: theme.card }]} />
          {[0, 1].map((i) => (
            <View key={i} style={[line, { width: 44 }]} />
          ))}
        </View>
      )}
      <View style={{ flex: 1, borderRadius: 7, backgroundColor: theme.card, alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: "62%", height: 22, borderRadius: 7, backgroundColor: colors.card, borderWidth: 1, borderColor: `${accent}99` }} />
      </View>
    </View>
  );
}

// MARK: Pinned tabs

export function PinnedTabsStep() {
  const windowId = useOnboarding((s) => s.windowId);
  const history = useBrowser((s) => s.history[s.windows[windowId ?? ""]?.spaceId ?? ""]);
  // Preselected from the history as the step opens.
  const [selected, setSelected] = useState<string[]>(() => preselectedSites(history ?? []));

  const toggle = (id: string) => setSelected((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  const pinSelected = () => {
    if (windowId) reportBrowserCommand(pinSites(windowId, selected));
    nextStep(selected.length ? [`${selected.length} ${selected.length === 1 ? "app" : "apps"} pinned`] : []);
  };

  return (
    <StepLayout
      actions={
        <StepActions
          continueTitle={selected.length ? `Pin ${selected.length} ${selected.length === 1 ? "Tab" : "Tabs"}` : "Continue"}
          onContinue={pinSelected}
        />
      }
      preview={<PinnedPreview selected={selected} />}
    >
      <Reveal delay={60}>
        <StepTitle title="Keep your favorite apps handy" subtitle="Pin important apps so they're always available when you open Bay." />
      </Reveal>
      <Reveal delay={140} style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {PINNABLE_SITES.map((site) => (
          <SelectTile key={site.id} title={site.title} selected={selected.includes(site.id)} onPress={() => toggle(site.id)}>
            {() => <Favicon url={site.url} size={22} />}
          </SelectTile>
        ))}
      </Reveal>
    </StepLayout>
  );
}

function PinnedPreview({ selected }: { selected: string[] }) {
  const colors = useOnboardingColors();
  const sites = PINNABLE_SITES.filter((s) => selected.includes(s.id));
  const slots = Math.max(6, Math.ceil(sites.length / 3) * 3);
  return (
    <View
      style={{
        width: 236,
        padding: 14,
        borderRadius: 14,
        backgroundColor: colors.row,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: colors.rowBorder,
        gap: 12,
      }}
    >
      <View style={{ flexDirection: "row", gap: 6 }}>
        {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
          <View key={c} style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: c }} />
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {Array.from({ length: slots }, (_, i) => {
          const site = sites[i];
          return (
            <View
              key={site?.id ?? `empty-${i}`}
              style={{
                width: 64,
                height: 40,
                borderRadius: 9,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: site ? colors.button : "transparent",
                borderWidth: site ? 0 : 1,
                borderStyle: "dashed",
                borderColor: colors.rowBorder,
              }}
            >
              {site ? <Favicon url={site.url} size={18} /> : null}
            </View>
          );
        })}
      </View>
      <View style={{ height: StyleSheet.hairlineWidth * 2, backgroundColor: colors.separator }} />
      {[0.7, 0.5, 0.6].map((w, i) => (
        <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 22 }}>
          <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: colors.progressTrack }} />
          <View style={{ height: 6, borderRadius: 3, width: `${w * 100}%`, backgroundColor: colors.progressTrack }} />
        </View>
      ))}
    </View>
  );
}

// MARK: Default browser, Dock, login item

type SystemState = { isDefault: boolean; inDock: boolean; loginEnabled: boolean };

async function applySystemChoices(system: SystemState, choice: { setDefault: boolean; trial: boolean; login: boolean; dock: boolean }) {
  if (choice.setDefault && !system.isDefault && (await setAsDefaultBrowser()) && choice.trial) recordDefaultBrowserTrial();
  if (choice.login !== system.loginEnabled) await setLaunchAtLogin(choice.login).catch(() => {});
  if (capabilities.dock && choice.dock && !system.inDock) await addToDock();
}

export function DefaultBrowserStep() {
  const [system, setSystem] = useState<SystemState | null>(null);
  const [setDefault, setSetDefault] = useState(true);
  const [trial, setTrial] = useState(false);
  const [dock, setDock] = useState(true);
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([isDefaultBrowser(), capabilities.dock ? isInDock() : Promise.resolve(false), launchAtLoginStatus()]).then(
      ([isDefault, inDock, login]) => {
        setSystem({ isDefault, inDock, loginEnabled: login === "enabled" });
        if (login === "enabled") setLogin(true);
      },
    );
  }, []);

  const apply = async () => {
    if (!system) return;
    setBusy(true);
    const picked = [
      ...(setDefault && !system.isDefault ? [trial ? "A week as your default browser" : "Bay is your default browser"] : []),
      ...(capabilities.dock && dock && !system.inDock ? ["In your Dock"] : []),
      ...(login ? ["Opens at login"] : []),
    ];
    await applySystemChoices(system, { setDefault, trial, login, dock }).finally(() => {
      setBusy(false);
      nextStep(picked);
    });
  };

  const defaultOn = system?.isDefault || setDefault;
  return (
    <StepLayout
      actions={<StepActions continueTitle={busy ? "Setting Up…" : "Continue"} onContinue={() => void apply()} disabled={!system} busy={busy} />}
      preview={<SystemPreview isDefault={!!defaultOn} dock={!!(system?.inDock || dock)} login={login} />}
    >
      <Reveal delay={60}>
        <StepTitle title="Make Bay your home" subtitle="Bay works best as your default browser, so links from every app open here." />
      </Reveal>
      <Reveal delay={140} style={{ gap: 6 }}>
        <CheckRow
          icon="globe"
          title="Set Bay as default browser"
          subtitle={system?.isDefault ? "Bay is already your default browser" : "Open links and web pages in Bay by default"}
          value={defaultOn}
          disabled={!system || system.isDefault}
          onChange={setSetDefault}
        />
        {!system?.isDefault && setDefault ? (
          <CheckRow
            icon="calendar"
            title="Try Bay as your default for seven days"
            subtitle="We'll check in to make sure you love it."
            value={trial}
            onChange={setTrial}
          />
        ) : null}
        {capabilities.dock && system && !system.inDock ? (
          <CheckRow icon="dock.rectangle" title="Add Bay to Dock" subtitle="Quick access to Bay whenever you need it" value={dock} onChange={setDock} />
        ) : null}
        <CheckRow icon="power" title="Open Bay at login" subtitle="Automatically open Bay when you sign in" value={login} onChange={setLogin} />
      </Reveal>
    </StepLayout>
  );
}

function SystemChip({ on, icon, label }: { on: boolean; icon: string; label: string }) {
  const colors = useOnboardingColors();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        height: 34,
        paddingLeft: 12,
        paddingRight: 10,
        borderRadius: 17,
        backgroundColor: colors.row,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: colors.rowBorder,
        opacity: on ? 1 : 0.45,
      }}
    >
      <Symbol name={icon} size={13} color={colors.title} style={{ width: 16, height: 16 }} />
      <Text style={{ fontSize: 12, fontWeight: "500", color: colors.title }}>{label}</Text>
      <CheckMark on={on} size={16} />
    </View>
  );
}

function SystemPreview({ isDefault, dock, login }: { isDefault: boolean; dock: boolean; login: boolean }) {
  return (
    <View style={{ alignItems: "center", gap: 28 }}>
      <Image source={APP_ICON} style={{ width: 132, height: 132 }} />
      <View style={{ gap: 8, alignItems: "center" }}>
        <SystemChip on={isDefault} icon="globe" label="Default browser" />
        {capabilities.dock && <SystemChip on={dock} icon="dock.rectangle" label="In your Dock" />}
        <SystemChip on={login} icon="power" label="Opens at login" />
      </View>
    </View>
  );
}

// MARK: Welcome

// The postcard lists this many of your choices.
const POSTCARD_LINES = 8;

export function OutroStep() {
  const colors = useOnboardingColors();
  const picked = useOnboarding((s) => s.picked);
  const lines = STEPS.flatMap((step) => picked[step] ?? []);
  return (
    <StepLayout
      actions={
        <>
          <StepActions continueTitle="Get Started" icon="arrow.right" onContinue={() => finishOnboarding()} skip={false} />
          <SecondaryButton title="Take the Tour" onPress={() => finishOnboarding({ tour: true })} />
        </>
      }
      preview={<Postcard lines={lines.slice(0, POSTCARD_LINES)} />}
    >
      <Reveal delay={60}>
        <StepTitle title={"Welcome to your new\nhome on the internet"} subtitle="Everything you set up is saved. Change any of it later in Settings." />
      </Reveal>
      <Reveal delay={140} style={{ gap: 10 }}>
        {[
          ["⌘T", "Open a new tab"],
          ["⌘L", "Go anywhere from the command bar"],
          [shortcutForCommand("toggleSidebar", "⌘S"), "Hide the sidebar for more room"],
        ].map(([keys, label]) => (
          <View key={keys} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View
              style={{
                minWidth: 38,
                height: 24,
                paddingHorizontal: 7,
                borderRadius: 6,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.button,
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: "500", color: colors.title }}>{shortcutLabel(keys ?? "")}</Text>
            </View>
            <Text style={{ fontSize: 13, color: colors.subtitle }}>{label}</Text>
          </View>
        ))}
      </Reveal>
    </StepLayout>
  );
}

function Postcard({ lines }: { lines: string[] }) {
  const colors = useOnboardingColors();
  return (
    <View
      style={{
        width: 320,
        minHeight: 200,
        borderRadius: 6,
        padding: 18,
        flexDirection: "row",
        backgroundColor: colors.card,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: colors.rowBorder,
        transform: [{ rotate: "-3deg" }],
      }}
    >
      <View style={{ flex: 1, gap: 10, paddingRight: 14 }}>
        <Text style={{ fontSize: 20, fontWeight: "300", fontStyle: "italic", color: colors.title }}>Hello!</Text>
        {lines.length ? (
          <View style={{ gap: 4 }}>
            <Text style={{ fontSize: 11, lineHeight: 15, color: colors.subtitle }}>You picked:</Text>
            {lines.map((line) => (
              <View key={line} style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
                <Symbol name="checkmark" size={8} weight="bold" color={colors.title} style={{ width: 10, height: 15 }} />
                <Text style={{ flex: 1, fontSize: 11, lineHeight: 15, color: colors.title }}>{line}</Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={{ fontSize: 12, lineHeight: 17, color: colors.subtitle }}>
            {"Glad you're here. Make yourself at home — your tabs, bookmarks and pins are ready."}
          </Text>
        )}
      </View>
      <View style={{ width: StyleSheet.hairlineWidth * 2, backgroundColor: colors.separator }} />
      <View style={{ width: 96, paddingLeft: 14, justifyContent: "space-between", alignItems: "flex-end" }}>
        <View style={{ padding: 4, borderWidth: 1.5, borderStyle: "dashed", borderColor: colors.rowBorder, borderRadius: 3 }}>
          <Image source={APP_ICON} style={{ width: 46, height: 46 }} />
        </View>
        <View style={{ alignSelf: "stretch", gap: 12 }}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ height: 1, backgroundColor: colors.separator }} />
          ))}
        </View>
      </View>
      <View
        style={{
          position: "absolute",
          right: 50,
          top: 52,
          width: 44,
          height: 44,
          borderRadius: 22,
          borderWidth: 1,
          borderColor: colors.steps,
          alignItems: "center",
          justifyContent: "center",
          transform: [{ rotate: "-12deg" }],
        }}
      >
        <Text numberOfLines={1} style={{ fontSize: 6, fontWeight: "700", letterSpacing: 0.4, color: colors.steps }}>
          WELCOME
        </Text>
      </View>
    </View>
  );
}
