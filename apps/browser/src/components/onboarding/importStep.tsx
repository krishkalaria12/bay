import type { BrowserSource } from "@bay/import";
import { WindowBackdrop } from "@bay/shaders";
import { fileIcon, hapticTick, Surface, Symbol } from "@bay/shell";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Image, PanResponder, Pressable, StyleSheet, Text, View, type ImageSourcePropType } from "react-native";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { APP_ICON } from "../../lib/assets";
import { APP_NAME } from "../../lib/constants";
import { reduceMotion } from "../../lib/reduceMotion";
import { useEffectEvent } from "../../lib/useEffectEvent";
import { plural } from "../../store/model";
import { importedSummary } from "../import/apply";
import { KINDS } from "../import/constants";
import { useImportFlow, type ImportFlow, type Status } from "../import/useImportFlow";
import { useHover } from "../primitives";
import { openImport } from "../settings/windows";
import {
  BAY_GLOW,
  BAY_SKY,
  HANDOFF_COLORS,
  HANDOFF_DIP,
  HANDOFF_DOTS,
  HANDOFF_DROP_RADIUS,
  HANDOFF_FALLBACK_COLORS,
  HANDOFF_ICON,
  HANDOFF_SPRING,
  HANDOFF_TOOTH,
} from "./constants";
import { bundledBrowserIcon, detectBrowsers } from "./browsers";
import { nextStep, skipStep } from "./state";
import { Reveal, StepProgress } from "./ui";

// "Where are you coming from?" as a handoff: the card tears in two, the browser you're leaving on the left in its
// own colours, Bay on the right. Drag the old browser's icon into Bay's (or press Return) and the import runs right
// here: the left half folds away, Bay's fills the card, and the summary welcomes you in.

type Phase = "loading" | "empty" | "handoff" | "moving" | "welcome" | "window";

const ICON = HANDOFF_ICON;
const EASE = Easing.inOut(Easing.cubic);
const shortName = (name: string) => name.replace(/^(Google|Microsoft) /, "");
const listed = (items: string[]) => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
// Dia's tabs come over through Dia itself, so only its data import is offered here.
const offeredBrowsers = (flow: ImportFlow) => flow.browsers.filter((b) => b.family !== "automation");
// Full Disk Access (and Safari without it) has its own steps: those stay in the import window.
const needsWindow = (flow: ImportFlow, s: BrowserSource) => !!s.needsFullDiskAccess || (s.family === "safari" && !flow.fullDiskAccess);

// A browser to leave: found on this Mac straight away, with the importer's source for it once its scan is done.
type Leaving = { id: string; name: string; app?: string; iconPath?: string };

// Until the scan is done, what's installed. Then the scan has the final word: an app with nothing in it to bring
// drops out, and one installed somewhere else comes in.
function leavingList(found: Leaving[], flow: ImportFlow, scanned: boolean): Leaving[] {
  if (!scanned) return found;
  const sources = offeredBrowsers(flow);
  return [
    ...found.filter((b) => sources.some((s) => s.id === b.id)),
    ...sources.filter((s) => !found.some((b) => b.id === s.id)).map((s) => ({ id: s.id, name: s.name, iconPath: s.iconPath })),
  ];
}

function phaseOf(flow: ImportFlow, handedOff: boolean, queued: boolean, leaving: boolean): Phase {
  if (handedOff) return "window";
  if (flow.step === "done") return "welcome";
  if (queued || flow.unlocking || flow.step === "progress") return "moving";
  if (leaving) return "handoff";
  return flow.step === "loading" ? "loading" : "empty";
}

type Chip = { id: string; title: string; color?: string; on: boolean; toggle: () => void };

// Before the scan has a browser's profiles, and for one with a single profile: nothing to choose.
const NO_CHIPS = { chips: [] as Chip[], hint: "Thanks for all the tabs." };
const USUAL_CARGO = "your tabs, passwords and history";

// Arc's spaces, or another browser's profiles, to leave behind or bring along. One of either needs no choosing.
function chipsOf(flow: ImportFlow): { chips: Chip[]; hint: string } {
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const source = flow.source;
  if (flow.isArc && flow.allSpaces.length > 1) {
    return {
      hint: "Click a space to leave it behind.",
      chips: flow.allSpaces.map((s) => ({
        id: s.id,
        title: s.emoji ? `${s.emoji} ${s.name || "Space"}` : s.name || "Space",
        color: s.emoji ? undefined : s.color,
        on: flow.spaces.includes(s.id),
        toggle: () => flow.setSpaces((prev) => toggle(prev, s.id)),
      })),
    };
  }
  if (source && source.family !== "safari" && source.profiles.length > 1) {
    return {
      hint: "Click a profile to bring it along too.",
      chips: source.profiles.map((p) => ({
        id: p.id,
        title: p.name,
        color: p.color,
        on: flow.sourceProfiles.includes(p.id),
        toggle: () => flow.setSourceProfiles((prev) => toggle(prev, p.id)),
      })),
    };
  }
  return NO_CHIPS;
}

