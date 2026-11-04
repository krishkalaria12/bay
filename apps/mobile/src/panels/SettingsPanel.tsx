import { File, Paths } from "expo-file-system";
import { launchImageLibraryAsync } from "expo-image-picker";
import { Typography, useThemeColor } from "heroui-native";
import { useEffect, useRef, useState, type JSX } from "react";
import { Image, Pressable, View } from "react-native";

import { WALLPAPER_NAMES, Wallpaper } from "@/browser/Wallpaper";
import { Icon } from "@/chrome/Icon";
import { WALLPAPERS } from "@/store/model";
import type { WallpaperId } from "@/store/types";
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
  /** Hidden when the engine can't keep private tabs. */
  privateAvailable: boolean;
  lockPrivateTabs: boolean;
  onLockPrivateTabsChange: (enabled: boolean) => void;
  wallpaper: WallpaperId;
  /** The user's photo, kept even while a built-in wallpaper is chosen. */
  wallpaperPhoto: string | null;
  onWallpaperChange: (id: WallpaperId, photo?: string) => void;
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

type Page = "main" | "engine" | "archive" | "wallpaper";
const titles: Record<Page, string> = { main: "Settings", engine: "Search engine", archive: "Archive inactive tabs", wallpaper: "Wallpaper" };

const count = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : undefined);

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

  const engineName = props.engines.find((engine) => engine.id === props.searchEngineId)?.name;
  return (
    <PanelSheet
      visible={props.visible}
      onClose={props.onClose}
      onBack={page === "main" ? undefined : () => setPage("main")}
      title={titles[page]}
      testID="settings-screen"
      height="85%"
      dismissible={!busy}
    >
      {page === "engine" ? (
        <Group>
          {props.engines.map((engine) => (
            <ActionRow
              key={engine.id}
              testID={`settings-engine-${engine.id}`}
              label={engine.name}
              selected={engine.id === props.searchEngineId}
              onPress={() => {
                props.onSearchEngineChange(engine.id);
                setPage("main");
              }}
            />
          ))}
        </Group>
      ) : page === "archive" ? (
        <>
          <Typography className="px-1 text-sm text-muted">Your current tab stays open. You can restore archived tabs at any time.</Typography>
          <Group>
            {archiveOptions.map((option) => (
              <ActionRow
                key={option.days ?? "never"}
                testID={`settings-archive-${option.days ?? "never"}`}
                label={option.label}
                selected={props.archiveAfterDays === option.days}
                onPress={() => {
                  props.onArchiveAfterDaysChange(option.days);
                  setPage("main");
                }}
              />
            ))}
          </Group>
        </>
      ) : page === "wallpaper" ? (
        <WallpaperPicker value={props.wallpaper} photo={props.wallpaperPhoto} onChange={props.onWallpaperChange} />
      ) : (
        <>
          <Group label="Search">
            <ActionRow
              testID="settings-engine"
              icon="search"
              label="Search engine"
              value={engineName}
              chevron
              disabled={busy}
              onPress={() => setPage("engine")}
            />
          </Group>
          <Group label="Privacy">
            <ActionRow
              testID="settings-block-content"
              icon="shield"
              label="Block ads and trackers"
              detail={props.blockerDetail}
              toggle={props.blockContent}
              disabled={busy}
              onPress={() => props.onBlockContentChange(!props.blockContent)}
            />
            {props.privateAvailable ? (
              <ActionRow
                testID="settings-lock-private"
                icon="lock"
                label="Lock private tabs"
                detail="Face ID, Touch ID or passcode"
                toggle={props.lockPrivateTabs}
                disabled={busy}
                onPress={() => props.onLockPrivateTabsChange(!props.lockPrivateTabs)}
              />
            ) : null}
          </Group>
          <Group label="Appearance">
            <ActionRow
              testID="settings-wallpaper"
              icon="wallpaper"
              label="Wallpaper"
              value={WALLPAPER_NAMES[props.wallpaper]}
              chevron
              disabled={busy}
              onPress={() => setPage("wallpaper")}
            />
          </Group>
          <Group label="Tabs">
            <ActionRow
              testID="settings-archive"
              icon="archive"
              label="Archive inactive tabs"
              value={archiveOptions.find((option) => option.days === props.archiveAfterDays)?.label.replace("After ", "")}
              chevron
              disabled={busy}
              onPress={() => setPage("archive")}
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
        </>
      )}
    </PanelSheet>
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
