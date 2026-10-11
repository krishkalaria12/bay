import { Surface, Symbol } from "@bay/shell";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { layout } from "../../lib/constants";
import { onEscapeKey } from "../../lib/escapeKey";
import { hex, setPreviewLook, useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { activeTabId, pinnedPage } from "../../store/model";
import { unusedSpaceLook } from "../../store/spaces";
import { useSidebarOnRight } from "../layout/windowLayout";
import { useHover } from "../primitives";
import { useSidebarWidth } from "../sidebar/tokens";
import { SPACE_EMOJI, unusedSpaceIcon } from "./icons";
import { ThemeControls, type Look } from "./ThemeEditor";
import { NEW_SPACE_FADE_MS, NEW_SPACE_PAD, PROFILE_DOTS_HEIGHT } from "./constants";

// yab's New Space, at the sidebar's foot rather than a dialog: start empty or with this tab, name it (and its icon),
// choose its look (the window shows it meanwhile), then whether it shares the current space's sign-ins.

type Step = "start" | "name" | "look" | "signins";
const ORDER: Step[] = ["start", "name", "look", "signins"];
const TITLES: Record<Step, string> = { start: "New Space", name: "New Space", look: "Look", signins: "Sign-ins" };

/** The open panels' steps, by window, for the dev harness. */
export const devPanels = new Map<string, { go(step: string): void; setName(name: string): void; take(): void; create(): void }>();

export function NewSpacePanel({ windowId, presetName, onDone }: { windowId: string; presetName?: string; onDone(id: string | null): void }) {
  const theme = useTheme();
  const right = useSidebarOnRight();
  const sidebarWidth = useSidebarWidth(windowId);
  const fromSpace = useBrowser((s) => s.windows[windowId]?.spaceId ?? s.settings.defaultSpaceId);
  const fromName = useBrowser((s) => s.spaces[fromSpace]?.name ?? "your other spaces");
  // The tab "Take This Tab" moves: the one on screen, unless it's a favourite or pinned (those stay put). Plain values,
  // so the store hands back the same ones until they change.
  const takeId = useBrowser((s) => {
    const id = activeTabId(s, windowId);
    const t = id ? s.tabs[id] : undefined;
    return t && t.url && !t.pinned && !pinnedPage(t) ? t.id : null;
  });
  const takeTitle = useBrowser((s) => {
    const t = takeId ? s.tabs[takeId] : undefined;
    return t ? t.customTitle || t.title || t.url : "";
  });
  const tab = takeId ? { id: takeId, title: takeTitle } : null;

  const [step, setStep] = useState<Step>(presetName ? "name" : "start");
  const [back, setBack] = useState(false);
  const [take, setTake] = useState(false);
  const [name, setName] = useState(presetName ?? "");
  const [icon, setIcon] = useState(() => unusedSpaceIcon(useBrowser.getState().spaces));
  const [look, setLook] = useState<Look>(() => ({ ...unusedSpaceLook(useBrowser.getState().spaces) }));
  const [shared, setShared] = useState(true);

  // The panel fades and rises in, and back out before it goes.
  const shown = useSharedValue(0);
  const closing = useRef(false);
  useEffect(() => shown.set(withTiming(1, { duration: NEW_SPACE_FADE_MS, easing: Easing.out(Easing.cubic) })), []);
  const panel = useAnimatedStyle(() => ({ opacity: shown.get(), transform: [{ translateY: (1 - shown.get()) * 10 }] }));
  const finish = (id: string | null) => {
    if (closing.current) return;
    closing.current = true;
    setPreviewLook(windowId, null);
    shown.set(withTiming(0, { duration: NEW_SPACE_FADE_MS * 0.7 }, (done) => done && runOnJS(onDone)(id)));
  };

  // The window shows the look while it's being chosen.
  useEffect(() => {
    setPreviewLook(windowId, step === "look" ? look : null);
  }, [step, look]);
  useEffect(() => () => setPreviewLook(windowId, null), []);

  const go = (next: Step) => {
    setBack(ORDER.indexOf(next) < ORDER.indexOf(step));
    setStep(next);
  };
  const previous = () => go(ORDER[Math.max(0, ORDER.indexOf(step) - (presetName && step === "name" ? 0 : 1))]!);

  const create = () => {
    const s = useBrowser.getState();
    const id = s.createSpace({ name: name.trim() || "Untitled", color: look.color, theme: look.theme, icon, shareWith: shared ? fromSpace : null });
    if (look.followSite !== undefined) s.updateSpace(id, { followSite: look.followSite });
    if (take && tab) s.moveTabToSpace(tab.id, id);
    finish(id);
  };

  // A test drives the steps it can't click through (a hidden instance takes no clicks).
  useEffect(() => {
    devPanels.set(windowId, { go: (to: string) => go(to as Step), setName, take: () => setTake(true), create });
    return () => void devPanels.delete(windowId);
  });

  // The sidebar's width, inset as its rows are, at every step: the look's controls fit inside it.
  const width = sidebarWidth - layout.sidebarInset * 2;
  const inner = width - NEW_SPACE_PAD * 2;
  const card = <Card icon={icon} name={name} take={take && !!tab} big={step === "name"} onIcon={step === "name" ? setIcon : undefined} />;

  return (
    <>
      <Pressable accessibilityLabel="Close New Space" style={StyleSheet.absoluteFill} onPress={() => finish(null)} />
      <Animated.View
        style={[
          { position: "absolute", bottom: PROFILE_DOTS_HEIGHT + 2, width, ...(right ? { right: layout.sidebarInset } : { left: layout.sidebarInset }) },
          panel,
        ]}
      >
        <Surface
          fill={hex(theme.panel)}
          cornerRadius={22}
          borderColor={hex(theme.panelBorder)}
          borderWidth={0.5}
          shadowColor="#000000"
          shadowOpacity={theme.panelShadowOpacity}
          shadowRadius={26}
          shadowOffset={[0, 10]}
          style={{ padding: NEW_SPACE_PAD }}
        >
          <View
            focusable
            enableFocusRing={false}
            keyDownEvents={[{ key: "Escape" }]}
            onKeyDown={() => finish(null)}
            style={{ flexDirection: "row", alignItems: "center", marginBottom: 12, gap: 6 }}
          >
            {step !== "start" && !(presetName && step === "name") ? <HeaderButton icon="chevron.left" label="Back" onPress={previous} /> : null}
            <Text style={{ flex: 1, fontSize: 18, fontWeight: "700", color: theme.textPrimary, marginLeft: step === "start" ? 4 : 0 }}>{TITLES[step]}</Text>
            <HeaderButton icon="xmark" label="Close" onPress={() => finish(null)} />
          </View>

          <Slide key={step} back={back}>
            {step === "start" ? (
              <View style={{ gap: 8 }}>
                <Choice
                  icon="plus"
                  title="Empty Space"
                  subtitle="Starts with a clean row of tabs."
                  onPress={() => {
                    setTake(false);
                    go("name");
                  }}
                />
                {tab ? (
                  <Choice
                    icon="arrow.up.right"
                    title="Take This Tab"
                    subtitle={`${tab.title} moves into it.`}
                    onPress={() => {
                      setTake(true);
                      go("name");
                    }}
                  />
                ) : null}
              </View>
            ) : step === "name" ? (
              <View style={{ gap: 12 }}>
                {card}
                <NameField value={name} onChange={setName} onSubmit={() => go("look")} onEscape={() => finish(null)} />
                <PrimaryButton title="Continue" onPress={() => go("look")} />
              </View>
            ) : step === "look" ? (
              <View style={{ gap: 12 }}>
                {card}
                <ThemeControls look={look} width={inner} onChange={setLook} />
                <PrimaryButton title="Continue" onPress={() => go("signins")} />
              </View>
            ) : (
              <View style={{ gap: 8 }}>
                {card}
                <Option
                  title="Shared Sign-ins"
                  subtitle={`Signed in wherever ${fromName} is: the same logins and passwords.`}
                  on={shared}
                  onPress={() => setShared(true)}
                />
                <Option
                  title="Its Own Sign-ins"
                  subtitle="Starts signed out, with cookies, history and passwords of its own."
                  on={!shared}
                  onPress={() => setShared(false)}
                />
                <View style={{ height: 4 }} />
                <PrimaryButton title="Create Space" onPress={create} />
              </View>
            )}
          </Slide>
        </Surface>
      </Animated.View>
    </>
  );
}

// Each step slides in from the side it comes from.
function Slide({ back, children }: { back: boolean; children: ReactNode }) {
  const p = useSharedValue(0);
  useEffect(() => p.set(withTiming(1, { duration: 220, easing: Easing.out(Easing.cubic) })), []);
  const style = useAnimatedStyle(() => ({ opacity: p.get(), transform: [{ translateX: (1 - p.get()) * (back ? -18 : 18) }] }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

function HeaderButton({ icon, label, onPress }: { icon: string; label: string; onPress(): void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress} accessibilityLabel={label} tooltip={label}>
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: hovered ? theme.tabHover : undefined,
          }}
        >
          <Symbol name={icon} size={13} weight="semibold" color={theme.textSecondary} style={{ width: 16, height: 16 }} />
        </View>
      </Pressable>
    </View>
  );
}

const tile = (dark: boolean, hovered = false) =>
  dark ? (hovered ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.06)") : hovered ? "rgba(0,0,0,0.07)" : "rgba(0,0,0,0.04)";

function Choice({ icon, title, subtitle, onPress }: { icon: string; title: string; subtitle: string; onPress(): void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 14, backgroundColor: tile(theme.dark, hovered) }}>
          <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: tile(theme.dark, true) }}>
            <Symbol name={icon} size={15} weight="medium" color={theme.textPrimary} style={{ width: 18, height: 18 }} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14.5, fontWeight: "700", color: theme.textPrimary }}>{title}</Text>
            <Text numberOfLines={2} style={{ fontSize: 12.5, lineHeight: 16, color: theme.textSecondary, marginTop: 1 }}>
              {subtitle}
            </Text>
          </View>
          <Symbol name="chevron.right" size={11} weight="semibold" color={theme.textTertiary} style={{ width: 14, height: 14 }} />
        </View>
      </Pressable>
    </View>
  );
}

