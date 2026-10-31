import type { AreaLightPalette } from "@bay/shaders";
import { createContext, createElement, useContext, type ReactNode } from "react";
import { create } from "zustand";
import { useBrowserRead as useBrowser } from "../store/read";
import type { BrowserProjection as BrowserState, DeepReadonly } from "../runtime/projection";
import { PageSpaceContext, WindowContext } from "../store/hooks";
import { activeTabId } from "../store/model";
import { DEFAULT_SPACE } from "../store/spaces";
import type { Space, SpaceColor } from "../store/types";
import { useHighContrast } from "./highContrast";
import { SPACE_SWATCHES } from "./spaceSwatches";
import { backdropTint, opaqueTint, pageTint, tintForHue, type BackdropTint } from "./windowTint";

export type Theme = typeof dark &
  ProfileTheme & {
    backdrop: BackdropTint;
    // The window's colours: what a solid window shows, or a glass one when inactive.
    windowTint: [string, string];
    // Glass (Appearance › Window): the desktop shows through the window.
    glass: boolean;
    powerUpColor: string | null;
  };

const dark = {
  dark: true,
  // Dia: 0.09 sidebar, 0.05 page.
  grain: 0.09,
  // Dia: 0.5 tint.
  card: "rgba(18,18,18,0.5)",
  cardEdge: "rgba(0,0,0,0.35)",
  divider: "rgba(255,255,255,0.08)",

  textPrimary: "#FFFFFF",
  textTab: "#FFFFFFC7", // Dia: 0.78.
  textSecondary: "#FFFFFF80",
  textTertiary: "#FFFFFF59",
  icon: "#F7F5FFC6", // Dia: 0.78.
  iconDisabled: "#F7F5FF4D",

  tabHover: "rgba(255,255,255,0.16)",
  tabPressed: "rgba(255,255,255,0.31)",
  // Dia: 0.5.
  tabSelected: "rgba(18,18,18,0.5)",
  tabSelectedText: "#FFFFFF",
  // Dia: 0.5pt border; 15/12.5 shadow.
  tabSelectedBorder: ["rgba(255,255,255,0.15)", "rgba(255,255,255,0.15)"] as [string, string],
  // No glow: a white one haloed the row on the dark sidebar. Its fill and border set it apart.
  tabSelectedShadow: "rgba(0,0,0,0)",
  tabSelectedShadowRadius: 0,
  pinnedResting: "rgba(255,255,255,0.1)",
  pinnedRestingStroke: "rgba(255,255,255,0.14)",
  pinnedSelectedFill: "rgba(255,255,255,0.25)",
  pinnedSelectedRim: "rgba(0,0,0,0.85)",
  pinnedSelectedOutline: "rgba(255,255,255,0.2)",

  toolbarHover: "rgba(255,255,255,0.1)",
  toolbarPressed: "rgba(255,255,255,0.18)",
  urlPill: "rgba(255,255,255,0.07)",

  panel: "#2A2A2A",
  panelBorder: "rgba(255,255,255,0.1)",
  panelShadowOpacity: 0.5,
  rowSelected: "rgba(255,255,255,0.22)",
  rowHover: "rgba(255,255,255,0.07)",
  selection: "rgba(120,125,134,0.7)",
  placeholder: "#FFFFFF87", // Dia: 0.53.
  chipBorder: "rgba(255,255,255,0.15)",
  chipText: "#FFFFFF99",
  goButton: "#DCCBD8",
  goButtonText: "#1A1418",
  sendIdle: "rgba(255,255,255,0.08)",

  ntpBar: "rgba(24,24,24,0.8)",
  ntpBarSolid: "#2D2D2D",
  ntpBarBorder: "rgba(120,125,134,0.32)",
  lightIntensity: 4,
  accent: "#4A77D4",
};