// What the drop brings, for the right half's line: "3 spaces", "2 profiles", or the usual things.
function cargoOf(flow: ImportFlow) {
  if (flow.isArc && flow.allSpaces.length > 1) return plural(flow.spaces.length, "space");
  if (flow.sourceProfiles.length > 1) return plural(flow.sourceProfiles.length, "profile");
  return USUAL_CARGO;
}

function canDrop(flow: ImportFlow) {
  const s = flow.source;
  if (!s) return false;
  if (needsWindow(flow, s) || s.family === "safari") return true;
  if (!flow.kinds.size) return false;
  return flow.isArc && flow.allSpaces.length ? flow.spaces.length > 0 : flow.sourceProfiles.length > 0;
}

export function ImportStep() {
  const flow = useImportFlow();
  const [found] = useState<Leaving[]>(detectBrowsers);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [chosenId, setChosenId] = useState<string | null>(null);
  // Dropped before the scan was done: the id of the browser that waits for it.
  const [queued, setQueued] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [handedOff, setHandedOff] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const scanned = flow.step !== "loading";
  const offered = leavingList(found, flow, scanned);
  const leaving = offered.find((b) => b.id === chosenId) ?? offered[0] ?? null;
  // The importer's source for it, once the scan has it and the flow has chosen it.
  const detail = scanned && leaving && flow.source?.id === leaving.id ? flow.source : null;
  const phase = phaseOf(flow, handedOff, !!queued, !!leaving);
  const ready = phase === "handoff" && (!detail || canDrop(flow));
  const name = leaving ? shortName(leaving.name) : "";
  // The app's own icon once the system has it, the scan's copy of it, or the bundled one.
  const iconOf = (b: Leaving): ImageSourcePropType | null => {
    if (icons[b.id]) return { uri: icons[b.id] };
    if (b.iconPath) return { uri: `file://${b.iconPath}` };
    return bundledBrowserIcon(b.id);
  };

  // Starts folded, Bay's half alone: it tears open once there's a browser to leave.
  const split = useSharedValue(1);
  const lift = useSharedValue(0);
  const near = useSharedValue(0);
  const absorb = useSharedValue(0);
  const gulp = useSharedValue(0);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const dropping = useRef(false);
  const keys = useRef<View>(null);

  const half = size.width / 2;
  const iconTop = Math.round(size.height * 0.24);

  const begin = () => {
    const s = flow.source;
    if (!s) return;
    if (needsWindow(flow, s)) {
      openImport(s.id);
      setHandedOff(true);
      return;
    }
    flow.importNow();
  };

  // The apps' own icons replace the bundled ones as the system hands them over.
  useEffect(() => {
    let active = true;
    void Promise.all(found.map(async (b) => [b.id, b.app ? await fileIcon(b.app, 256).catch(() => null) : null] as const)).then((list) => {
      if (active) setIcons(Object.fromEntries(list.filter((e): e is [string, string] => !!e[1])));
    });
    return () => {
      active = false;
    };
  }, []);

  // The flow picks a browser of its own when its scan is done: it follows the one shown here.
  useEffect(() => {
    const s = leaving && offeredBrowsers(flow).find((b) => b.id === leaving.id);
    if (scanned && s && flow.source?.id !== s.id) flow.choose(s);
  }, [scanned, leaving?.id]);

  useEffect(() => {
    if (!queued || !scanned) return;
    if (detail?.id === queued) {
      setQueued(null);
      return begin();
    }
    // The scan found nothing in it to bring over.
    if (!offeredBrowsers(flow).some((b) => b.id === queued)) {
      setNotice(`${shortName(found.find((b) => b.id === queued)?.name ?? "That browser")} has nothing to bring over yet.`);
      setQueued(null);
    }
  }, [queued, scanned, detail?.id]);

  useEffect(() => {
    const open = phase === "handoff";
    if (reduceMotion()) split.set(withTiming(open ? 0 : 1, { duration: 160 }));
    else split.set(withTiming(open ? 0 : 1, { duration: open ? 620 : 560, easing: EASE }));
    // Back to the handoff (macOS refused the keychain, or Try Again): the icon returns to its side.
    if (open) {
      dropping.current = false;
      tx.set(0);
      ty.set(0);
      near.set(0);
      lift.set(withTiming(0, { duration: 160 }));
      absorb.set(withTiming(0, { duration: 260 }));
    }
    const t = setTimeout(() => (keys.current as unknown as { focus?: () => void } | null)?.focus?.(), 50);
    return () => clearTimeout(t);
  }, [phase]);

  // The icon goes into Bay's: from wherever the drag let go of it, or along the dotted path for Return.
  const drop = (fromDrag: boolean) => {
    if (dropping.current || !ready || !leaving) return;
    dropping.current = true;
    setNotice(null);
    hapticTick();
    const id = leaving.id;
    const done = () => (detail ? begin() : setQueued(id));
    if (reduceMotion()) {
      absorb.set(
        withTiming(1, { duration: 140 }, (finished) => {
          if (finished) runOnJS(done)();
        }),
      );
      return;
    }
    const travel = fromDrag ? 220 : 520;
    tx.set(withTiming(half, { duration: travel, easing: EASE }));
    ty.set(
      fromDrag
        ? withTiming(0, { duration: travel, easing: EASE })
        : withSequence(
            withTiming(HANDOFF_DIP, { duration: travel / 2, easing: Easing.out(Easing.quad) }),
            withTiming(0, { duration: travel / 2, easing: Easing.in(Easing.quad) }),
          ),
    );
    lift.set(withTiming(1, { duration: travel / 2 }));
    absorb.set(
      withDelay(
        travel - 120,
        withTiming(1, { duration: 200 }, (finished) => {
          if (finished) runOnJS(done)();
        }),
      ),
    );
    gulp.set(withDelay(travel - 40, withSequence(withTiming(1, { duration: 110 }), withSpring(0, HANDOFF_SPRING))));
  };

  // The pan responder is made once: these read this render's phase, geometry and flow.
  const canGrab = useEffectEvent(() => phase === "handoff" && !dropping.current);
  const overBay = useEffectEvent((dx: number, dy: number) => ready && Math.hypot(dx - half, dy) < HANDOFF_DROP_RADIUS);
  const dropped = useEffectEvent(() => drop(true));

  // A click without a drag nudges the icon toward Bay: that's the way it goes.
  const nudge = () => {
    if (reduceMotion()) return;
    tx.set(withSequence(withTiming(22, { duration: 180, easing: Easing.out(Easing.quad) }), withSpring(0, HANDOFF_SPRING)));
    ty.set(withSequence(withTiming(6, { duration: 180 }), withSpring(0, HANDOFF_SPRING)));
  };

  const [pan] = useState(() => {
    let over = false;
    let moved = false;
    const settle = () => {
      tx.set(withSpring(0, HANDOFF_SPRING));
      ty.set(withSpring(0, HANDOFF_SPRING));
      lift.set(withTiming(0, { duration: 180 }));
      near.set(withTiming(0, { duration: 140 }));
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: canGrab,
      onPanResponderGrant: () => {
        over = false;
        moved = false;
        lift.set(withSpring(1, HANDOFF_SPRING));
      },
      onPanResponderMove: (_, g) => {
        if (Math.abs(g.dx) + Math.abs(g.dy) > 3) moved = true;
        tx.set(g.dx);
        ty.set(g.dy);
        const inside = overBay(g.dx, g.dy);
        if (inside === over) return;
        over = inside;
        if (inside) hapticTick();
        near.set(withTiming(inside ? 1 : 0, { duration: 140 }));
      },
      onPanResponderRelease: () => {
        if (over) return dropped();
        settle();
        if (!moved) nudge();
      },
      onPanResponderTerminate: settle,
      onPanResponderTerminationRequest: () => false,
    });
  });

  const picked = [`Your things from ${name}`];
  const finish = () => nextStep(importedSummary(flow.counts).length ? picked : []);

  const primary = () => {
    if (phase === "handoff") return drop(false);
    if (phase === "welcome") return finish();
    if (phase === "window") return nextStep(picked);
    if (phase === "empty") return nextStep([]);
  };

  const leftStyle = useAnimatedStyle(() => ({ width: half * (1 - split.get()) }));
  const seamStyle = useAnimatedStyle(() => ({
    opacity: interpolate(split.get(), [0, 0.92, 1], [1, 1, 0]),
    transform: [{ translateX: half * (1 - split.get()) }],
  }));
  const pathStyle = useAnimatedStyle(() => ({
    opacity: interpolate(split.get(), [0, 0.12], [1, 0], Extrapolation.CLAMP) * (1 - absorb.get()) * interpolate(lift.get(), [0, 1], [1, 0.5]),
  }));
  const iconStyle = useAnimatedStyle(() => ({
    opacity: (1 - absorb.get()) * interpolate(split.get(), [0, 0.3], [1, 0], Extrapolation.CLAMP),
    transform: [
      { translateX: tx.get() - split.get() * half },
      { translateY: ty.get() },
      { rotate: `${interpolate(lift.get(), [0, 1], [0, -8])}deg` },
      { scale: interpolate(lift.get(), [0, 1], [1, 1.08]) * interpolate(absorb.get(), [0, 1], [1, 0.35]) * interpolate(near.get(), [0, 1], [1, 0.92]) },
    ],
  }));

  return (
    <View
      ref={keys}
      focusable
      enableFocusRing={false}
      keyDownEvents={[{ key: "Enter" }]}
      onKeyDown={primary}
      onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
      style={{ flex: 1, flexDirection: "row", borderRadius: 20, overflow: "hidden", backgroundColor: BAY_SKY }}
    >
      {size.width > 0 ? (
        <>
          <Animated.View style={[{ height: "100%", overflow: "hidden" }, leftStyle]}>
            {leaving ? (
              <FarewellHalf key={leaving.id} leaving={leaving} parts={detail ? chipsOf(flow) : NO_CHIPS} width={half} iconTop={iconTop} lift={lift}>
                {offered.length > 1 ? (
                  <Switcher
                    offered={offered.map((b) => ({ ...b, icon: iconOf(b) }))}
                    selected={leaving.id}
                    onChoose={(id) => {
                      setChosenId(id);
                      setNotice(null);
                    }}
                  />
                ) : null}
              </FarewellHalf>
            ) : null}
          </Animated.View>
          <BayHalf
            flow={flow}
            phase={phase}
            name={name}
            cargo={detail ? cargoOf(flow) : USUAL_CARGO}
            canDrop={ready}
            waiting={!!queued}
            notice={notice}
            iconTop={iconTop}
            near={near}
            gulp={gulp}
            onPrimary={primary}
            onBack={() => setHandedOff(false)}
          />
          <Animated.View pointerEvents="none" style={[{ position: "absolute", top: 0, bottom: 0, left: -HANDOFF_TOOTH, width: HANDOFF_TOOTH * 2 }, seamStyle]}>
            <Teeth height={size.height} />
          </Animated.View>
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, pathStyle]}>
            <DottedPath from={half / 2 + ICON / 2 + 16} to={half * 1.5 - ICON / 2 - 16} y={iconTop + ICON / 2} />
          </Animated.View>
          {leaving ? (
            <Animated.View
              {...pan.panHandlers}
              accessible
              accessibilityRole="button"
              accessibilityLabel={`Bring your things from ${leaving.name} to ${APP_NAME}`}
              accessibilityActions={[{ name: "activate" }]}
              onAccessibilityAction={() => drop(false)}
              style={[{ position: "absolute", left: half / 2 - ICON / 2, top: iconTop, width: ICON, height: ICON }, iconStyle]}
            >
              <SourceIcon name={name} icon={iconOf(leaving)} />
            </Animated.View>
          ) : null}
          <View pointerEvents="none" style={{ position: "absolute", top: 26, left: 30 }}>
            <StepProgress onColor />
          </View>
        </>
      ) : null}
    </View>
  );
}

