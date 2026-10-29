import { fileExists } from "@bay/shell";
import type { ImageSourcePropType } from "react-native";

// The browsers onboarding offers to leave, found by where their apps live: a check per path, so the import step has
// them on its first frame. The importer's own scan (every profile, Arc's spaces) comes later, for the import itself.

export type InstalledBrowser = { id: string; name: string; app: string };

// Ids are the importer's. In the order the step offers them; the first found is the one it starts on.
const CANDIDATES: { id: string; name: string; apps: string[] }[] = [
  { id: "arc", name: "Arc", apps: ["Arc.app"] },
  { id: "dia", name: "Dia", apps: ["Dia.app"] },
  { id: "chrome", name: "Google Chrome", apps: ["Google Chrome.app"] },
  { id: "brave", name: "Brave", apps: ["Brave Browser.app"] },
  { id: "edge", name: "Microsoft Edge", apps: ["Microsoft Edge.app"] },
  { id: "firefox", name: "Firefox", apps: ["Firefox.app"] },
  { id: "zen", name: "Zen", apps: ["Zen.app", "Zen Browser.app"] },
  { id: "helium", name: "Helium", apps: ["Helium.app"] },
  { id: "vivaldi", name: "Vivaldi", apps: ["Vivaldi.app"] },
  { id: "opera", name: "Opera", apps: ["Opera.app"] },
  { id: "operaGX", name: "Opera GX", apps: ["Opera GX.app"] },
  { id: "island", name: "Island", apps: ["Island.app"] },
  { id: "chromium", name: "Chromium", apps: ["Chromium.app"] },
  { id: "safari", name: "Safari", apps: ["/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app", "Safari.app"] },
];

export function detectBrowsers(): InstalledBrowser[] {
  return CANDIDATES.flatMap(({ id, name, apps }) => {
    const app = apps.map((a) => (a.startsWith("/") ? a : `/Applications/${a}`)).find(fileExists);
    return app ? [{ id, name, app }] : [];
  });
}

// Shown until the app's own icon comes back from the system.
const BUNDLED: Record<string, ImageSourcePropType> = {
  arc: require("../../../assets/browsers/arc.png"),
  dia: require("../../../assets/browsers/dia.png"),
  chrome: require("../../../assets/browsers/chrome.png"),
  brave: require("../../../assets/browsers/brave.png"),
  edge: require("../../../assets/browsers/edge.png"),
  firefox: require("../../../assets/browsers/firefox.png"),
  zen: require("../../../assets/browsers/zen.png"),
  safari: require("../../../assets/browsers/safari.png"),
};

export const bundledBrowserIcon = (id: string): ImageSourcePropType | null => BUNDLED[id] ?? null;