const light: typeof dark = {
  dark: false,
  grain: 0.05,
  card: "rgba(255,255,255,0.7)", // Dia: 0.7.
  cardEdge: "rgba(0,0,0,0.08)",
  divider: "rgba(0,0,0,0.08)",

  textPrimary: "#000000",
  textTab: "#000000AD", // Dia: 0.68.
  textSecondary: "#00000080",
  textTertiary: "#00000059",
  icon: "#000000C6",
  iconDisabled: "#0000004D",

  tabHover: "rgba(255,255,255,0.55)",
  tabPressed: "rgba(255,255,255,0.7)",
  tabSelected: "rgba(255,255,255,0.7)",
  tabSelectedText: "#000000",
  tabSelectedBorder: ["rgba(255,255,255,0.98)", "rgba(0,0,0,0.06)"],
  // No shadow, as in dark: its fill and border set it apart.
  tabSelectedShadow: "rgba(0,0,0,0)",
  tabSelectedShadowRadius: 0,
  pinnedResting: "rgba(0,0,0,0.05)",
  pinnedRestingStroke: "rgba(0,0,0,0.18)",
  pinnedSelectedFill: "rgba(255,255,255,0.7)",
  pinnedSelectedRim: "rgba(0,0,0,0.12)",
  pinnedSelectedOutline: "rgba(255,255,255,0.98)",

  toolbarHover: "rgba(0,0,0,0.06)",
  toolbarPressed: "rgba(0,0,0,0.1)",
  urlPill: "rgba(0,0,0,0.05)",

  panel: "#FFFFFF",
  panelBorder: "rgba(0,0,0,0.1)",
  panelShadowOpacity: 0.18,
  rowSelected: "rgba(15,24,44,0.08)",
  rowHover: "rgba(15,24,44,0.05)",
  selection: "rgba(120,125,134,0.4)",
  placeholder: "#00000066",
  chipBorder: "rgba(0,0,0,0.12)",
  chipText: "#00000099",
  goButton: "#0F182C",
  goButtonText: "#FFFFFF",
  sendIdle: "rgba(0,0,0,0.06)",

  ntpBar: "rgba(255,255,255,0.85)",
  ntpBarSolid: "#FEFFFF",
  ntpBarBorder: "rgba(0,0,0,0.07)",
  lightIntensity: 0.5,
  accent: "#6395FC",
};

