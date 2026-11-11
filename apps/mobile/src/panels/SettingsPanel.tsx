import Constants from "expo-constants";
import { File, Paths } from "expo-file-system";
import { launchImageLibraryAsync } from "expo-image-picker";
import { useThemeColor } from "heroui-native";
import { useEffect, useRef, useState, type JSX } from "react";
import { Image, View } from "react-native";

import { WALLPAPER_NAMES, Wallpaper } from "@/browser/Wallpaper";
import { forgetLogin, savedLogins, type SavedLogin } from "@/browser/credentials";
import { Icon } from "@/chrome/Icon";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Text } from "@/chrome/Text";
import { radius } from "@/chrome/tokens";
import {
  detectLocale,
  LOCALE_IDS,
  LOCALE_NAMES,
  matchLocale,
  setLocale,
  useLocale,
  useSavedLocale,
  useT,
  type Locale,
  type MessageKey,
  type Translate,
} from "@/i18n";
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
  /** Opens the import sheet for tabs exported from another browser. */
  onImport: () => void;
  downloadCount: number;
  onDownloads: () => void;
  historyCount: number;
  onHistory: () => void;
  /** How many times Bay broke since it was opened; shown on the row that reports it (B8). */
  crashCount: number;
  /** Sends the errors Bay kept, so they can be looked at. */
  onReportProblem: () => void;
}

/** Each choice's label, and the shorter value the Browsing page shows for it. */
const archiveOptions: { days: number | null; label: MessageKey; short: MessageKey }[] = [
  { days: 0.5, label: "settings.archive.halfDay", short: "settings.archive.halfDayShort" },
  { days: 1, label: "settings.archive.oneDay", short: "settings.archive.oneDayShort" },
  { days: 7, label: "settings.archive.week", short: "settings.archive.weekShort" },
  { days: 30, label: "settings.archive.month", short: "settings.archive.monthShort" },
  { days: null, label: "settings.archive.never", short: "settings.archive.never" },
];

function startPageLabel(hours: number | null, t: Translate): string {
  return hours === null ? t("settings.startPage.never") : hours === 1 ? t("settings.startPage.oneHour") : t("settings.startPage.hours", { hours });
}

const themes: { id: ThemeChoice; label: MessageKey }[] = [
  { id: "system", label: "settings.theme.system" },
  { id: "light", label: "settings.theme.light" },
  { id: "dark", label: "settings.theme.dark" },
];

type Page = "main" | "engine" | "privacy" | "appearance" | "browsing" | "language" | "wallpaper" | "textSize" | "archive" | "startPage";

const pages: Record<Page, { title: MessageKey; parent: Page }> = {
  main: { title: "settings.title", parent: "main" },
  engine: { title: "settings.searchEngine", parent: "main" },
  privacy: { title: "settings.privacy", parent: "main" },
  appearance: { title: "settings.appearance", parent: "main" },
  browsing: { title: "settings.browsing", parent: "main" },
  language: { title: "settings.language", parent: "main" },
  wallpaper: { title: "settings.wallpaper", parent: "appearance" },
  textSize: { title: "settings.pageZoom", parent: "appearance" },
  archive: { title: "settings.archiveInactive", parent: "browsing" },
  startPage: { title: "settings.startPage", parent: "browsing" },
};

/** Explains the rows above it, in the sheet's muted small print, lined up with the rows' text. */
function Note({ children }: { children: string }): JSX.Element {
  return (
    <Text variant="footnote" tone="muted" className="mt-2 px-4">
      {children}
    </Text>
  );
}

/** The language the phone is set to, as Bay would show it, so the System row can say what it means today. */
function useDeviceLocale(): Locale {
  const [device, setDevice] = useState<Locale>(() => matchLocale(Intl.DateTimeFormat().resolvedOptions().locale));

  useEffect(() => {
    void detectLocale().then(setDevice);
  }, []);

  return device;
}