// MARK: The browser you're leaving

function FarewellHalf({
  leaving,
  parts,
  width,
  iconTop,
  lift,
  children,
}: {
  leaving: Leaving;
  parts: { chips: Chip[]; hint: string };
  width: number;
  iconTop: number;
  lift: SharedValue<number>;
  children: ReactNode;
}) {
  const colors = HANDOFF_COLORS[leaving.id] ?? HANDOFF_FALLBACK_COLORS;
  const { chips, hint } = parts;
  const farewell = useAnimatedStyle(() => ({ opacity: 1 - lift.get(), transform: [{ translateY: interpolate(lift.get(), [0, 1], [0, -6]) }] }));
  const goodbye = useAnimatedStyle(() => ({ opacity: lift.get(), transform: [{ translateY: interpolate(lift.get(), [0, 1], [6, 0]) }] }));
  return (
    // Anchored to the seam, so as the half folds away its content slides out to the left.
    <View style={{ position: "absolute", top: 0, bottom: 0, right: 0, width }}>
      <WindowBackdrop colors={colors} angle={215} grainOpacity={0.07} style={StyleSheet.absoluteFill} />
      <Glow color="#FFFFFF" opacity={0.35} top={iconTop} />
      <Reveal style={{ position: "absolute", top: iconTop + ICON + 26, left: 28, right: 28, alignItems: "center" }}>
        <View style={{ alignSelf: "stretch" }}>
          <Animated.View style={farewell}>
            <Headline title={`A farewell\nto ${shortName(leaving.name)}`} subtitle={hint} />
          </Animated.View>
          <Animated.View style={[StyleSheet.absoluteFill, goodbye]}>
            <Headline title={"Thanks for\nthe memories"} subtitle={`${APP_NAME} will take it from here.`} />
          </Animated.View>
        </View>
        {chips.length ? (
          <Reveal>
            <Chips chips={chips} />
          </Reveal>
        ) : null}
      </Reveal>
      {children}
    </View>
  );
}

