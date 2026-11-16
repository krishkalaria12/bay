// Settings, the whole screen, after Yab's (Phone/Sources/Settings/SettingsLayer.swift, Apache-2.0): it rises from below
// as a screen is presented while the browser behind dims a little, and drops away. Its head holds one round button (×
// on the index, ‹ on a page) and the title; the index is a search field over cards of coloured tiles; a page has its
// tile, name and one line, then sections of rows. A page comes in from the right as iOS pushes one, the one under it a
// third of the way left, and goes back by ‹, by a swipe from the left edge or by Android's back. Settings closes by ×,
// by a swipe down on its head, or by pulling its list down past the top.

import { defaultBrowser as askDefaultBrowser, makeDefaultBrowser } from "@bay/mobile-welcome";
import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import * as Effect from "effect/Effect";
import { useThemeColor } from "heroui-native";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef, type JSX, type ReactNode } from "react";
import { AppState, BackHandler, Keyboard, Platform, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { WALLPAPER_NAMES } from "@/browser/Wallpaper";
import type { ClearData } from "@/browser/clearData";
import { forgetLogin, savedLogins, type SavedLogin } from "@/browser/credentials";
import { CUSTOM_ENGINE_ID } from "@/browser/address";
import { Icon } from "@/chrome/Icon";
import { SPRING, useReducedMotion } from "@/chrome/motion";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Text } from "@/chrome/Text";
import { iconSize, inputFont, radius, space } from "@/chrome/tokens";
import type { EngineError } from "@/effect/ports/engine";
import { useCommand, useScopedWork } from "@/effect/react";
import { detectLocale, matchLocale, setLocale, useLocale, useSavedLocale, useT, type Locale } from "@/i18n";
import { holdSheetOpen } from "@/panels/openSheets";
import type { SimplePreferences, WallpaperId } from "@/store/types";

import { CustomEngine, TextSize, WallpaperPicker } from "./bodies";
import { SyncJoin, SyncPhrase } from "./syncBodies";
import { PhoneSync } from "@/sync/service";
import { useSyncStore } from "@/sync/state";
import {
  DRAWN_PAGES,
  ENTRIES,
  PAGE_BLURB,
  PAGE_TITLE,
  pageTile,
  searchEntries,
  sections,
  indexValue,
  isIndexPage,
  type ClearStage,
  type SettingsContext,
} from "./content";
import { HeadButton } from "./HeadButton";
import { entryId, INDEX, matchSettings, pathTo, type IndexAction, type IndexEntry, type SettingsMatch, type SettingsPage } from "./model";
import { IndexCard, IndexRow, PageHeader, Section } from "./SettingsRows";

export interface SettingsScreenProps {
  visible: boolean;
  /** One of the browser's sheets is open over Settings: Android's back is the sheet's. */
  covered?: boolean;
  onClose: () => void;
  engines: readonly { id: string; name: string }[];
  searchEngineId: string;
  onSearchEngineChange: (id: string) => void;
  /** The custom engine's address (C17), kept while another engine is chosen. */
  customSearchUrl: string | null;
  /** Chooses the custom engine with this address; the page only passes one that is https with `%s`. */
  onCustomEngine: (url: string) => void;
  archiveAfterDays: number | null;
  onArchiveAfterDaysChange: (days: number | null) => void;
  blockContent: boolean;
  /** What the blocker is doing, shown under its switch. */
  blockerDetail: string;
  onBlockContentChange: (enabled: boolean) => void;
  /** Sites where blocking is paused, and resuming one. */
  pausedHosts: readonly string[];
  onResumeBlocking: (host: string) => void;
  lockPrivateTabs: boolean;
  onLockPrivateTabsChange: (enabled: boolean) => void;
  wallpaper: WallpaperId;
  /** The user's photo, kept even while a built-in wallpaper is chosen. */
  wallpaperPhoto: string | null;
  onWallpaperChange: (id: WallpaperId, photo?: string) => void;
  preferences: SimplePreferences;
  onPreferencesChange: (update: Partial<SimplePreferences>) => void;
  /** Clears browsing data and starts the browser afresh. Settings runs it and shows how it ended. */
  clearData: Effect.Effect<void, EngineError, ClearData>;
  /** The browser's own sheets, opened over Settings from its index. */
  onImport: () => void;
  onBookmarks: () => void;
  onHistory: () => void;
  onDownloads: () => void;
  bookmarkCount: number;
  historyCount: number;
  downloadCount: number;
  /** How many times Bay broke since it was opened; shown on the row that reports it (B8). */
  crashCount: number;
  /** Sends the errors Bay kept, so they can be looked at. */
  onReportProblem: () => void;
  /** How many tabs are open, and sharing their addresses (C16). */
  openTabCount: number;
  onExportTabs: () => void;
  /** Opens a page in a new tab, from About (R4). */
  onOpenLink: (url: string) => void;
  /** The welcome again (C10). */
  onShowWelcome: () => void;
}

