// The pages of Settings that draw more than rows: the custom engine's field, the zoom's preview and steps, the
// wallpapers and the app icons. Moved from the earlier sheet as they were.

import { useThemeColor } from "heroui-native";
import * as Effect from "effect/Effect";
import { File, Paths } from "expo-file-system";
import { launchImageLibraryAsync } from "expo-image-picker";
import { useState, type JSX } from "react";
import { Image, TextInput, View } from "react-native";

import { WALLPAPER_NAMES, Wallpaper } from "@/browser/Wallpaper";
import { Icon } from "@/chrome/Icon";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Text } from "@/chrome/Text";
import { inputFont, radius, space } from "@/chrome/tokens";
import { useCommand } from "@/effect/react";
import { useT } from "@/i18n";
import { isCustomSearchUrl, TEXT_SIZE, WALLPAPERS } from "@/store/model";
import type { WallpaperId } from "@/store/types";

import { Section } from "./SettingsRows";
import { APP_ICONS, type AppIconState } from "./appIcons";

/** The custom engine's address (C17): saved only once it is https with `%s` where the words go. */
export function CustomEngine({ initial, onSave }: { initial: string; onSave: (url: string) => void }): JSX.Element {
  const t = useT();
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const [url, setUrl] = useState(initial);
  const valid = isCustomSearchUrl(url.trim());

  return (
    <>
      <View className="flex-row items-center bg-surface px-4" style={{ borderRadius: radius.card }}>
        <TextInput
          testID="settings-custom-engine-url"
          accessibilityLabel={t("settings.customEngine")}
          value={url}
          onChangeText={setUrl}
          placeholder="https://search.example/?q=%s"
          placeholderTextColor={muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          autoFocus
          onSubmitEditing={() => valid && onSave(url.trim())}
          style={[inputFont("body"), { flex: 1, color: foreground, paddingVertical: 12 }]}
        />
      </View>
      <Text variant="footnote" tone="muted" style={{ paddingHorizontal: space.sm, marginTop: 6 }}>
        {t("settings.customEngine.note")}
      </Text>
      <View style={{ marginTop: space.section }}>
        <Section
          section={{
            id: "use",
            rows: [
              {
                id: "use",
                testID: "settings-custom-engine-save",
                label: t("settings.customEngine.use"),
                disabled: !valid,
                kind: { type: "action", run: () => onSave(url.trim()) },
              },
            ],
          }}
        />
      </View>
    </>
  );
}

/** A preview at the chosen zoom, with smaller and larger steps. */
export function TextSize({ value, onChange }: { value: number; onChange: (size: number) => void }): JSX.Element {
  const foreground = useThemeColor("foreground");
  const t = useT();
  const step = (delta: number) => onChange(Math.min(TEXT_SIZE.max, Math.max(TEXT_SIZE.min, value + delta)));

  return (
    <>
      <View className="bg-surface p-4" style={{ borderRadius: radius.card }}>
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
          className="h-12 flex-1 items-center justify-center rounded-full bg-surface"
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
          className="h-12 flex-1 items-center justify-center rounded-full bg-surface"
          style={{ opacity: value >= TEXT_SIZE.max ? 0.35 : 1 }}
        >
          <Icon name="textSize" color={foreground} size={26} />
        </PressFeedback>
      </View>
      {value !== 100 ? (
        <View style={{ marginTop: space.section }}>
          <Section
            section={{
              id: "reset",
              rows: [{ id: "reset", testID: "text-size-reset", label: t("settings.zoom.reset"), kind: { type: "action", run: () => onChange(100) } }],
            }}
          />
        </View>
      ) : null}
    </>
  );
}

/** Copies a gallery photo into the app's documents and replaces the old one. Null when the picker was cancelled. */
const pickPhoto = (previous: string | null) =>
  Effect.gen(function* () {
    // The system photo picker needs no storage permission.
    const result = yield* Effect.tryPromise(() => launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 }));
    const asset = result.canceled ? undefined : result.assets[0];

    if (!asset) return null;
    const file = new File(Paths.document, `wallpaper-${Date.now()}.jpg`);

    yield* Effect.try(() => new File(asset.uri).copy(file));

    // The old photo is only taking up space now: one that can't be deleted stays behind, and the new one still shows.
    if (previous) yield* Effect.try(() => new File(previous).delete()).pipe(Effect.ignore);

    return file.uri;
  });

