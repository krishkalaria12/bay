import Constants from "expo-constants";
import { File, Paths } from "expo-file-system";
import { launchImageLibraryAsync } from "expo-image-picker";
import { Typography, useThemeColor } from "heroui-native";
import { useEffect, useRef, useState, type JSX } from "react";
import { Image, Pressable, View } from "react-native";

import { WALLPAPER_NAMES, Wallpaper } from "@/browser/Wallpaper";
import { Icon } from "@/chrome/Icon";
import { START_PAGE_HOURS, TEXT_SIZE, WALLPAPERS } from "@/store/model";
import type { SimplePreferences, ThemeChoice, WallpaperId } from "@/store/types";
import { ActionRow, Group, PanelSheet } from "./PanelSheet";

export interface SettingsPanelProps {
  visible: boolean;
  onClose: () => void;
  engines: readonly { id: string; name: string }[];
  searchEngineId: string;
  onSearchEngineChange: (id: string) => void;
  archiveAfterDays: number | null;
  onArchiveAfterDaysChange: (days: number | null) => void;
  blockContent: boolean;
  /** What the blocker is doing, shown under its switch. */
  blockerDetail: string;
  onBlockContentChange: (enabled: boolean) => void;
  /** Sites where blocking is paused, and resuming one. */
  pausedHosts: readonly string[];
  onResumeBlocking: (host: string) => void;
  /** Hidden when the engine can't keep private tabs. */
  privateAvailable: boolean;
  lockPrivateTabs: boolean;
  onLockPrivateTabsChange: (enabled: boolean) => void;
  wallpaper: WallpaperId;
  /** The user's photo, kept even while a built-in wallpaper is chosen. */
  wallpaperPhoto: string | null;
  onWallpaperChange: (id: WallpaperId, photo?: string) => void;
  preferences: SimplePreferences;
  onPreferencesChange: (update: Partial<SimplePreferences>) => void;
  onClearData: () => Promise<void>;
  downloadCount: number;
  onDownloads: () => void;
  historyCount: number;
  onHistory: () => void;
}

const archiveOptions = [
  { days: 1, label: "After 1 day" },
  { days: 7, label: "After 7 days" },
  { days: 30, label: "After 30 days" },
  { days: null, label: "Never" },
];

const startPageOptions = START_PAGE_HOURS.map((hours) => ({
  hours,
  label: hours === null ? "Never" : hours === 1 ? "After 1 hour away" : `After ${hours} hours away`,
}));