/** The head: 52 high under the status bar, its button 12 from the left. */
const HEAD = 52;
/** Pulled down this far past the top of a list, or dragged down by its head this far (or this fast), Settings closes. */

const PULL_TO_CLOSE = 90;
const CLOSE_DISTANCE = 120;
const CLOSE_VELOCITY = 600;
/** A page's edge swipe back: from the left 24, let go past 80 or quickly. */

const BACK_EDGE = 24;
const BACK_DISTANCE = 80;
const BACK_VELOCITY = 500;
/** How long a row a search opened stays lit. */

const LIT_MS = 1400;

/** iOS's presentation and navigation curves (Yab's settingsOpen, settingsClose, settingsPush, settingsBack). */
const iosCurve = Easing.bezier(0.32, 0.72, 0, 1);

function timing(duration: number, easing: typeof iosCurve, reduced: boolean) {
  return { duration: reduced ? 0 : duration, easing, reduceMotion: reduced ? ReduceMotion.Always : ReduceMotion.System };
}

/** How far a list has scrolled, as the head shows it: at the top, under the head, or past a page's own header. */
type Scrolled = "top" | "underHead" | "pastHeader";

function scrolledAt(y: number): Scrolled {
  if (y > 90) return "pastHeader";

  return y > 0.5 ? "underHead" : "top";
}

/** Mounted while open and while it drops away; a new opening starts on the index. */
export function SettingsScreen(props: SettingsScreenProps): JSX.Element | null {
  const [mounted, setMounted] = useState(props.visible);

  if (props.visible && !mounted) setMounted(true);

  return mounted ? <SettingsLayer {...props} onGone={() => setMounted(false)} /> : null;
}