function SourceIcon({ name, icon }: { name: string; icon: ImageSourcePropType | null }) {
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps} tooltip={`Drag ${name} into ${APP_NAME}`} style={{ transform: [{ scale: hovered ? 1.04 : 1 }] }}>
      <AppIcon icon={icon} size={ICON} />
    </View>
  );
}

function AppIcon({ icon, size }: { icon: ImageSourcePropType | null; size: number }) {
  if (!icon) return <Symbol name="globe" size={Math.round(size * 0.6)} color="#FFFFFF" style={{ width: size, height: size }} />;
  return <Image source={icon} style={{ width: size, height: size }} />;
}

function Chips({ chips }: { chips: Chip[] }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 6, marginTop: 18 }}>
      {chips.map((c) => (
        <ChipButton key={c.id} chip={c} />
      ))}
    </View>
  );
}

function ChipButton({ chip }: { chip: Chip }) {
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps}>
      <Pressable onPress={chip.toggle} accessibilityRole="checkbox" accessibilityState={{ checked: chip.on }} accessibilityLabel={chip.title}>
        <View
          style={{
            height: 24,
            maxWidth: 150,
            borderRadius: 12,
            paddingHorizontal: 10,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            backgroundColor: chip.on ? (hovered ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.22)") : hovered ? "rgba(255,255,255,0.08)" : "transparent",
            borderWidth: 1,
            borderColor: chip.on ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.22)",
          }}
        >
          {chip.color ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: chip.color, opacity: chip.on ? 1 : 0.5 }} /> : null}
          <Text
            numberOfLines={1}
            style={{
              fontSize: 11.5,
              fontWeight: "600",
              color: chip.on ? "#FFFFFF" : "rgba(255,255,255,0.5)",
              textDecorationLine: chip.on ? "none" : "line-through",
            }}
          >
            {chip.title}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