const themes: { id: ThemeChoice; label: string }[] = [
  { id: "system", label: "Match phone" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

type Page = "main" | "engine" | "privacy" | "appearance" | "browsing" | "wallpaper" | "textSize" | "archive" | "startPage";

const pages: Record<Page, { title: string; parent: Page }> = {
  main: { title: "Settings", parent: "main" },
  engine: { title: "Search engine", parent: "main" },
  privacy: { title: "Privacy", parent: "main" },
  appearance: { title: "Appearance", parent: "main" },
  browsing: { title: "Browsing", parent: "main" },
  wallpaper: { title: "Wallpaper", parent: "appearance" },
  textSize: { title: "Page zoom", parent: "appearance" },
  archive: { title: "Archive inactive tabs", parent: "browsing" },
  startPage: { title: "Start page", parent: "browsing" },
};

const count = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : undefined);

/** Explains the rows above it, in the sheet's muted small print. */
function Note({ children }: { children: string }): JSX.Element {
  return <Typography className="mt-2 px-1 text-[13px] leading-5 text-muted">{children}</Typography>;
}

// The sheet stays mounted and toggles open, like the other panels; each opening starts on the main page.
export function SettingsPanel(props: SettingsPanelProps): JSX.Element {
  const [page, setPage] = useState<Page>("main");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!props.visible) return;
    setPage("main");
    setConfirming(false);
    setError(null);
  }, [props.visible]);

  async function clearData(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      await props.onClearData();

      if (!mounted.current) return;
      setConfirming(false);
      // The empty start page behind the sheet shows the result.
      props.onClose();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Couldn't clear browsing data. Try again.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const { preferences: prefs, onPreferencesChange: change } = props;
  const engineName = props.engines.find((engine) => engine.id === props.searchEngineId)?.name;
  const back = () => setPage(pages[page].parent);

  // A choice goes back to the page it was made from.
  const choose = (action: () => void) => () => {
    action();
    back();
  };

  let content: JSX.Element;

  switch (page) {
    case "engine":
      content = (
        <Group>
          {props.engines.map((engine) => (
            <ActionRow
              key={engine.id}
              testID={`settings-engine-${engine.id}`}
              label={engine.name}
              selected={engine.id === props.searchEngineId}
              onPress={choose(() => props.onSearchEngineChange(engine.id))}
            />
          ))}
        </Group>
      );
      break;
    case "privacy":
      content = (
        <>
          <Group>
            <ActionRow
              testID="settings-suggestions"
              label="Search suggestions"
              detail={
                prefs.searchSuggestions
                  ? `${engineName ?? "Your search engine"} sees what you type as you type it`
                  : "Nothing you type leaves Bay until you search"
              }
              toggle={prefs.searchSuggestions}
              onPress={() => change({ searchSuggestions: !prefs.searchSuggestions })}
            />
            <ActionRow
              testID="settings-skip-amp"
              label="Skip AMP pages"
              detail="Open the publisher's own page instead of Google's copy"
              toggle={prefs.skipAmp}
              onPress={() => change({ skipAmp: !prefs.skipAmp })}
            />
            {props.privateAvailable ? (
              <ActionRow
                testID="settings-lock-private"
                label="Lock private tabs"
                detail="Ask for your fingerprint, face or passcode when you come back"
                toggle={props.lockPrivateTabs}
                onPress={() => props.onLockPrivateTabsChange(!props.lockPrivateTabs)}
              />
            ) : null}
          </Group>
          {props.pausedHosts.length ? (
            <>
              <Group label="Blocking paused on">
                {props.pausedHosts.map((host) => (
                  <ActionRow key={host} testID={`settings-paused-${host}`} label={host} value="Resume" onPress={() => props.onResumeBlocking(host)} />
                ))}
              </Group>
              <Note>Pause blocking from a site's menu when it doesn't work right.</Note>
            </>
          ) : null}
        </>
      );
      break;
    case "appearance":
      content = (
        <>
          <Group label="Theme">
            {themes.map((theme) => (
              <ActionRow
                key={theme.id}
                testID={`settings-theme-${theme.id}`}
                label={theme.label}
                selected={prefs.theme === theme.id}
                onPress={() => change({ theme: theme.id })}
              />
            ))}
          </Group>
          <Note>Changes Bay's own screens. Sites may keep following your phone.</Note>
          <Group label="Start page and pages">
            <ActionRow
              testID="settings-wallpaper"
              icon="wallpaper"
              label="Wallpaper"
              value={WALLPAPER_NAMES[props.wallpaper]}
              chevron
              onPress={() => setPage("wallpaper")}
            />
            <ActionRow testID="settings-text-size" icon="textSize" label="Page zoom" value={`${prefs.textSize}%`} chevron onPress={() => setPage("textSize")} />
          </Group>
        </>
      );
      break;
    case "textSize":
      content = <TextSize value={prefs.textSize} onChange={(textSize) => change({ textSize })} />;
      break;
    case "browsing":
      content = (
        <>
          <Group label="Tabs">
            <ActionRow
              testID="settings-archive"
              icon="archive"
              label="Archive inactive tabs"
              value={archiveOptions.find((option) => option.days === props.archiveAfterDays)?.label.replace("After ", "")}
              chevron
              onPress={() => setPage("archive")}
            />
            <ActionRow
              testID="settings-start-page"
              icon="history"
              label="Start page after"
              value={prefs.startPageAfterHours === null ? "Never" : `${prefs.startPageAfterHours} h away`}
              chevron
              onPress={() => setPage("startPage")}
            />
          </Group>
          <Group label="Pages">
            <ActionRow
              testID="settings-pull-refresh"
              icon="reload"
              label="Pull to refresh"
              toggle={prefs.pullToRefresh}
              onPress={() => change({ pullToRefresh: !prefs.pullToRefresh })}
            />
          </Group>
          <Group label="YouTube">
            <ActionRow
              testID="settings-yt-shorts"
              label="Hide Shorts"
              toggle={prefs.youtube.shorts}
              onPress={() => change({ youtube: { ...prefs.youtube, shorts: !prefs.youtube.shorts } })}
            />
            <ActionRow
              testID="settings-yt-suggestions"
              label="Hide suggested videos"
              detail="Up next and end screens"
              toggle={prefs.youtube.suggestions}
              onPress={() => change({ youtube: { ...prefs.youtube, suggestions: !prefs.youtube.suggestions } })}
            />
            <ActionRow
              testID="settings-yt-distractions"
              label="Hide comments"
              detail="And sign-in prompts"
              toggle={prefs.youtube.distractions}
              onPress={() => change({ youtube: { ...prefs.youtube, distractions: !prefs.youtube.distractions } })}
            />
          </Group>
          <Note>Uses Brave's YouTube lists.</Note>
        </>
      );
      break;
    case "archive":
      content = (
        <>
          <Group>
            {archiveOptions.map((option) => (
              <ActionRow
                key={option.days ?? "never"}
                testID={`settings-archive-${option.days ?? "never"}`}
                label={option.label}
                selected={props.archiveAfterDays === option.days}
                onPress={choose(() => props.onArchiveAfterDaysChange(option.days))}
              />
            ))}
          </Group>
          <Note>Your current tab stays open. You can restore archived tabs at any time.</Note>
        </>
      );
      break;
    case "startPage":
      content = (
        <>
          <Group>
            {startPageOptions.map((option) => (
              <ActionRow
                key={option.hours ?? "never"}
                testID={`settings-start-page-${option.hours ?? "never"}`}
                label={option.label}
                selected={prefs.startPageAfterHours === option.hours}
                onPress={choose(() => change({ startPageAfterHours: option.hours }))}
              />
            ))}
          </Group>
          <Note>Come back after a while to a fresh start page. Your tabs stay where they were.</Note>
        </>
      );
      break;
    case "wallpaper":
      content = <WallpaperPicker value={props.wallpaper} photo={props.wallpaperPhoto} onChange={props.onWallpaperChange} />;
      break;
    case "main":
      content = (
        <>
          <Group>
            <ActionRow
              testID="settings-block-content"
              icon="shield"
              label="Block ads and trackers"
              detail={props.blockerDetail}
              toggle={props.blockContent}
              disabled={busy}
              onPress={() => props.onBlockContentChange(!props.blockContent)}
            />
          </Group>
          <Group label="Browser">
            <ActionRow
              testID="settings-engine"
              icon="search"
              label="Search engine"
              value={engineName}
              chevron
              disabled={busy}
              onPress={() => setPage("engine")}
            />
            <ActionRow
              testID="settings-privacy"
              icon="lock"
              label="Privacy"
              value={props.pausedHosts.length ? `Paused on ${props.pausedHosts.length}` : undefined}
              chevron
              disabled={busy}
              onPress={() => setPage("privacy")}
            />
            <ActionRow
              testID="settings-appearance"
              icon="palette"
              label="Appearance"
              value={themes.find((theme) => theme.id === prefs.theme)?.label}
              chevron
              disabled={busy}
              onPress={() => setPage("appearance")}
            />
            <ActionRow
              testID="settings-browsing"
              icon="tune"
              label="Browsing"
              detail="Tabs, gestures and YouTube"
              chevron
              disabled={busy}
              onPress={() => setPage("browsing")}
            />
          </Group>
          <Group label="Your data">
            <ActionRow
              testID="settings-history"
              icon="history"
              label="History"
              value={count(props.historyCount, "page", "pages")}
              chevron
              disabled={busy}
              onPress={props.onHistory}
            />
            <ActionRow
              testID="settings-downloads"
              icon="download"
              label="Downloads"
              value={count(props.downloadCount, "file", "files")}
              chevron
              disabled={busy}
              onPress={props.onDownloads}
            />
            {confirming ? (
              <ActionRow
                testID="clear-data-confirm"
                icon="delete"
                label={busy ? "Clearing data…" : "Clear all browsing data"}
                detail="Tabs, archive, history, pins, cookies and website data. Settings stay."
                destructive
                disabled={busy}
                onPress={() => {
                  void clearData();
                }}
              />
            ) : (
              <ActionRow
                testID="settings-clear-data"
                icon="delete"
                label="Clear browsing data"
                destructive
                disabled={busy}
                onPress={() => {
                  setConfirming(true);
                  setError(null);
                }}
              />
            )}
            {confirming ? <ActionRow testID="clear-data-cancel" label="Keep browsing data" disabled={busy} onPress={() => setConfirming(false)} /> : null}
          </Group>
          {busy ? (
            <Typography testID="clear-data-busy" className="mt-3 px-1 text-sm text-muted">
              Clearing website data…
            </Typography>
          ) : null}
          {error ? (
            <Typography testID="clear-data-error" accessibilityRole="alert" className="mt-3 px-1 text-sm text-danger">
              {error}
            </Typography>
          ) : null}
          <Typography className="mt-6 text-center text-xs text-muted">Bay {Constants.expoConfig?.version ?? ""}</Typography>
        </>
      );
  }

  return (
    <PanelSheet
      visible={props.visible}
      onClose={props.onClose}
      onBack={page === "main" ? undefined : back}
      title={pages[page].title}
      testID="settings-screen"
      height="85%"
      dismissible={!busy}
    >
      {content}
    </PanelSheet>
  );
}