function SettingsLayer(props: SettingsScreenProps & { onGone: () => void }): JSX.Element {
  const { visible, onClose, onGone, covered = false } = props;
  const t = useT();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const ground = useThemeColor("background");

  // Rising and dropping away, and a finger pulling it down by its head.
  const presence = useSharedValue(0);
  const pull = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      pull.value = withSpring(0, SPRING);
      presence.value = withTiming(1, timing(500, iosCurve, reduced));

      return holdSheetOpen();
    }

    presence.value = withTiming(0, timing(300, Easing.bezier(0.4, 0, 0.8, 0.2), reduced), (done) => {
      if (done) scheduleOnRN(onGone);
    });
  }, [visible, reduced, presence, pull, onGone]);

  const sheet = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - presence.value) * height + pull.value }] }));
  const dim = useAnimatedStyle(() => ({ opacity: 0.18 * presence.value * (1 - Math.min(pull.value / height, 1)) }));

  // The pages over the index, and the one a search opened at a row.
  const [stack, setStack] = useState<SettingsPage[]>([]);
  const [focus, setFocus] = useState<{ page: SettingsPage; row: string } | null>(null);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const coveredRef = useRef(covered);
  coveredRef.current = covered;

  // Which layers the UI thread sees (the index is 0) and how far the page in front is in: 1 in place, 0 off to the right.
  const count = useSharedValue(1);
  const progress = useSharedValue(1);
  const shown = useRef(0);
  const popping = useRef(false);

  useLayoutEffect(() => {
    const layers = stack.length;

    if (layers > shown.current) {
      count.value = layers + 1;
      progress.value = 0;
      progress.value = withTiming(1, timing(420, iosCurve, reduced));
    } else if (layers < shown.current) {
      count.value = layers + 1;
      progress.value = 1;
    }

    shown.current = layers;
  }, [stack.length, count, progress, reduced]);

  const push = useCallback((pages: SettingsPage[]) => {
    Keyboard.dismiss();
    setStack((current) => [...current, ...pages]);
  }, []);

  const finishPop = useCallback(() => {
    popping.current = false;
    setStack((current) => current.slice(0, -1));
  }, []);

  const pop = useCallback(() => {
    if (!stackRef.current.length || popping.current) return;
    popping.current = true;
    Keyboard.dismiss();
    progress.value = withTiming(0, timing(350, iosCurve, reduced), (done) => {
      if (done) scheduleOnRN(finishPop);
    });
  }, [finishPop, progress, reduced]);

  const close = useCallback(() => {
    Keyboard.dismiss();
    onClose();
  }, [onClose]);

  // Android's back goes back a page, then closes Settings.
  useEffect(() => {
    if (!visible) return;

    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (coveredRef.current) return false;

      if (stackRef.current.length) pop();
      else close();

      return true;
    });

    return () => subscription.remove();
  }, [visible, pop, close]);

  const ctx = useSettingsContext(props, () => close());
  const counts = { bookmarks: props.bookmarkCount, history: props.historyCount, downloads: props.downloadCount, crashes: props.crashCount };

  const actions: Record<IndexAction, () => void> = {
    bookmarks: props.onBookmarks,
    history: props.onHistory,
    downloads: props.onDownloads,
    import: props.onImport,
    report: props.onReportProblem,
  };

  function open(entry: IndexEntry, match?: SettingsMatch): void {
    if (entry.type === "action") {
      Keyboard.dismiss();
      actions[entry.action]();

      return;
    }

    const target = match?.page ?? entry.page;

    setFocus(match?.row ? { page: target, row: match.row } : null);
    push(match?.page ? pathTo(match.page) : [entry.page]);
  }

  // The head's title and its ground follow the list in front: "Settings" on the index, a page's name once its own has
  // scrolled away, the ground once anything is under the head.
  const [scrolled, setScrolled] = useState<Record<number, Scrolled>>({});
  const frontScrolled = scrolled[stack.length] ?? "top";

  // Only a change of state re-renders, not every point of a scroll.
  const reportScroll = useCallback((layer: number, y: number) => {
    const next = scrolledAt(y);

    setScrolled((current) => (current[layer] === next ? current : { ...current, [layer]: next }));
  }, []);

  const pageInFront = stack.at(-1);
  let title = t("settings.title");

  if (pageInFront) title = frontScrolled === "pastHeader" ? t(PAGE_TITLE[pageInFront]) : "";

  const headDrag = usePanGesture({
    activeOffsetY: [-1000, 8],
    failOffsetX: [-16, 16],
    onUpdate: (event) => {
      "worklet";
      pull.value = Math.max(0, event.translationY);
    },
    onDeactivate: (event) => {
      "worklet";

      if (!event.canceled && (event.translationY > CLOSE_DISTANCE || event.velocityY > CLOSE_VELOCITY)) {
        scheduleOnRN(close);

        return;
      }

      pull.value = withSpring(0, SPRING);
    },
  });

  // Let go of the edge swipe: on to the page under it, or back in place. Made here: a worklet can't call `timing`.
  const settle = timing(250, iosCurve, reduced);

  const edgeBack = usePanGesture({
    enabled: stack.length > 0,
    hitSlop: { left: 0, width: BACK_EDGE },
    activeOffsetX: [-1000, 10],
    failOffsetY: [-15, 15],
    onUpdate: (event) => {
      "worklet";
      progress.value = Math.min(Math.max(1 - event.translationX / width, 0), 1);
    },
    onDeactivate: (event) => {
      "worklet";

      if (!event.canceled && (event.translationX > BACK_DISTANCE || event.velocityX > BACK_VELOCITY)) {
        progress.value = withTiming(0, settle, (done) => {
          if (done) scheduleOnRN(finishPop);
        });

        return;
      }

      progress.value = withTiming(1, settle);
    },
  });

  const top = insets.top + HEAD;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={visible ? "auto" : "none"}>
      {/* Over the page's own status bar colours: Settings' ground is the app's, light or dark. */}
      {visible ? <StatusBar style="auto" /> : null}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: "#000" }, dim]} />
      <Animated.View testID="settings-screen" accessibilityViewIsModal style={[StyleSheet.absoluteFill, { backgroundColor: ground }, sheet]}>
        <GestureDetector gesture={edgeBack}>
          <View style={StyleSheet.absoluteFill}>
            <Layer index={0} ground={ground} covered={stack.length > 0} count={count} progress={progress} width={width}>
              <IndexPage top={top} bottom={insets.bottom} ctx={ctx} counts={counts} onOpen={open} onScroll={(y) => reportScroll(0, y)} onPullClose={close} />
            </Layer>
            {stack.map((page, index) => (
              <Layer
                key={`${index}-${page}`}
                index={index + 1}
                ground={ground}
                covered={index + 1 < stack.length}
                count={count}
                progress={progress}
                width={width}
              >
                <PageView
                  page={page}
                  top={top}
                  bottom={insets.bottom}
                  ctx={ctx}
                  focus={focus?.page === page ? focus.row : undefined}
                  onFocused={() => setFocus(null)}
                  onOpenPage={(next) => push([next])}
                  onScroll={(y) => reportScroll(index + 1, y)}
                  onPullClose={close}
                  body={drawnBody(page, props, pop)}
                />
              </Layer>
            ))}
          </View>
        </GestureDetector>
        <GestureDetector gesture={headDrag}>
          <View style={[styles.head, { paddingTop: insets.top, height: top }]}>
            <View
              pointerEvents="none"
              className="border-b border-foreground/10"
              style={[StyleSheet.absoluteFill, { backgroundColor: ground, opacity: frontScrolled === "top" ? 0 : 0.96 }]}
            />
            <View style={styles.headRow}>
              <HeadButton
                testID={stack.length ? "settings-screen-back" : "settings-screen-close"}
                kind={stack.length ? "back" : "close"}
                label={stack.length ? t("sheet.back") : t("sheet.close", { title: t("settings.title") })}
                onPress={stack.length ? pop : close}
              />
              <View pointerEvents="none" style={styles.headTitle}>
                <Text accessibilityRole="header" variant="headline" numberOfLines={1}>
                  {title}
                </Text>
              </View>
            </View>
          </View>
        </GestureDetector>
      </Animated.View>
    </View>
  );
}