// The space as it's made: its icon (tap it, while naming, to choose another) and its name.
function Card({ icon, name, take, big, onIcon }: { icon: string; name: string; take: boolean; big: boolean; onIcon?: (icon: string) => void }) {
  const theme = useTheme();
  const [picking, setPicking] = useState(false);
  return (
    <View style={{ borderRadius: 14, backgroundColor: tile(theme.dark), padding: big ? 14 : 10 }}>
      <View style={{ flexDirection: big ? "column" : "row", alignItems: big ? "flex-start" : "center", gap: big ? 10 : 10 }}>
        <View style={{ flexDirection: "row", alignSelf: "stretch", alignItems: "flex-start", justifyContent: "space-between" }}>
          <Pressable
            onPress={() => onIcon && setPicking(!picking)}
            disabled={!onIcon}
            accessibilityLabel="Change Icon"
            tooltip={onIcon ? "Change icon" : undefined}
          >
            <View
              style={{
                width: big ? 48 : 26,
                height: big ? 48 : 26,
                borderRadius: big ? 24 : 13,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: big ? tile(theme.dark, true) : undefined,
              }}
            >
              <Text style={{ fontSize: big ? 24 : 18 }}>{icon}</Text>
            </View>
          </Pressable>
          {big ? <Text style={{ fontSize: 12.5, fontWeight: "600", color: theme.textSecondary }}>{take ? "1 tab" : "No tabs yet"}</Text> : null}
        </View>
        <Text
          numberOfLines={1}
          style={{ fontSize: big ? 20 : 15, fontWeight: "700", color: name.trim() ? theme.textPrimary : theme.textTertiary, flexShrink: 1 }}
        >
          {name.trim() || "Untitled"}
        </Text>
      </View>
      {picking && onIcon ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 10 }}>
          {SPACE_EMOJI.map((e) => (
            <Pressable
              key={e}
              onPress={() => {
                onIcon(e);
                setPicking(false);
              }}
              accessibilityLabel={e}
            >
              <View
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: e === icon ? tile(theme.dark, true) : undefined,
                }}
              >
                <Text style={{ fontSize: 18 }}>{e}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function NameField({ value, onChange, onSubmit, onEscape }: { value: string; onChange(v: string): void; onSubmit(): void; onEscape(): void }) {
  const theme = useTheme();
  const input = useRef<TextInput>(null);
  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);
  return (
    <View
      style={{
        height: 42,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)",
        backgroundColor: theme.dark ? "rgba(0,0,0,0.2)" : "#FFFFFF",
        justifyContent: "center",
        paddingHorizontal: 12,
      }}
    >
      <TextInput
        ref={input}
        value={value}
        onChangeText={onChange}
        placeholder="Name"
        placeholderTextColor={theme.placeholder}
        selectionColor={theme.selection}
        enableFocusRing={false}
        onSubmitEditing={onSubmit}
        keyDownEvents={[{ key: "Escape" }]}
        onKeyPress={onEscapeKey(onEscape)}
        style={{ fontSize: 15, color: theme.textPrimary, paddingVertical: 0 }}
      />
    </View>
  );
}

