import { hostOf } from "@bay/core/src/input.ts";
import { useState, type JSX } from "react";
import { Image, useColorScheme, View } from "react-native";

import { Text } from "@/chrome/Text";
import { useBrowserStore } from "@/store/browser";
import { siteHost } from "@/store/model";

const tints = ["#DCE8F5", "#F3E2D6", "#E3EEDF", "#ECE1F2", "#F5E9C9", "#DDEEEE"];

/**
 * The site's saved icon on a tile matching the theme, else a monogram. Icons are local files (`favicons.ts`), so this
 * never loads anything. It always sits beside the site's name, so screen readers skip it.
 */
export function SiteIcon({ url, size = 28 }: { url: string; size?: number }): JSX.Element {
  const host = siteHost(url);
  const icon = useBrowserStore((state) => state.data.favicons[host]);
  const [broken, setBroken] = useState<string | null>(null);
  // Sites that switch icons with the colour scheme (GitHub's turns white in dark mode) gave the one for this theme.
  const tile = useColorScheme() === "dark" ? "#2C2C2E" : "#FFFFFF";
  const radius = size * 0.28;

  if (icon && broken !== icon) {
    const inner = Math.round(size * 0.72);

    return (
      <View
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="items-center justify-center border border-black/5 dark:border-white/10"
        style={{ width: size, height: size, borderRadius: radius, backgroundColor: tile }}
      >
        <Image
          source={{ uri: icon, width: inner, height: inner }}
          style={{ width: inner, height: inner, borderRadius: radius * 0.5 }}
          resizeMethod="resize"
          fadeDuration={0}
          onError={() => {
            // The cache was cleared or the file isn't an image: show the monogram, and fetch it again next visit.
            setBroken(icon);
            useBrowserStore.getState().dispatch({ type: "favicon", host, uri: null });
          }}
        />
      </View>
    );
  }

  const name = hostOf(url);
  const letter = (name.match(/[a-z0-9]/i)?.[0] ?? "•").toUpperCase();
  let hash = 0;

  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;

  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="items-center justify-center border border-black/5"
      style={{ width: size, height: size, borderRadius: radius, backgroundColor: tints[Math.abs(hash) % tints.length] }}
    >
      <Text weight="semibold" color="#26313D" style={{ fontSize: size * 0.48, lineHeight: size * 0.6 }}>
        {letter}
      </Text>
    </View>
  );
}