/** A layer of the stack: the index (0) or a page, placed by how deep it is under the page in front. */
function Layer({
  index,
  ground,
  covered,
  count,
  progress,
  width,
  children,
}: {
  index: number;
  /** Opaque, so the page in front covers the one under it. */
  ground: string;
  /** Under the page in front: out of touch and out of VoiceOver and TalkBack. */
  covered: boolean;
  count: SharedValue<number>;
  progress: SharedValue<number>;
  width: number;
  children: ReactNode;
}): JSX.Element {
  const placed = useAnimatedStyle(() => {
    const depth = count.value - 1 - index;
    // Not yet counted: a page about to come in waits off to the right.
    let x = -width / 3;

    if (depth < 0) x = width;
    else if (depth === 0) x = (1 - progress.value) * width;
    else if (depth === 1) x = (-width / 3) * progress.value;

    return { transform: [{ translateX: x }], opacity: depth >= 2 ? 0 : 1, zIndex: index };
  });

  const shade = useAnimatedStyle(() => ({ opacity: count.value - 1 - index === 1 ? 0.08 * progress.value : 0 }));

  return (
    <Animated.View
      pointerEvents={covered ? "none" : "auto"}
      accessibilityElementsHidden={covered}
      importantForAccessibility={covered ? "no-hide-descendants" : "auto"}
      style={[StyleSheet.absoluteFill, { backgroundColor: ground }, placed]}
    >
      {children}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: "#000" }, shade]} />
    </Animated.View>
  );
}