export function hex(color: string): string {
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return color;
  const [r, g, b, a = "1"] = m[1]!.split(",").map((v) => v.trim());
  const h = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${h(+r!)}${h(+g!)}${h(+b!)}${h(+a * 255)}`;
}

type ProfileTheme = {
  // A preset's palette, or a custom theme's own colours.
  lightPalette: AreaLightPalette | string[] | null;
  // Dia: 0.5 / 0.4.
  edgeLight: string;
};

type SpaceColorSpec = {
  name: string;
  swatch: string;
  palette: AreaLightPalette | null;
  powerUp?: string;
  tint?: string;
  action?: string;
  dark?: ProfileTheme;
  light?: ProfileTheme;
};

export const SPACE_COLORS: Record<SpaceColor, SpaceColorSpec> = {
  plum: {
    name: "Plum",
    swatch: SPACE_SWATCHES.plum,
    // Dia: plum band #B5556B, tint #B25B6B, name #DD899B.
    powerUp: "#B5556B",
    tint: "#B25B6B",
    action: "#DD899B",
    palette: "pink",
    dark: { lightPalette: "pink", edgeLight: "#EBB3CB80" },
    light: { lightPalette: "pink", edgeLight: "#D37B8B66" },
  },
  blue: { name: "Blue", swatch: SPACE_SWATCHES.blue, palette: "blue" },
  purple: { name: "Purple", swatch: SPACE_SWATCHES.purple, palette: "purple" },
  pink: { name: "Pink", swatch: SPACE_SWATCHES.pink, palette: "pink" },
  red: { name: "Red", swatch: SPACE_SWATCHES.red, palette: "red" },
  orange: { name: "Orange", swatch: SPACE_SWATCHES.orange, palette: "orange" },
  yellow: { name: "Yellow", swatch: SPACE_SWATCHES.yellow, palette: "yellow" },
  green: { name: "Green", swatch: SPACE_SWATCHES.green, palette: "green" },
  neutral: {
    name: "Neutral",
    swatch: SPACE_SWATCHES.neutral,
    palette: null,
    dark: { lightPalette: null, edgeLight: "#FFFFFF40" },
    light: { lightPalette: null, edgeLight: "#00000026" },
  },
};

const INCOGNITO_TINT = "#3A3A3C";
const INCOGNITO: ProfileTheme = { lightPalette: null, edgeLight: "#FFFFFF33" };

export function profileNameColor(color: SpaceColor, dark: boolean): string {
  const spec = SPACE_COLORS[color] ?? SPACE_COLORS.plum;
  const base = spec.action ?? spec.swatch;
  return dark ? mix(base, "#FFFFFF", 0.6) : mix(base, "#000000", 0.4);
}

function mix(a: string, b: string, t: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
  const out = [0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t));
  return `#${out
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function profileTheme(color: SpaceColor, isDark: boolean): ProfileTheme {
  const spec = SPACE_COLORS[color] ?? SPACE_COLORS.plum;
  const explicit = isDark ? spec.dark : spec.light;
  if (explicit) return explicit;
  return isDark
    ? { lightPalette: spec.palette, edgeLight: `${mix(spec.swatch, "#FFFFFF", 0.5)}80` }
    : { lightPalette: spec.palette, edgeLight: `${spec.swatch}66` };
}

const cache = new Map<string, Theme>();
// Custom themes are keyed by their values, so dragging in the theme editor makes a key a frame, and solid windows by
// their pages' colours: keep the latest few.
const MAX_TRANSIENT = 48;
const CUSTOM = "custom|";

const GLASS = ":glass";
// A solid window's page colour, after its space's key: "plum:dark@#202124".
const SITE = "@";
// High contrast, last of all: "plum:dark@#202124!contrast".
const CONTRAST = "!contrast";
const CONTRAST_INTENSITY = 0.5;
const transient = (key: string) => key.startsWith(CUSTOM) || key.includes(SITE);

/** A space's theme key: its preset colour's, or its own theme's (the theme editor); glass windows' end in ":glass". */
export function spaceThemeKey(profile: DeepReadonly<Pick<Space, "color" | "theme">> | undefined, dark: boolean, glass = false): string {
  const space = profile ?? DEFAULT_SPACE;
  const mode = `${dark ? "dark" : "light"}${glass ? GLASS : ""}`;
  const t = space.theme;
  if (!t?.colors.length) return `${space.color}:${mode}`;
  return `${CUSTOM}${t.colors.join(",")}|${t.intensity.toFixed(2)}|${t.grain.toFixed(2)}:${mode}`;
}

/** A custom theme's grain dial (0–1) as the backdrop's grain opacity; the dial's preview uses the same. */
export const customGrain = (dial: number) => dial * 0.12;

function customTheme(key: string): Theme {
  const [body, mode, material] = key.split(":") as [string, string, string | undefined];
  const [, list, intensity, grain] = body.split("|") as [string, string, string, string];
  const colors = list.split(",");
  const isDark = mode === "dark";
  const solid = material !== "glass";
  const base = isDark ? dark : light;
  const first = colors[0]!;
  const last = colors[colors.length - 1]!;
  // Intensity takes the tint from a whisper (0.08) to well past a preset's (0.36).
  const backdrop = { ...backdropTint(first, false), tintAlpha: 0.08 + 0.52 * Number(intensity) };
  const top = opaqueTint(backdrop, isDark, solid);
  const windowTint: [string, string] = colors.length > 1 ? [top[0], opaqueTint({ ...backdrop, tintColor: last }, isDark, solid)[0]] : top;
  return {
    ...base,
    lightPalette: colors,
    edgeLight: isDark ? `${mix(first, "#FFFFFF", 0.5)}80` : `${first}66`,
    backdrop,
    windowTint,
    glass: !solid,
    powerUpColor: first,
    grain: customGrain(Number(grain)),
  };
}

function presetTheme(key: string): Theme {
  const [color, mode, material] = key.split(":") as [SpaceColor | "incognito", string, string | undefined];
  const solid = material !== "glass";
  const base = color === "incognito" ? { ...dark, ...INCOGNITO } : { ...(mode === "dark" ? dark : light), ...profileTheme(color, mode === "dark") };
  const spec = color === "incognito" ? null : (SPACE_COLORS[color] ?? SPACE_COLORS.plum);
  // Dia: neutral band 0.502 at 0.65.
  const powerUpColor = !spec ? null : spec.palette ? (spec.powerUp ?? spec.swatch) : "#808080A6";
  const backdrop = backdropTint(spec ? (spec.tint ?? tintForHue(spec.swatch, !spec.palette)) : INCOGNITO_TINT, !spec?.palette);
  return {
    ...base,
    backdrop,
    windowTint: opaqueTint(backdrop, base.dark, solid),
    glass: !solid,
    powerUpColor,
  };
}

// High contrast (prefers-contrast: more): opaque text and icons, edges that show, and a solid outline on the selection,
// with no grain behind them. themeKey also drops glass, so the window is solid.
function contrasted(theme: Theme): Theme {
  const ink = theme.dark ? "#FFFFFF" : "#000000";
  const edge = theme.dark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.5)";
  return {
    ...theme,
    grain: 0,
    textTab: ink,
    textSecondary: `${ink}CC`,
    textTertiary: `${ink}A6`,
    icon: ink,
    iconDisabled: `${ink}80`,
    placeholder: `${ink}B3`,
    chipText: `${ink}D9`,
    tabSelectedText: ink,
    divider: edge,
    cardEdge: edge,
    panelBorder: edge,
    chipBorder: edge,
    ntpBarBorder: edge,
    pinnedRestingStroke: edge,
    tabSelectedBorder: [ink, ink],
    pinnedSelectedOutline: ink,
  };
}