/** System first (it follows the phone), then each language in its own name. Choosing one changes the app at once. */
function LanguagePicker({ onChosen }: { onChosen: () => void }): JSX.Element {
  const t = useT();
  const saved = useSavedLocale();
  const device = useDeviceLocale();

  return (
    <Group>
      <ActionRow
        testID="settings-language-system"
        label={t("settings.language.system")}
        detail={t("settings.language.systemDetail", { language: LOCALE_NAMES[device] })}
        selected={saved === null}
        onPress={() => {
          setLocale(null);
          onChosen();
        }}
      />
      {LOCALE_IDS.map((locale) => (
        <ActionRow
          key={locale}
          testID={`settings-language-${locale}`}
          label={LOCALE_NAMES[locale]}
          selected={saved === locale}
          onPress={() => {
            setLocale(locale);
            onChosen();
          }}
        />
      ))}
    </Group>
  );
}

// The sheet stays mounted and toggles open, like the other panels; each opening starts on the main page.
export function SettingsPanel(props: SettingsPanelProps): JSX.Element {
  const t = useT();
  const locale = useLocale();
  const savedLocale = useSavedLocale();
  const [page, setPage] = useState<Page>("main");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Saved logins (B20), reloaded each time the sheet opens on the privacy page.
  const [logins, setLogins] = useState<SavedLogin[] | null>(null);
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

  useEffect(() => {
    if (!props.visible || page !== "privacy") return;

    void savedLogins().then(setLogins, () => setLogins([]));
  }, [props.visible, page]);

  async function forgetSaved(login: SavedLogin): Promise<void> {
    await forgetLogin(login.origin, login.username).catch(() => {});
    void savedLogins().then(setLogins, () => undefined);
  }

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
      if (mounted.current) setError(cause instanceof Error ? cause.message : t("settings.clearDataFailed"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const { preferences: prefs, onPreferencesChange: change } = props;
  const engineName = props.engines.find((engine) => engine.id === props.searchEngineId)?.name;
  const archiveValue = archiveOptions.find((option) => option.days === props.archiveAfterDays);
  const themeLabel = themes.find((theme) => theme.id === prefs.theme)?.label;
  /** "1 page", "12 pages": nothing at all while there are none. */
  const count = (n: number, one: string, many: string) => (n ? (n === 1 ? one : many) : undefined);
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
              label={t("settings.searchSuggestions")}
              detail={
                prefs.searchSuggestions
                  ? engineName
                    ? t("settings.searchSuggestions.on", { engine: engineName })
                    : t("settings.searchSuggestions.default")
                  : t("settings.searchSuggestions.off")
              }
              toggle={prefs.searchSuggestions}
              onPress={() => change({ searchSuggestions: !prefs.searchSuggestions })}
            />
            <ActionRow
              testID="settings-skip-amp"
              label={t("settings.skipAmp")}
              detail={t("settings.skipAmp.detail")}
              toggle={prefs.skipAmp}
              onPress={() => change({ skipAmp: !prefs.skipAmp })}
            />
            {props.privateAvailable ? (
              <ActionRow
                testID="settings-lock-private"
                label={t("settings.lockPrivate")}
                detail={t("settings.lockPrivate.detail")}
                toggle={props.lockPrivateTabs}
                onPress={() => props.onLockPrivateTabsChange(!props.lockPrivateTabs)}
              />
            ) : null}
          </Group>
          {props.pausedHosts.length ? (
            <>
              <Group label={t("settings.group.paused")}>
                {props.pausedHosts.map((host) => (
                  <ActionRow
                    key={host}
                    testID={`settings-paused-${host}`}
                    label={host}
                    value={t("settings.paused.resume")}
                    onPress={() => props.onResumeBlocking(host)}
                  />
                ))}
              </Group>
              <Note>{t("settings.paused.note")}</Note>
            </>
          ) : null}
          {logins && logins.length ? (
            <>
              <Group label={t("settings.group.passwords")}>
                {logins.map((login) => (
                  <ActionRow
                    key={`${login.origin}\n${login.username}`}
                    testID={`saved-login-${login.origin}-${login.username}`}
                    label={login.username}
                    detail={login.origin}
                    value={t("settings.passwords.delete")}
                    destructive
                    onPress={() => void forgetSaved(login)}
                  />
                ))}
              </Group>
              <Note>{t("settings.passwords.note")}</Note>
            </>
          ) : null}
        </>
      );
      break;
    case "appearance":
      content = (
        <>
          <Group label={t("settings.group.theme")}>
            {themes.map((theme) => (
              <ActionRow
                key={theme.id}
                testID={`settings-theme-${theme.id}`}
                label={t(theme.label)}
                selected={prefs.theme === theme.id}
                onPress={() => change({ theme: theme.id })}
              />
            ))}
          </Group>
          <Note>{t("settings.appearance.note")}</Note>
          <Group label={t("settings.group.startPage")}>
            <ActionRow
              testID="settings-wallpaper"
              icon="wallpaper"
              label={t("settings.wallpaper")}
              value={t(WALLPAPER_NAMES[props.wallpaper])}
              chevron
              onPress={() => setPage("wallpaper")}
            />
            <ActionRow
              testID="settings-text-size"
              icon="textSize"
              label={t("settings.pageZoom")}
              value={`${prefs.textSize}%`}
              chevron
              onPress={() => setPage("textSize")}
            />
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
          <Group label={t("settings.group.tabs")}>
            <ActionRow
              testID="settings-archive"
              icon="archive"
              label={t("settings.archiveInactive")}
              value={archiveValue ? t(archiveValue.short) : undefined}
              chevron
              onPress={() => setPage("archive")}
            />
            <ActionRow
              testID="settings-start-page"
              icon="history"
              label={t("settings.startPageAfter")}
              value={
                prefs.startPageAfterHours === null ? t("settings.startPage.never") : t("settings.startPage.hoursAway", { hours: prefs.startPageAfterHours })
              }
              chevron
              onPress={() => setPage("startPage")}
            />
          </Group>
          <Group label={t("settings.group.pages")}>
            <ActionRow
              testID="settings-pull-refresh"
              icon="reload"
              label={t("settings.pullToRefresh")}
              toggle={prefs.pullToRefresh}
              onPress={() => change({ pullToRefresh: !prefs.pullToRefresh })}
            />
          </Group>
          <Group label={t("settings.group.youtube")}>
            <ActionRow
              testID="settings-yt-shorts"
              label={t("settings.youtube.shorts")}
              toggle={prefs.youtube.shorts}
              onPress={() => change({ youtube: { ...prefs.youtube, shorts: !prefs.youtube.shorts } })}
            />
            <ActionRow
              testID="settings-yt-suggestions"
              label={t("settings.youtube.suggestions")}
              detail={t("settings.youtube.suggestionsDetail")}
              toggle={prefs.youtube.suggestions}
              onPress={() => change({ youtube: { ...prefs.youtube, suggestions: !prefs.youtube.suggestions } })}
            />
            <ActionRow
              testID="settings-yt-distractions"
              label={t("settings.youtube.distractions")}
              detail={t("settings.youtube.distractionsDetail")}
              toggle={prefs.youtube.distractions}
              onPress={() => change({ youtube: { ...prefs.youtube, distractions: !prefs.youtube.distractions } })}
            />
          </Group>
          <Note>{t("settings.youtube.note")}</Note>
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
                label={t(option.label)}
                selected={props.archiveAfterDays === option.days}
                onPress={choose(() => props.onArchiveAfterDaysChange(option.days))}
              />
            ))}
          </Group>
          <Note>{t("settings.archive.note")}</Note>
        </>
      );
      break;
    case "startPage":
      content = (
        <>
          <Group>
            {START_PAGE_HOURS.map((hours) => (
              <ActionRow
                key={hours ?? "never"}
                testID={`settings-start-page-${hours ?? "never"}`}
                label={startPageLabel(hours, t)}
                selected={prefs.startPageAfterHours === hours}
                onPress={choose(() => change({ startPageAfterHours: hours }))}
              />
            ))}
          </Group>
          <Note>{t("settings.startPage.note")}</Note>
        </>
      );
      break;
    case "language":
      content = <LanguagePicker onChosen={back} />;
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
              label={t("settings.blockContent")}
              detail={props.blockerDetail}
              toggle={props.blockContent}
              disabled={busy}
              onPress={() => props.onBlockContentChange(!props.blockContent)}
            />
          </Group>
          <Group label={t("settings.group.browser")}>
            <ActionRow
              testID="settings-engine"
              icon="search"
              label={t("settings.searchEngine")}
              value={engineName}
              chevron
              disabled={busy}
              onPress={() => setPage("engine")}
            />
            <ActionRow
              testID="settings-privacy"
              icon="lock"
              label={t("settings.privacy")}
              value={props.pausedHosts.length ? t("settings.paused.count", { count: props.pausedHosts.length }) : undefined}
              chevron
              disabled={busy}
              onPress={() => setPage("privacy")}
            />
            <ActionRow
              testID="settings-appearance"
              icon="palette"
              label={t("settings.appearance")}
              value={themeLabel ? t(themeLabel) : undefined}
              chevron
              disabled={busy}
              onPress={() => setPage("appearance")}
            />
            <ActionRow
              testID="settings-language"
              icon="translate"
              label={t("settings.language")}
              value={savedLocale === null ? t("settings.language.system") : LOCALE_NAMES[locale]}
              chevron
              disabled={busy}
              onPress={() => setPage("language")}
            />
            <ActionRow
              testID="settings-browsing"
              icon="tune"
              label={t("settings.browsing")}
              detail={t("settings.browsing.detail")}
              chevron
              disabled={busy}
              onPress={() => setPage("browsing")}
            />
          </Group>
          <Group label={t("settings.group.data")}>
            <ActionRow testID="settings-import" icon="add" label={t("settings.importTabs")} chevron disabled={busy} onPress={props.onImport} />
            <ActionRow
              testID="settings-history"
              icon="history"
              label={t("settings.history")}
              value={count(props.historyCount, t("settings.historyOnePage"), t("settings.historyPages", { count: props.historyCount }))}
              chevron
              disabled={busy}
              onPress={props.onHistory}
            />
            <ActionRow
              testID="settings-downloads"
              icon="download"
              label={t("settings.downloads")}
              value={count(props.downloadCount, t("settings.downloadsOneFile"), t("settings.downloadsFiles", { count: props.downloadCount }))}
              chevron
              disabled={busy}
              onPress={props.onDownloads}
            />
            {confirming ? (
              <ActionRow
                testID="clear-data-confirm"
                icon="delete"
                label={busy ? t("settings.clearingData") : t("settings.clearAllData")}
                detail={t("settings.clearAllData.detail")}
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
                label={t("settings.clearData")}
                destructive
                disabled={busy}
                onPress={() => {
                  setConfirming(true);
                  setError(null);
                }}
              />
            )}
            {confirming ? <ActionRow testID="clear-data-cancel" label={t("settings.keepData")} disabled={busy} onPress={() => setConfirming(false)} /> : null}
          </Group>
          <Group label={t("settings.group.help")}>
            <ActionRow
              testID="settings-report-problem"
              icon="error"
              label={t("settings.reportProblem")}
              detail={
                props.crashCount
                  ? props.crashCount === 1
                    ? t("settings.reportProblem.oneError")
                    : t("settings.reportProblem.errors", { count: props.crashCount })
                  : t("settings.reportProblem.detail")
              }
              disabled={busy}
              onPress={props.onReportProblem}
            />
          </Group>
          {busy ? (
            <Text testID="clear-data-busy" accessibilityLiveRegion="polite" variant="subhead" tone="muted" className="mt-3 px-4">
              {t("settings.clearingWebsiteData")}
            </Text>
          ) : null}
          {error ? (
            <Text testID="clear-data-error" accessibilityRole="alert" accessibilityLiveRegion="assertive" variant="subhead" tone="danger" className="mt-3 px-4">
              {error}
            </Text>
          ) : null}
          <Text variant="caption" weight="regular" tone="muted" className="mt-6 text-center">
            {t("settings.version", { version: Constants.expoConfig?.version ?? "" })}
          </Text>
        </>
      );
  }

  return (
    <PanelSheet
      visible={props.visible}
      onClose={props.onClose}
      onBack={page === "main" ? undefined : back}
      title={t(pages[page].title)}
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
  const t = useT();
  const step = (delta: number) => onChange(Math.min(TEXT_SIZE.max, Math.max(TEXT_SIZE.min, value + delta)));

  return (
    <>
      <View className="bg-default p-4" style={{ borderRadius: radius.card }}>
        <Text tone="muted" style={{ fontSize: (13 * value) / 100, lineHeight: (18 * value) / 100 }}>
          example.com
        </Text>
        <Text weight="semibold" className="mt-1" style={{ fontSize: (20 * value) / 100, lineHeight: (26 * value) / 100 }}>
          {t("settings.zoom.previewTitle")}
        </Text>
        <Text className="mt-1" style={{ fontSize: (16 * value) / 100, lineHeight: (23 * value) / 100 }}>
          {t("settings.zoom.previewBody")}
        </Text>
      </View>
      <View className="mt-4 flex-row items-center gap-3">
        <PressFeedback
          testID="text-size-smaller"
          accessibilityRole="button"
          accessibilityLabel={t("settings.zoom.out")}
          accessibilityState={{ disabled: value <= TEXT_SIZE.min }}
          disabled={value <= TEXT_SIZE.min}
          onPress={() => step(-TEXT_SIZE.step)}
          className="h-12 flex-1 items-center justify-center rounded-full bg-default"
          style={{ opacity: value <= TEXT_SIZE.min ? 0.35 : 1 }}
        >
          <Icon name="textSize" color={foreground} size={16} />
        </PressFeedback>
        <Text testID="text-size-value" accessibilityLiveRegion="polite" variant="headline" className="w-16 text-center">
          {`${value}%`}
        </Text>
        <PressFeedback
          testID="text-size-larger"
          accessibilityRole="button"
          accessibilityLabel={t("settings.zoom.in")}
          accessibilityState={{ disabled: value >= TEXT_SIZE.max }}
          disabled={value >= TEXT_SIZE.max}
          onPress={() => step(TEXT_SIZE.step)}
          className="h-12 flex-1 items-center justify-center rounded-full bg-default"
          style={{ opacity: value >= TEXT_SIZE.max ? 0.35 : 1 }}
        >
          <Icon name="textSize" color={foreground} size={26} />
        </PressFeedback>
      </View>
      {value !== 100 ? (
        <View className="mt-4">
          <Group>
            <ActionRow testID="text-size-reset" label={t("settings.zoom.reset")} onPress={() => onChange(100)} />
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
  const t = useT();
  const tiles: WallpaperId[] = [...WALLPAPERS, "photo"];

  return (
    <>
      <View className="mt-1 flex-row flex-wrap" style={{ rowGap: 16 }}>
        {tiles.map((id, index) => {
          const selected = id === value;
          const empty = id === "photo" && !photo;

          return (
            <PressFeedback
              key={id}
              testID={`settings-wallpaper-${id}`}
              accessibilityRole="radio"
              accessibilityLabel={empty ? t("settings.wallpaper.chooseLabel") : t(WALLPAPER_NAMES[id])}
              accessibilityState={{ selected, checked: selected }}
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
              className="items-center gap-2"
              style={{ width: "31%", marginRight: index % 3 === 2 ? 0 : "3.5%" }}
            >
              <View
                className={
                  selected
                    ? "w-full items-center justify-center overflow-hidden border-2 border-accent"
                    : "w-full items-center justify-center overflow-hidden border border-foreground/10"
                }
                style={{ aspectRatio: 0.62, borderRadius: radius.tile }}
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
              <Text variant="subhead" weight={selected ? "medium" : undefined} tone={selected ? "accent" : "default"}>
                {empty ? t("settings.wallpaper.choose") : t(WALLPAPER_NAMES[id])}
              </Text>
            </PressFeedback>
          );
        })}
      </View>
      {photo ? (
        <Text variant="subhead" tone="muted" className="mt-4 px-4">
          {t("settings.wallpaper.chooseAgain")}
        </Text>
      ) : null}
      {error ? (
        <Text
          testID="settings-wallpaper-error"
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          variant="subhead"
          tone="danger"
          className="mt-3 px-4"
        >
          {t("settings.wallpaper.failed")}
        </Text>
      ) : null}
    </>
  );
}