/** The index: the search field, then the cards of entries, or what the search found. */
function IndexPage({
  top,
  bottom,
  ctx,
  counts,
  onOpen,
  onScroll,
  onPullClose,
}: {
  top: number;
  bottom: number;
  ctx: SettingsContext;
  counts: Parameters<typeof indexValue>[2];
  onOpen: (entry: IndexEntry, match?: SettingsMatch) => void;
  onScroll: (y: number) => void;
  onPullClose: () => void;
}): JSX.Element {
  const { t } = ctx;
  const [query, setQuery] = useState("");
  const entries = useMemo(() => (query.trim() ? searchEntries(ctx) : []), [query, ctx]);
  const matches = query.trim() ? matchSettings(query, entries) : [];

  return (
    <ScrollView
      testID="settings-index"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      scrollEventThrottle={16}
      onScroll={(event) => onScroll(event.nativeEvent.contentOffset.y)}
      onScrollEndDrag={(event) => {
        if (event.nativeEvent.contentOffset.y < -PULL_TO_CLOSE) onPullClose();
      }}
      contentContainerStyle={{ paddingTop: top + space.sm, paddingBottom: bottom + 40, paddingHorizontal: space.gutter }}
    >
      <SearchField value={query} onChange={setQuery} />
      {!query.trim() ? (
        <View style={{ gap: space.section }}>
          {INDEX.map((group, index) => (
            <IndexCard key={index}>
              {group.map((entry) => {
                const info = ENTRIES[entryKey(entry)];

                return (
                  <IndexRow
                    key={entryId(entry)}
                    testID={`settings-${entryId(entry)}`}
                    tile={info.tile}
                    title={t(info.title)}
                    detail={indexValue(entry, ctx, counts)}
                    onPress={() => onOpen(entry)}
                  />
                );
              })}
            </IndexCard>
          ))}
        </View>
      ) : matches.length ? (
        <IndexCard testID="settings-search-results">
          {matches.map((match) => {
            const info = ENTRIES[entryKey(match.entry)];

            return (
              <IndexRow
                key={match.id}
                testID={`settings-result-${match.id}`}
                tile={info.tile}
                title={t(info.title)}
                detail={match.detail}
                onPress={() => onOpen(match.entry, match)}
              />
            );
          })}
        </IndexCard>
      ) : (
        <Text testID="settings-search-empty" tone="muted" className="text-center" style={{ paddingVertical: space.md }}>
          {t("settings.search.empty")}
        </Text>
      )}
    </ScrollView>
  );
}

function entryKey(entry: IndexEntry): keyof typeof ENTRIES {
  if (entry.type === "action") return entry.action;

  return isIndexPage(entry.page) ? entry.page : "general";
}

/** The index's search: a white capsule on the page's grey, as its cards are. */
function SearchField({ value, onChange }: { value: string; onChange: (text: string) => void }): JSX.Element {
  const t = useT();
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");

  return (
    <View className="bg-surface" style={{ borderRadius: radius.card, marginBottom: space.lg }}>
      <View className="flex-row items-center" style={{ minHeight: 44, paddingHorizontal: 14, gap: space.sm }}>
        <Icon name="search" color={muted} size={iconSize.small} />
        <TextInput
          testID="settings-search-field"
          accessibilityLabel={t("settings.search.placeholder")}
          value={value}
          onChangeText={onChange}
          placeholder={t("settings.search.placeholder")}
          placeholderTextColor={muted}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          returnKeyType="search"
          clearButtonMode="never"
          style={[inputFont("body"), { flex: 1, color: foreground, paddingVertical: 10 }]}
        />
        {value ? (
          <PressFeedback
            testID="settings-search-clear"
            accessibilityRole="button"
            accessibilityLabel={t("settings.search.clear")}
            onPress={() => onChange("")}
            hitSlop={10}
            className="h-6 w-6 items-center justify-center rounded-full bg-foreground/15"
          >
            <Icon name="close" color={foreground} size={iconSize.inline} />
          </PressFeedback>
        ) : null}
      </View>
    </View>
  );
}

