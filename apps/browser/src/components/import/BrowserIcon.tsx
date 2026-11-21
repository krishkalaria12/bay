import { Symbol } from "@bay/desktop";
import { useState } from "react";
import { Image } from "expo-image";

/** A missing or unreadable app icon keeps its place in the browser list. */
export function BrowserIcon({ iconPath, size, color }: { iconPath?: string; size: number; color: string }) {
  const [failedPath, setFailedPath] = useState<string>();

  if (!iconPath || failedPath === iconPath) {
    return <Symbol name="globe" size={Math.round(size * 0.7)} color={color} style={{ width: size, height: size }} />;
  }

  return <Image cachePolicy="memory" source={{ uri: `file://${iconPath}` }} style={{ width: size, height: size }} onError={() => setFailedPath(iconPath)} />;
}