/** A preview at the chosen zoom, with smaller and larger steps. */
function TextSize({ value, onChange }: { value: number; onChange: (size: number) => void }): JSX.Element {
  const foreground = useThemeColor("foreground");
  const step = (delta: number) => onChange(Math.min(TEXT_SIZE.max, Math.max(TEXT_SIZE.min, value + delta)));

  return (
    <>
      <View className="rounded-[20px] bg-default p-4">
        <Typography className="text-muted" style={{ fontSize: (13 * value) / 100, lineHeight: (18 * value) / 100 }}>
          example.com
        </Typography>
        <Typography className="mt-1 font-semibold" style={{ fontSize: (20 * value) / 100, lineHeight: (26 * value) / 100 }}>
          The quiet bay
        </Typography>
        <Typography className="mt-1" style={{ fontSize: (16 * value) / 100, lineHeight: (23 * value) / 100 }}>
          Every site shows its text and images at this size. Reader has its own text size.
        </Typography>
      </View>
      <View className="mt-4 flex-row items-center gap-3">
        <Pressable
          testID="text-size-smaller"
          accessibilityRole="button"
          accessibilityLabel="Zoom out"
          disabled={value <= TEXT_SIZE.min}
          onPress={() => step(-TEXT_SIZE.step)}
          className="h-12 flex-1 items-center justify-center rounded-full bg-default active:opacity-70"
          style={{ opacity: value <= TEXT_SIZE.min ? 0.35 : 1 }}
        >
          <Icon name="textSize" color={foreground} size={16} />
        </Pressable>
        <Typography testID="text-size-value" className="w-16 text-center text-lg font-semibold">
          {`${value}%`}
        </Typography>
        <Pressable
          testID="text-size-larger"
          accessibilityRole="button"
          accessibilityLabel="Zoom in"
          disabled={value >= TEXT_SIZE.max}
          onPress={() => step(TEXT_SIZE.step)}
          className="h-12 flex-1 items-center justify-center rounded-full bg-default active:opacity-70"
          style={{ opacity: value >= TEXT_SIZE.max ? 0.35 : 1 }}
        >
          <Icon name="textSize" color={foreground} size={26} />
        </Pressable>
      </View>
      {value !== 100 ? (
        <View className="mt-4">
          <Group>
            <ActionRow testID="text-size-reset" label="Back to 100%" onPress={() => onChange(100)} />
          </Group>
        </View>
      ) : null}
    </>
  );
}