/** A page: its header, its sections, and what it draws itself; it scrolls to the row a search opened it at. */
function PageView({
  page,
  top,
  bottom,
  ctx,
  focus,
  onFocused,
  onOpenPage,
  onScroll,
  onPullClose,
  body,
}: {
  page: SettingsPage;
  top: number;
  bottom: number;
  ctx: SettingsContext;
  focus?: string;
  onFocused: () => void;
  onOpenPage: (page: SettingsPage) => void;
  onScroll: (y: number) => void;
  onPullClose: () => void;
  body: ReactNode;
}): JSX.Element {
  const { t } = ctx;
  const { height } = useWindowDimensions();
  const list = useRef<ComponentRef<typeof ScrollView>>(null);
  const sectionTops = useRef(new Map<string, number>());
  const rowTops = useRef(new Map<string, { section: string; y: number }>());
  const [lit, setLit] = useState<string | undefined>(undefined);
  const blurb = PAGE_BLURB[page];

  // Once the row the search found has a place, scroll it to a third of the way down and light it.
  const seek = useCallback(() => {
    if (!focus) return;

    const row = rowTops.current.get(focus);
    const sectionTop = row ? sectionTops.current.get(row.section) : undefined;

    if (!row || sectionTop === undefined) return;
    list.current?.scrollTo({ y: Math.max(0, sectionTop + row.y - height / 3), animated: false });
    setLit(focus);
    onFocused();
  }, [focus, height, onFocused]);

  useEffect(() => {
    if (!lit) return;

    const timer = setTimeout(() => setLit(undefined), LIT_MS);

    return () => clearTimeout(timer);
  }, [lit]);

  return (
    <ScrollView
      ref={list}
      testID={`settings-page-${page}`}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      scrollEventThrottle={16}
      onScroll={(event) => onScroll(event.nativeEvent.contentOffset.y)}
      onScrollEndDrag={(event) => {
        if (event.nativeEvent.contentOffset.y < -PULL_TO_CLOSE) onPullClose();
      }}
      contentContainerStyle={{ paddingTop: top, paddingBottom: bottom + 40, paddingHorizontal: space.gutter }}
    >
      <PageHeader tile={pageTile(page)} title={t(PAGE_TITLE[page])} blurb={blurb ? t(blurb) : undefined} />
      <View style={{ gap: 22 }}>
        {sections(page, ctx).map((section) => (
          <Section
            key={section.id}
            section={section}
            highlight={lit}
            onOpenPage={onOpenPage}
            onLayout={(y) => {
              sectionTops.current.set(section.id, y);
              seek();
            }}
            onRowLayout={(id, y) => {
              rowTops.current.set(id, { section: section.id, y });
              seek();
            }}
          />
        ))}
        {DRAWN_PAGES.includes(page) ? <View>{body}</View> : null}
      </View>
    </ScrollView>
  );
}

/** The body a page draws itself, if it draws one. */
function drawnBody(page: SettingsPage, props: SettingsScreenProps, back: () => void): ReactNode {
  switch (page) {
    case "customEngine":
      return (
        <CustomEngine
          initial={props.customSearchUrl ?? ""}
          onSave={(url) => {
            props.onCustomEngine(url);
            back();
          }}
        />
      );
    case "wallpaper":
      return <WallpaperPicker value={props.wallpaper} photo={props.wallpaperPhoto} onChange={props.onWallpaperChange} />;
    case "textSize":
      return <TextSize value={props.preferences.textSize} onChange={(textSize) => props.onPreferencesChange({ textSize })} />;
    case "syncJoin":
      return <SyncJoin back={back} />;
    case "syncPhrase":
      return <SyncPhrase back={back} />;
    default:
      return null;
  }
}

/** The language the phone is set to, as Bay would show it, so the System row can say what it means today. */
function useDeviceLocale(): Locale {
  // The formatting locale answers at once; the device's own languages follow.
  const [formatting] = useState<Locale>(() => matchLocale(Intl.DateTimeFormat().resolvedOptions().locale));
  const { run, result } = useCommand<Locale, never>();

  useEffect(() => {
    run(Effect.promise(detectLocale));
  }, [run]);

  return result?._tag === "Done" ? result.value : formatting;
}

/** Whether Bay is the default browser, asked again each time Bay comes back (from the system's settings, say). */
function useDefaultBrowser(): [SettingsContext["defaultBrowser"], () => void] {
  const [state, setState] = useState(askDefaultBrowser);
  const refresh = useCallback(() => setState(askDefaultBrowser()), []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") refresh();
    });

    return () => subscription.remove();
  }, [refresh]);

  return [state, refresh];
}