// The other browsers found on this Mac, small along the foot: coming from one of those instead.
function Switcher({
  offered,
  selected,
  onChoose,
}: {
  offered: (Leaving & { icon: ImageSourcePropType | null })[];
  selected: string;
  onChoose: (id: string) => void;
}) {
  return (
    <View style={{ position: "absolute", left: 0, right: 0, bottom: 22, alignItems: "center", gap: 8 }}>
      <Text style={{ fontSize: 11, fontWeight: "500", color: "rgba(255,255,255,0.6)" }}>Coming from somewhere else?</Text>
      <View style={{ flexDirection: "row", gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel="Browser">
        {offered.slice(0, 8).map((b) => (
          <SwitcherIcon key={b.id} name={b.name} icon={b.icon} selected={selected === b.id} onPress={() => onChoose(b.id)} />
        ))}
      </View>
    </View>
  );
}

function SwitcherIcon({ name, icon, selected, onPress }: { name: string; icon: ImageSourcePropType | null; selected: boolean; onPress: () => void }) {
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps} tooltip={name}>
      <Pressable onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={name}>
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: selected ? "rgba(255,255,255,0.24)" : hovered ? "rgba(255,255,255,0.12)" : "transparent",
            borderWidth: selected ? 1 : 0,
            borderColor: "rgba(255,255,255,0.4)",
          }}
        >
          <AppIcon icon={icon} size={22} />
        </View>
      </Pressable>
    </View>
  );
}

// MARK: Bay

