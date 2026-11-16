import type { JSX } from "react";
import { Image, StyleSheet, useColorScheme, View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Pattern, Rect, Stop } from "react-native-svg";

import type { MessageKey } from "@/i18n";
import type { WallpaperId } from "@/store/types";

interface Palette {
  top: string;
  middle: string;
  bottom: string;
  dot: string;
  dotOpacity: number;
}

const darkDots = { dot: "#FFFFFF", dotOpacity: 0.06 };
const lightDots = { dot: "#1B2A3A", dotOpacity: 0.07 };

// Bay's start pages, each a light and a dark wash under a fine dot grid. Plain is the theme's background.
const WALLPAPER_PALETTES: Record<Exclude<WallpaperId, "plain" | "photo">, { light: Palette; dark: Palette }> = {
  bay: {
    light: { top: "#B8D3EA", middle: "#D9E4EF", bottom: "#EEDFD9", ...lightDots },
    dark: { top: "#0F1C2A", middle: "#14202C", bottom: "#231D24", ...darkDots },
  },
  dusk: {
    light: { top: "#F2D4C4", middle: "#EAD8E2", bottom: "#D3D0EC", ...lightDots },
    dark: { top: "#26182A", middle: "#1C1727", bottom: "#121624", ...darkDots },
  },
  forest: {
    light: { top: "#C9DFCC", middle: "#DFEADB", bottom: "#EFEADA", ...lightDots },
    dark: { top: "#0E1D18", middle: "#121E19", bottom: "#1B1D16", ...darkDots },
  },
};

/** Each wallpaper's name in the catalogue, for Settings to show in the current language. */
export const WALLPAPER_NAMES: Record<WallpaperId, MessageKey> = {
  bay: "settings.wallpapers.bay",
  dusk: "settings.wallpapers.dusk",
  forest: "settings.wallpapers.forest",
  plain: "settings.wallpapers.plain",
  photo: "settings.wallpapers.photo",
};

// A wallpaper is only a backdrop: screen readers skip it.
const hidden = { accessible: false, accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" } as const;

function wallpaperPalette(id: WallpaperId, dark: boolean): Palette | null {
  return id === "plain" || id === "photo" ? null : WALLPAPER_PALETTES[id][dark ? "dark" : "light"];
}

export function Wallpaper({
  id,
  photo,
  scale = 1,
}: {
  id: WallpaperId;
  /** The user's photo, for id "photo". */
  photo?: string | null;
  /** Dot spacing, smaller for previews. */
  scale?: number;
}): JSX.Element | null {
  const colors = wallpaperPalette(id, useColorScheme() === "dark");

  if (id === "photo" && photo) {
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="none" {...hidden}>
        {/* Decoded at the view's size (resizeMethod), not the photo's: a 12 MP photo would take ~48 MB as a bitmap. */}
        <Image source={{ uri: photo }} style={StyleSheet.absoluteFill} resizeMode="cover" resizeMethod="resize" fadeDuration={0} />
        {/* Darkens the lower half, where the start page's text sits, so it reads on any photo. */}
        <Svg style={StyleSheet.absoluteFill}>
          <Defs>
            <LinearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0.35" stopColor="#000000" stopOpacity={0} />
              <Stop offset="1" stopColor="#000000" stopOpacity={0.55} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#scrim)" />
        </Svg>
      </View>
    );
  }

  if (!colors) return <View style={StyleSheet.absoluteFill} className="bg-background" pointerEvents="none" {...hidden} />;

  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none" {...hidden}>
      <Defs>
        <LinearGradient id={`wash-${id}`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={colors.top} />
          <Stop offset="0.55" stopColor={colors.middle} />
          <Stop offset="1" stopColor={colors.bottom} />
        </LinearGradient>
        <Pattern id={`dots-${id}`} width={14 * scale} height={14 * scale} patternUnits="userSpaceOnUse">
          <Circle cx={7 * scale} cy={7 * scale} r={0.9} fill={colors.dot} fillOpacity={colors.dotOpacity} />
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#wash-${id})`} />
      <Rect width="100%" height="100%" fill={`url(#dots-${id})`} />
    </Svg>
  );
}