export function themeFor(key: string): Theme {
  let theme = cache.get(key);
  if (theme) return theme;
  const site = key.indexOf(SITE);
  if (key.endsWith(CONTRAST)) theme = contrasted(themeFor(key.slice(0, -CONTRAST.length)));
  // A solid window filled with its page's colour, its space's theme in the look that reads on it.
  else if (site >= 0) theme = { ...themeFor(key.slice(0, site)), windowTint: [key.slice(site + 1), key.slice(site + 1)] };
  else theme = key.startsWith(CUSTOM) ? customTheme(key) : presetTheme(key);
  cache.set(key, theme);
  if (transient(key)) {
    const keys = [...cache.keys()].filter(transient);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_TRANSIENT))) cache.delete(old);
  }
  return theme;
}

// The colour the page the window shows for a space reports (its theme-color, else its top's), if any.
function siteColor(s: BrowserState, windowId: string, spaceId: string): string | null {
  const id = activeTabId(s, windowId, spaceId);
  const color = id && s.tabs[id]?.url ? s.live[id]?.themeColor : null;
  return color && /^#[0-9a-f]{6}/i.test(color) ? color.slice(0, 7).toUpperCase() : null;
}

/**
 * A window's theme key for a space (its own by default): a solid one takes its page's colour, glass its space's. A
 * space's own theme (the theme editor's) always shows, as Arc's and Zen's do: only a preset colour gives way to the page.
 */
type PreviewLook = Pick<Space, "color" | "theme" | "followSite">;
const usePreviewLooks = create<Record<string, PreviewLook>>(() => ({}));

export function themeKey(
  s: BrowserState,
  windowId: string | null,
  page: string | null,
  looks = usePreviewLooks.getState(),
  contrast = useHighContrast.getState(),
): string {
  const key = lookKey(s, windowId, page, looks, contrast);
  return contrast ? `${key}${CONTRAST}` : key;
}

function lookKey(s: BrowserState, windowId: string | null, page: string | null, looks: Record<string, PreviewLook>, contrast: boolean): string {
  const id = windowId ?? s.ui.focusedWindowId ?? "";
  const w = s.windows[id];
  const glass = s.settings.windowMaterial === "glass" && !contrast;
  if (w?.incognito) return `incognito:dark${glass ? GLASS : ""}`;
  const spaceId = page ?? w?.spaceId ?? s.settings.defaultSpaceId;
  // A look being chosen for this window (the new space panel's) shows on its space meanwhile.
  const preview = w && spaceId === w.spaceId ? looks[id] : undefined;
  const space = { ...(s.spaces[spaceId] ?? DEFAULT_SPACE), ...preview };
  // Light or dark is always the user's (Appearance, or macOS's with Automatic); the page's colour is fitted to it.
  // High contrast keeps the space's own colour, which its text is checked against.
  const follow = space?.followSite ?? !space?.theme?.colors.length;
  const pageColor = w && !glass && !contrast && follow ? siteColor(s, id, spaceId) : null;
  const site = pageColor ? pageTint(pageColor, s.ui.appDark) : null;
  // A strong theme of its own tints the window towards mid grey, where no text colour reads: at most half, in contrast.
  const theme = contrast && space.theme ? { ...space.theme, intensity: Math.min(space.theme.intensity, CONTRAST_INTENSITY) } : space.theme;
  const key = spaceThemeKey({ ...space, theme }, s.ui.appDark, glass);
  return site ? `${key}${SITE}${site}` : key;
}

const ThemeContext = createContext<Theme | null>(null);

/** Shows `look` on the window's space until it's cleared (null): the new space panel's Look step. */
export function setPreviewLook(windowId: string, look: Pick<Space, "color" | "theme" | "followSite"> | null) {
  usePreviewLooks.setState((current) => {
    const looks = { ...current };
    if (look) looks[windowId] = look;
    else delete looks[windowId];
    return looks;
  }, true);
}

// Resolves the theme once for everything below it: every window root and every profile page (which
// sets PageProfileContext) has one, so the hundreds of components that call useTheme read a context
// instead of each subscribing to the store (each subscription runs on every store update).
export function ThemeScope({ children }: { children: ReactNode }) {
  const windowId = useContext(WindowContext);
  const page = useContext(PageSpaceContext);
  const looks = usePreviewLooks();
  const contrast = useHighContrast();
  const key = useBrowser((s) => themeKey(s, windowId, page, looks, contrast));
  return createElement(ThemeContext.Provider, { value: themeFor(key) }, children);
}

// Outside a ThemeScope (nothing renders there today) the theme is read once, not followed.
const unscopedTheme = () => themeFor(themeKey(useBrowser.getState(), null, null));

export function useTheme(): Theme {
  const scoped = useContext(ThemeContext);
  if (scoped) return scoped;
  if (__DEV__) console.warn("useTheme outside a ThemeScope");
  return unscopedTheme();
}