function BayHalf({
  flow,
  phase,
  name,
  cargo,
  canDrop,
  waiting,
  notice,
  iconTop,
  near,
  gulp,
  onPrimary,
  onBack,
}: {
  flow: ImportFlow;
  phase: Phase;
  name: string;
  cargo: string;
  canDrop: boolean;
  waiting: boolean;
  notice: string | null;
  iconTop: number;
  near: SharedValue<number>;
  gulp: SharedValue<number>;
  onPrimary: () => void;
  onBack: () => void;
}) {
  const breathe = useSharedValue(0);
  useEffect(() => {
    if (phase !== "moving" || reduceMotion()) return breathe.set(withTiming(0, { duration: 200 }));
    breathe.set(withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.sin) }), -1, true));
  }, [phase]);
  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + near.get() * 0.1 + gulp.get() * 0.14 + breathe.get() * 0.04 }],
  }));
  const ringStyle = useAnimatedStyle(() => ({ opacity: near.get(), transform: [{ scale: interpolate(near.get(), [0, 1], [0.9, 1]) }] }));
  return (
    <View style={{ flex: 1, height: "100%", backgroundColor: BAY_SKY }}>
      <Stars />
      <Glow color={BAY_GLOW} opacity={0.55} top={iconTop} />
      <View style={{ position: "absolute", top: iconTop, left: 0, right: 0, alignItems: "center" }}>
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              top: -12,
              width: ICON + 24,
              height: ICON + 24,
              borderRadius: 30,
              borderWidth: 1.5,
              borderStyle: "dashed",
              borderColor: "rgba(255,255,255,0.7)",
            },
            ringStyle,
          ]}
        />
        <Animated.View style={iconStyle}>
          <Image source={APP_ICON} style={{ width: ICON, height: ICON }} />
        </Animated.View>
      </View>
      <Reveal
        key={revealKey(phase, waiting, flow.unlocking)}
        delay={phase === "handoff" ? 0 : 260}
        style={{ position: "absolute", top: iconTop + ICON + 26, left: 32, right: 32, alignItems: "center" }}
      >
        <BayContent
          flow={flow}
          phase={phase}
          name={name}
          cargo={cargo}
          canDrop={canDrop}
          waiting={waiting}
          notice={notice}
          near={near}
          onPrimary={onPrimary}
          onBack={onBack}
        />
      </Reveal>
      {phase === "handoff" || phase === "empty" ? (
        <View style={{ position: "absolute", right: 22, bottom: 22 }}>
          <PillButton title="Start fresh" onPress={skipStep} />
        </View>
      ) : null}
    </View>
  );
}

// The right half's text comes in again for each phase, and for each wait within "moving".
function revealKey(phase: Phase, waiting: boolean, unlocking: boolean) {
  if (waiting) return "waiting";
  if (unlocking) return "unlocking";
  return phase;
}

function BayContent({
  flow,
  phase,
  name,
  cargo,
  canDrop,
  waiting,
  notice,
  near,
  onPrimary,
  onBack,
}: {
  flow: ImportFlow;
  phase: Phase;
  name: string;
  cargo: string;
  canDrop: boolean;
  waiting: boolean;
  notice: string | null;
  near: SharedValue<number>;
  onPrimary: () => void;
  onBack: () => void;
}) {
  const idle = useAnimatedStyle(() => ({ opacity: 1 - near.get() }));
  const over = useAnimatedStyle(() => ({ opacity: near.get() }));
  switch (phase) {
    case "loading":
      return <ActivityIndicator size="small" color="#FFFFFF" />;
    case "empty":
      return (
        <>
          <Headline
            title={`Welcome to ${APP_NAME}.`}
            subtitle={
              flow.available ? "No other browsers to bring things from, so you're starting fresh." : `Importing isn't available in this build of ${APP_NAME}.`
            }
          />
          <Actions>
            <PillButton title="Continue" filled onPress={onPrimary} />
          </Actions>
        </>
      );
    case "handoff": {
      const problem = flow.error ?? notice;
      return (
        <>
          <View style={{ alignSelf: "stretch" }}>
            <Animated.View style={idle}>
              <Headline
                title={`Bring it all\nto ${APP_NAME}.`}
                subtitle={canDrop ? `Drag ${name} here, or press Return, to bring ${cargo}.` : "Choose at least one to bring along."}
              />
            </Animated.View>
            <Animated.View style={[StyleSheet.absoluteFill, over]}>
              <Headline title={`Bring it all\nto ${APP_NAME}.`} subtitle="Let go to bring it over." />
            </Animated.View>
          </View>
          {problem ? (
            <Text style={{ fontSize: 12, lineHeight: 17, color: "#FFC48A", textAlign: "center", marginTop: 14, maxWidth: 340 }}>{problem}</Text>
          ) : null}
          {flow.error ? (
            <Actions>
              <PillButton title="Skip Passwords" onPress={flow.skipEncrypted} />
            </Actions>
          ) : null}
        </>
      );
    }
    case "moving":
      if (waiting) return <Headline title="Getting ready…" subtitle={`Looking through ${name}'s profiles.`} />;
      return flow.unlocking ? (
        <Headline
          title="One quick check"
          subtitle={`macOS asks for your Mac password to open ${name}'s saved passwords and sign-ins. Click Always Allow, and they stay on this Mac.`}
        />
      ) : (
        <>
          <Headline title="Moving in…" subtitle={`Bringing your things over from ${name}.`} />
          <KindPills status={flow.status} />
        </>
      );
    case "welcome":
      return <Welcome flow={flow} onContinue={onPrimary} />;
    case "window":
      return (
        <>
          <Headline title="Almost there" subtitle={`${name} needs a little more from macOS. Finish up in the import window, then carry on here.`} />
          <Actions>
            <PillButton title="Back" onPress={onBack} />
            <PillButton title="Continue" filled onPress={onPrimary} />
          </Actions>
        </>
      );
  }
}

