import { hostOf } from "@bay/core/src/omnibox.ts";
import type { JSX } from "react";
import { Text, View } from "react-native";

const tints = ["#DCE8F5", "#F3E2D6", "#E3EEDF", "#ECE1F2", "#F5E9C9", "#DDEEEE"];

/** A monogram tile for a site. Pages load no favicons into the app, so nothing about a visit leaves the engine. */
export function SiteIcon({ url, size = 28 }: { url: string; size?: number }): JSX.Element {
  const host = hostOf(url);
  const letter = (host.match(/[a-z0-9]/i)?.[0] ?? "•").toUpperCase();
  let hash = 0;
  for (const char of host) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return (
    <View
      className="items-center justify-center border border-black/5"
      style={{ width: size, height: size, borderRadius: size * 0.28, backgroundColor: tints[Math.abs(hash) % tints.length] }}
    >
      <Text style={{ fontSize: size * 0.48, fontWeight: "600", color: "#26313D" }}>{letter}</Text>
    </View>
  );
}