/** Copies a gallery photo into the app's documents and replaces the old one. */
async function pickPhoto(previous: string | null): Promise<string | null> {
  // The system photo picker needs no storage permission.
  const result = await launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
  const asset = result.canceled ? undefined : result.assets[0];

  if (!asset) return null;
  const file = new File(Paths.document, `wallpaper-${Date.now()}.jpg`);
  new File(asset.uri).copy(file);

  if (previous) {
    try {
      new File(previous).delete();
    } catch {}
  }

  return file.uri;
}

/** Three columns of start page previews, then the user's photo. */
function WallpaperPicker({
  value,
  photo,
  onChange,
}: {
  value: WallpaperId;
  photo: string | null;
  onChange: (id: WallpaperId, photo?: string) => void;
}): JSX.Element {
  const [error, setError] = useState(false);
  const foreground = useThemeColor("foreground");
  const tiles: WallpaperId[] = [...WALLPAPERS, "photo"];

  return (
    <>
      <View className="mt-1 flex-row flex-wrap" style={{ rowGap: 16 }}>
        {tiles.map((id, index) => {
          const selected = id === value;
          const empty = id === "photo" && !photo;

          return (
            <Pressable
              key={id}
              testID={`settings-wallpaper-${id}`}
              accessibilityRole="radio"
              accessibilityLabel={empty ? "Choose a photo" : WALLPAPER_NAMES[id]}
              accessibilityState={{ selected }}
              onPress={() => {
                if (id !== "photo") return onChange(id);
                setError(false);

                // Tapping the chosen photo again picks a new one.
                if (photo && !selected) return onChange("photo");
                pickPhoto(photo).then(
                  (uri) => uri && onChange("photo", uri),
                  () => setError(true),
                );
              }}
              className="items-center gap-2 active:opacity-70"
              style={{ width: "31%", marginRight: index % 3 === 2 ? 0 : "3.5%" }}
            >
              <View
                className={
                  selected
                    ? "w-full items-center justify-center overflow-hidden rounded-2xl border-2 border-accent"
                    : "w-full items-center justify-center overflow-hidden rounded-2xl border border-foreground/10"
                }
                style={{ aspectRatio: 0.62 }}
              >
                {empty ? (
                  <Icon name="add" size={28} color={foreground} />
                ) : id === "photo" ? (
                  <Image source={{ uri: photo! }} resizeMode="cover" resizeMethod="resize" fadeDuration={0} className="absolute inset-0" />
                ) : (
                  <Wallpaper id={id} scale={0.6} />
                )}
                {empty ? null : (
                  <View className="absolute bottom-2.5 left-0 right-0 flex-row justify-center gap-1">
                    <View className="h-3 w-3 rounded-full bg-foreground/15" />
                    <View className="h-3 w-8 rounded-full bg-foreground/15" />
                    <View className="h-3 w-3 rounded-full bg-foreground/15" />
                  </View>
                )}
              </View>
              <Typography className={selected ? "text-sm font-medium text-accent" : "text-sm"}>{empty ? "Choose photo" : WALLPAPER_NAMES[id]}</Typography>
            </Pressable>
          );
        })}
      </View>
      {photo ? <Typography className="mt-4 px-1 text-sm text-muted">Tap your photo again to choose another.</Typography> : null}
      {error ? (
        <Typography testID="settings-wallpaper-error" accessibilityRole="alert" className="mt-3 px-1 text-sm text-danger">
          Couldn't use that photo. Try another.
        </Typography>
      ) : null}
    </>
  );
}