function Option({ title, subtitle, on, onPress }: { title: string; subtitle: string; on: boolean; onPress(): void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={title}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 14, backgroundColor: tile(theme.dark, hovered) }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14.5, fontWeight: "700", color: theme.textPrimary }}>{title}</Text>
            <Text style={{ fontSize: 12.5, lineHeight: 16, color: theme.textSecondary, marginTop: 1 }}>{subtitle}</Text>
          </View>
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: on ? 0 : 1.5,
              borderColor: theme.textTertiary,
              backgroundColor: on ? (theme.dark ? "#F2F2F2" : "#1C1C1E") : undefined,
            }}
          >
            {on ? <Symbol name="checkmark" size={11} weight="bold" color={theme.dark ? "#1C1C1E" : "#FFFFFF"} style={{ width: 14, height: 14 }} /> : null}
          </View>
        </View>
      </Pressable>
    </View>
  );
}

function PrimaryButton({ title, onPress }: { title: string; onPress(): void }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      {({ pressed }) => (
        <View
          style={{
            height: 44,
            borderRadius: 13,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.dark ? "#EDEDED" : "#1C1C1E",
            opacity: pressed ? 0.8 : 1,
          }}
        >
          <Text style={{ fontSize: 15, fontWeight: "700", color: theme.dark ? "#1C1C1E" : "#FFFFFF" }}>{title}</Text>
        </View>
      )}
    </Pressable>
  );
}