/** Three columns of start page previews, then the user's photo. */
export function WallpaperPicker({
  value,
  photo,
  onChange,
}: {
  value: WallpaperId;
  photo: string | null;
  onChange: (id: WallpaperId, photo?: string) => void;
}): JSX.Element {
  const [error, setError] = useState(false);
  // Picking belongs to this page of the sheet: leaving it drops a photo still on its way.
  const { run: runPick } = useCommand<void, never>();
  const foreground = useThemeColor("foreground");
  const t = useT();
  const tiles: WallpaperId[] = [...WALLPAPERS, "photo"];

  return (
    <>
      <View className="mt-1 flex-row flex-wrap" style={{ rowGap: space.lg }}>
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
                // A photo that can't be picked or copied says so under the tiles; it isn't a crash worth reporting.
                runPick(
                  pickPhoto(photo).pipe(
                    Effect.matchEffect({
                      onSuccess: (uri) =>
                        Effect.sync(() => {
                          if (uri) onChange("photo", uri);
                        }),
                      onFailure: () => Effect.sync(() => setError(true)),
                    }),
                  ),
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
                  // The start page in miniature: the greeting and date, a row of pins, then the bar.
                  <View className="absolute bottom-2.5 left-0 right-0 gap-2 px-2.5">
                    <View className="gap-1">
                      <View className="h-2 w-3/5 rounded-full bg-foreground/30" />
                      <View className="h-1.5 w-2/5 rounded-full bg-foreground/15" />
                    </View>
                    <View className="flex-row justify-between">
                      {[0, 1, 2, 3].map((pin) => (
                        <View key={pin} className="h-4 w-4 rounded-[5px] bg-foreground/15" />
                      ))}
                    </View>
                    <View className="mt-1.5 flex-row justify-center gap-1">
                      <View className="h-3 w-3 rounded-full bg-foreground/15" />
                      <View className="h-3 w-8 rounded-full bg-foreground/15" />
                      <View className="h-3 w-3 rounded-full bg-foreground/15" />
                    </View>
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

/** The home screen icon, three to a row as the wallpapers are: the desktop's set (its Settings › Appearance has it too). */
export function AppIconPicker({ appIcon }: { appIcon: AppIconState }): JSX.Element {
  const t = useT();

  return (
    <View className="mt-1 flex-row flex-wrap" style={{ rowGap: space.lg }}>
      {APP_ICONS.map((icon, index) => {
        const selected = icon === appIcon.current;
        const id = (icon.name ?? "default").toLowerCase();

        return (
          <PressFeedback
            key={id}
            testID={`settings-app-icon-${id}`}
            accessibilityRole="radio"
            accessibilityLabel={t(icon.label)}
            accessibilityState={{ selected, checked: selected }}
            onPress={() => appIcon.choose(icon)}
            className="items-center gap-2"
            style={{ width: "31%", marginRight: index % 3 === 2 ? 0 : "3.5%" }}
          >
            <View className={selected ? "border-2 border-accent" : "border-2 border-transparent"} style={{ padding: 3, borderRadius: radius.tile + 5 }}>
              <Image
                source={icon.image}
                resizeMethod="resize"
                fadeDuration={0}
                accessibilityIgnoresInvertColors
                style={{ width: 64, height: 64, borderRadius: radius.tile - 4 }}
              />
            </View>
            <Text variant="subhead" weight={selected ? "medium" : undefined} tone={selected ? "accent" : "default"}>
              {t(icon.label)}
            </Text>
          </PressFeedback>
        );
      })}
    </View>
  );
}