function Welcome({ flow, onContinue }: { flow: ImportFlow; onContinue: () => void }) {
  const summary = importedSummary(flow.counts);
  const failed = flow.failures.map((f) => KINDS.find((k) => k.kind === f.kind)?.title.toLowerCase() ?? f.kind);
  const subtitle = [
    summary.length ? `${listed(summary)} came along.` : "There was nothing new to bring over.",
    failed.length ? `${listed(failed).replace(/^./, (c) => c.toUpperCase())} didn't make it.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <Headline title={summary.length || !failed.length ? `Welcome to ${APP_NAME}.` : "That didn't work"} subtitle={subtitle} />
      {flow.notes.length ? (
        <Text numberOfLines={3} style={{ fontSize: 11.5, lineHeight: 16, color: "rgba(255,255,255,0.5)", textAlign: "center", marginTop: 10, maxWidth: 420 }}>
          {flow.notes.join(" ")}
        </Text>
      ) : null}
      <Actions>
        {failed.length ? <PillButton title="Try Again" onPress={() => flow.setStep("choose")} /> : null}
        {flow.extensions.length ? (
          <PillButton
            title={flow.extensions.length === 1 ? "Open in Chrome Web Store" : `Open ${flow.extensions.length} in Chrome Web Store`}
            onPress={flow.openExtensions}
          />
        ) : null}
        <PillButton title="Continue" filled onPress={onContinue} />
      </Actions>
    </>
  );
}

function KindPills({ status }: { status: Partial<Record<string, Status>> }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 6, marginTop: 18, maxWidth: 440 }}>
      {KINDS.filter((k) => status[k.kind]).map((k, i) => (
        <Reveal key={k.kind} delay={i * 60}>
          <KindPill title={k.title} icon={k.icon} status={status[k.kind]!} />
        </Reveal>
      ))}
    </View>
  );
}

function pillSymbol(status: Status, icon: string) {
  if (status === "done") return "checkmark";
  if (status === "failed") return "exclamationmark.triangle.fill";
  return icon;
}

function KindPill({ title, icon, status }: { title: string; icon: string; status: Status }) {
  const pending = status === "pending";
  return (
    <View
      style={{
        height: 26,
        borderRadius: 13,
        paddingLeft: 9,
        paddingRight: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: status === "active" ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.1)",
      }}
    >
      {status === "active" ? (
        <ActivityIndicator size="small" color="#FFFFFF" style={{ width: 12, height: 12, transform: [{ scale: 0.6 }] }} />
      ) : (
        <Symbol
          name={pillSymbol(status, icon)}
          size={10}
          weight="semibold"
          color={status === "failed" ? "#FFC48A" : pending ? "rgba(255,255,255,0.45)" : "#FFFFFF"}
          style={{ width: 12, height: 12 }}
        />
      )}
      <Text style={{ fontSize: 11.5, fontWeight: "600", color: pending ? "rgba(255,255,255,0.45)" : "#FFFFFF" }}>{title}</Text>
    </View>
  );
}

// MARK: Pieces

function Headline({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={{ alignItems: "center", gap: 10 }}>
      <Text style={{ fontSize: 30, lineHeight: 34, fontWeight: "700", letterSpacing: -0.8, color: "#FFFFFF", textAlign: "center" }}>{title}</Text>
      {subtitle ? <Text style={{ fontSize: 13, lineHeight: 18, color: "rgba(255,255,255,0.72)", textAlign: "center", maxWidth: 340 }}>{subtitle}</Text> : null}
    </View>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", gap: 8, marginTop: 20 }}>{children}</View>;
}

function PillButton({ title, onPress, filled }: { title: string; onPress: () => void; filled?: boolean }) {
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}>
        {({ pressed }) => (
          <View
            style={{
              height: 34,
              borderRadius: 17,
              paddingHorizontal: 18,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: filled ? (hovered ? "#FFFFFF" : "rgba(255,255,255,0.92)") : hovered ? "rgba(255,255,255,0.12)" : "transparent",
              borderWidth: filled ? 0 : 1,
              borderColor: "rgba(255,255,255,0.28)",
              transform: [{ scale: pressed ? 0.97 : 1 }],
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: "600", color: filled ? BAY_SKY : "rgba(255,255,255,0.85)" }}>{title}</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

// A soft light behind an icon: a disc the icon hides, and its shadow spread wide.
function Glow({ color, opacity, top }: { color: string; opacity: number; top: number }) {
  return (
    <View pointerEvents="none" style={{ position: "absolute", top: top + 12, left: 0, right: 0, alignItems: "center" }}>
      <Surface
        fill={color}
        cornerRadius={(ICON - 24) / 2}
        shadowColor={color}
        shadowOpacity={1}
        shadowRadius={70}
        shadowOffset={[0, 0]}
        style={{ width: ICON - 24, height: ICON - 24, opacity }}
      />
    </View>
  );
}

// The tear: a column of diamonds in Bay's sky over the seam, so the left half's edge zigzags.
function Teeth({ height }: { height: number }) {
  const step = HANDOFF_TOOTH * Math.SQRT2;
  return Array.from({ length: Math.ceil(height / step) + 1 }, (_, i) => (
    <View
      key={i}
      style={{
        position: "absolute",
        left: HANDOFF_TOOTH / 2,
        top: i * step - HANDOFF_TOOTH / 2,
        width: HANDOFF_TOOTH,
        height: HANDOFF_TOOTH,
        backgroundColor: BAY_SKY,
        transform: [{ rotate: "45deg" }],
      }}
    />
  ));
}

// The way across: dots dipping from one icon to the other, a brighter run travelling along them toward Bay.
function DottedPath({ from, to, y }: { from: number; to: number; y: number }) {
  const march = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion()) return;
    march.set(withRepeat(withTiming(1, { duration: 1800, easing: Easing.linear }), -1, false));
  }, []);
  return Array.from({ length: HANDOFF_DOTS }, (_, i) => {
    const t = i / (HANDOFF_DOTS - 1);
    return <PathDot key={i} t={t} march={march} x={from + (to - from) * t} y={y + Math.sin(t * Math.PI) * HANDOFF_DIP} />;
  });
}

function PathDot({ t, march, x, y }: { t: number; march: SharedValue<number>; x: number; y: number }) {
  const style = useAnimatedStyle(() => {
    const behind = (march.get() - t + 1) % 1;
    return { opacity: 0.3 + 0.6 * Math.max(0, 1 - behind * 4) };
  });
  return (
    <Animated.View style={[{ position: "absolute", left: x - 1.5, top: y - 1.5, width: 3, height: 3, borderRadius: 1.5, backgroundColor: "#FFFFFF" }, style]} />
  );
}

// Bay's icon has a night sky; its half shares a few of the stars.
const STARS: [number, number, number][] = [
  [0.12, 0.1, 2],
  [0.34, 0.06, 1.5],
  [0.58, 0.13, 2],
  [0.82, 0.08, 1.5],
  [0.9, 0.22, 2],
  [0.2, 0.3, 1.5],
  [0.72, 0.34, 1.5],
  [0.08, 0.62, 2],
  [0.88, 0.58, 1.5],
  [0.3, 0.84, 1.5],
  [0.64, 0.9, 2],
];

function Stars() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {STARS.map(([x, y, r], i) => (
        <View
          key={i}
          style={{
            position: "absolute",
            left: `${x * 100}%`,
            top: `${y * 100}%`,
            width: r * 2,
            height: r * 2,
            borderRadius: r,
            backgroundColor: "#FFFFFF",
            opacity: 0.35,
          }}
        />
      ))}
    </View>
  );
}