/** Everything the pages say and do, from the screen's props and its own state. */
function useSettingsContext(props: SettingsScreenProps, closeAfterClear: () => void): SettingsContext {
  const t = useT();
  const locale = useLocale();
  const saved = useSavedLocale();
  const device = useDeviceLocale();
  const [defaultBrowser, refreshDefault] = useDefaultBrowser();

  // Sync with the other devices: what it says, its "ago"s moved on each minute, and its actions on the runtime.
  const syncView = useSyncStore();
  const [now, setNow] = useState(Date.now);
  const syncCommand = useCommand<void, never>();

  const runSync = (action: (sync: PhoneSync["Service"]) => Effect.Effect<void>) =>
    syncCommand.run(
      Effect.gen(function* () {
        yield* action(yield* PhoneSync);
      }),
    );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);

    return () => clearInterval(timer);
  }, []);

  // Saved logins (B20), read when Settings opens and again after one is forgotten.
  const { run: runLogins, result: loginsResult } = useScopedWork<readonly SavedLogin[]>("logins");
  const logins = loginsResult?._tag === "Done" ? loginsResult.value : null;

  useEffect(() => {
    runLogins(savedLogins);
  }, [runLogins]);

  // Clearing browsing data is Settings' own command: it is busy while the wipe runs, and its answer either closes
  // Settings or says the wipe failed. Nothing tries it again.
  const wipe = useCommand();
  const [stage, setStage] = useState<ClearStage>("idle");
  const busy = wipe.running;

  function confirm(): void {
    if (busy) return;
    setStage("busy");
    wipe.run(
      props.clearData.pipe(
        Effect.matchEffect({
          onSuccess: () =>
            Effect.sync(() => {
              setStage("idle");
              // The empty start page behind shows the result.
              closeAfterClear();
            }),
          onFailure: () => Effect.sync(() => setStage("failed")),
        }),
      ),
    );
  }

  return {
    t,
    platform: Platform.OS === "ios" ? "ios" : "android",
    version: Constants.expoConfig?.version ?? "",
    prefs: props.preferences,
    change: props.onPreferencesChange,
    engines: props.engines,
    engineId: props.searchEngineId,
    customEngineId: CUSTOM_ENGINE_ID,
    customSearchUrl: props.customSearchUrl,
    chooseEngine: props.onSearchEngineChange,
    archiveAfterDays: props.archiveAfterDays,
    setArchiveAfterDays: props.onArchiveAfterDaysChange,
    blockContent: props.blockContent,
    blockerDetail: props.blockerDetail,
    setBlockContent: props.onBlockContentChange,
    pausedHosts: props.pausedHosts,
    resumeBlocking: props.onResumeBlocking,
    lockPrivateTabs: props.lockPrivateTabs,
    setLockPrivateTabs: props.onLockPrivateTabsChange,
    wallpaperName: t(WALLPAPER_NAMES[props.wallpaper]),
    language: { saved, current: locale, device },
    setLanguage: setLocale,
    defaultBrowser,
    makeDefault: () => void makeDefaultBrowser().then(refreshDefault, refreshDefault),
    openTabCount: props.openTabCount,
    exportTabs: props.onExportTabs,
    logins,
    forgetLogin: (login) => runLogins(forgetLogin(login.origin, login.username)),
    clear: {
      stage: busy ? "busy" : stage,
      ask: () => setStage("confirming"),
      confirm,
      keep: () => setStage("idle"),
    },
    showWelcome: props.onShowWelcome,
    openLink: props.onOpenLink,
    sync: {
      view: syncView,
      now,
      syncNow: () => runSync((sync) => sync.syncNow),
      setType: (type, on) => runSync((sync) => sync.setType(type, on)),
      leave: () => runSync((sync) => sync.leave),
      openTab: props.onOpenLink,
    },
  };
}

const styles = StyleSheet.create({
  head: { position: "absolute", left: 0, right: 0, top: 0 },
  headRow: { height: HEAD, flexDirection: "row", alignItems: "center", paddingHorizontal: space.md },
  headTitle: { position: "absolute", left: 64, right: 64, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
});
