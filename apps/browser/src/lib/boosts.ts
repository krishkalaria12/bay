import { parseUrl } from "@bay/core";
import type { EngineBoost, EngineBoostStyle } from "@bay/nncore";
import { hexFromHsl, hslOf } from "./windowTint";

// Boosts, as Arc's (2022, v2 2023) and Zen's: a site's own look, made without code and with it if you like. Colours
// (a tint from two dots on a wheel, Arc's Invert, contrast, brightness and how much of the page's own colour stays),
// a font, a size, a case, elements zapped away (or one kept alone: Zen's Focus), and CSS. JavaScript too, but only on
// this Mac (scripts aren't part of a Boost's synced record: Arc stopped syncing them after a security report in
// September 2024), off until turned on, and never in private windows unless allowed. The engine puts a Boost's sheets
// into its site's pages at document start (NNCoreEngine setBoosts:), so nothing zapped is ever seen; this file turns
// Boosts into those sheets.

export type BoostTextCase = "none" | "lowercase" | "uppercase" | "capitalize";

export type BoostColor = {
  // The wheel's big dot ("#RRGGBB"): the dark end of the tint.
  accent: string;
  // The small dot: degrees round the wheel from the accent's hue, the light end's hue.
  spread: number;
  // How strongly the page takes the tint, 0–1.
  contrast: number;
  // How light the tint's ends are, 0–1.
  brightness: number;
  // How much of the page's own colour stays (Arc's "Original Saturation"), 0–1.
  saturation: number;
  // The tint follows the tab's space colours instead (Zen's magic theme): set per tab, as tabs differ.
  theme: boolean;
};

export type Boost = {
  id: string;
  // The site, without "www." (its pages match with or without it).
  host: string;
  name: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  // null: the page's own colours.
  color: BoostColor | null;
  // Arc's Invert: light pages go dark (Chrome's forced dark mode, which keeps photos as they are).
  invert: boolean;
  // A font family; "" keeps the site's.
  font: string;
  // Page size, 1 = 100 %.
  size: number;
  textCase: BoostTextCase;
  // Selectors of zapped elements.
  zaps: string[];
  // Selectors of the elements kept alone (Zen's Focus): everything else is hidden.
  focus: string[];
  css: string;
};

// A Boost's JavaScript: this Mac's only.
export type BoostScript = {
  code: string;
  enabled: boolean;
  // Run in private windows too.
  privateWindows: boolean;
};

export const BOOST_SIZES = [0.9, 1, 1.1, 1.25, 1.5] as const;
export const BOOST_CASES: BoostTextCase[] = ["none", "capitalize", "uppercase", "lowercase"];
// Arc's and Zen's font grid: a few faces macOS has, each a click; the menu has the rest.
export const BOOST_FONTS = ["New York", "Georgia", "Avenir Next", "Futura", "Gill Sans", "Charter", "Optima", "SF Mono", "Menlo"] as const;
export const MAX_BOOST_CSS = 200_000;
export const MAX_BOOST_SCRIPT = 200_000;
const MAX_SELECTORS = 300;
const MAX_SELECTOR = 2_000;
const MAX_NAME = 80;

export const DEFAULT_BOOST_COLOR: BoostColor = { accent: "#4F7BE8", spread: 40, contrast: 0.55, brightness: 0.5, saturation: 0.3, theme: false };

/** The site a page's address belongs to, as Boosts name it: its host without "www."; "" for pages Boosts can't touch. */
export function boostHost(url: string | undefined | null): string {
  const parsed = url ? parseUrl(url) : null;
  if (!parsed || (parsed.scheme !== "http" && parsed.scheme !== "https")) return "";
  const host = parsed.host.replace(/\.$/, "").replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host) ? host : "";
}

export function newBoost(id: string, host: string, at: number, name = "My Boost"): Boost {
  return {
    id,
    host,
    name,
    enabled: true,
    createdAt: at,
    updatedAt: at,
    color: null,
    invert: false,
    font: "",
    size: 1,
    textCase: "none",
    zaps: [],
    focus: [],
    css: "",
  };
}

/** Whether a Boost changes anything yet: a fresh one doesn't. */
export function boostChanges(b: Boost): boolean {
  return !!(b.color || b.invert || b.font || b.size !== 1 || b.textCase !== "none" || b.zaps.length || b.focus.length || b.css.trim());
}

// MARK: Normalizing (saved, synced and imported Boosts are untrusted)

const clamp01 = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

function selectors(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const s of v) {
    const sel = cleanSelector(s);
    if (sel && !out.includes(sel)) out.push(sel);
    if (out.length >= MAX_SELECTORS) break;
  }
  return out;
}

/** A selector safe to put in a rule: balanced syntax with no unescaped rule delimiters or comments. */
export function cleanSelector(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let sel = v.replace(/^[ \t\r\n\f]+/, "");
  let end = sel.length;
  // A final escaped space is identifier text, unlike ordinary selector padding.
  while (end && /[ \t\r\n\f]/.test(sel[end - 1]!)) {
    let slashes = 0;
    for (let at = end - 2; at >= 0 && sel[at] === "\\"; at--) slashes++;
    if (slashes % 2) break;
    end--;
  }
  sel = sel.slice(0, end);
  if (!sel || sel.length > MAX_SELECTOR || sel.includes("\0")) return null;
  // Escaped delimiters are identifier text. Consume hex escapes and their optional whitespace
  // before checking the remaining syntax, so CSS.escape output stays usable.
  const syntax = sel.replace(/\\(?:[0-9a-f]{1,6}(?:\r\n|[ \t\r\n\f])?|[^\r\n\f])/gi, "x");
  const closing: string[] = [];
  let quote = "";
  for (let i = 0; i < syntax.length; i++) {
    const c = syntax[i]!;
    if (quote) {
      if (/[\r\n\f]/.test(c)) return null;
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (/[{}<\\;@]/.test(c) || syntax.slice(i, i + 2) === "/*" || syntax.slice(i, i + 2) === "*/") return null;
    else if (c === "(" || c === "[") closing.push(c === "(" ? ")" : "]");
    else if ((c === ")" || c === "]") && closing.pop() !== c) return null;
  }
  if (quote || closing.length) return null;
  return sel;
}

/** A font family name safe to quote in CSS; "" for none. */
export function cleanFont(v: unknown): string {
  return typeof v === "string"
    ? v
        .replace(/["'\\;{}<>\n\r]/g, "")
        .trim()
        .slice(0, 100)
    : "";
}

export function normalizeColor(v: unknown): BoostColor | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Partial<BoostColor>;
  return {
    accent: isHex(c.accent) ? c.accent.toUpperCase() : DEFAULT_BOOST_COLOR.accent,
    spread: typeof c.spread === "number" && Number.isFinite(c.spread) ? ((Math.round(c.spread) % 360) + 360) % 360 : DEFAULT_BOOST_COLOR.spread,
    contrast: clamp01(c.contrast, DEFAULT_BOOST_COLOR.contrast),
    brightness: clamp01(c.brightness, DEFAULT_BOOST_COLOR.brightness),
    saturation: clamp01(c.saturation, DEFAULT_BOOST_COLOR.saturation),
    theme: c.theme === true,
  };
}

/** A Boost from anything (a saved file, a sync record, an import); null if it can't be one. */
export function normalizeBoost(v: unknown): Boost | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Partial<Boost>;
  const id = text(b.id, 100);
  const raw =
    typeof b.host === "string"
      ? b.host
          .trim()
          .toLowerCase()
          .replace(/\.$/, "")
          .replace(/^www\./, "")
      : "";
  // A host alone: letters, digits, dots and hyphens (no scheme, port or path).
  const host = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(raw) ? raw : "";
  if (!id || !host) return null;
  const at = typeof b.createdAt === "number" && Number.isFinite(b.createdAt) ? b.createdAt : 0;
  const size = typeof b.size === "number" && Number.isFinite(b.size) ? Math.min(3, Math.max(0.5, b.size)) : 1;
  return {
    id,
    host,
    name: text(b.name, MAX_NAME).trim() || "My Boost",
    enabled: b.enabled !== false,
    createdAt: at,
    updatedAt: typeof b.updatedAt === "number" && Number.isFinite(b.updatedAt) ? b.updatedAt : at,
    color: normalizeColor(b.color),
    invert: b.invert === true,
    font: cleanFont(b.font),
    size,
    textCase: BOOST_CASES.includes(b.textCase as BoostTextCase) ? (b.textCase as BoostTextCase) : "none",
    zaps: selectors(b.zaps),
    focus: selectors(b.focus),
    css: text(b.css, MAX_BOOST_CSS),
  };
}

export function normalizeScript(v: unknown): BoostScript | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Partial<BoostScript>;
  return { code: text(s.code, MAX_BOOST_SCRIPT), enabled: s.enabled === true, privateWindows: s.privateWindows === true };
}

// MARK: Colour

type Rgb = [number, number, number];
type Matrix = [Rgb, Rgb, Rgb];
// sRGB luma (Rec. 709): what a colour's lightness in the tint is taken from.
const LUMA: Rgb = [0.2126, 0.7152, 0.0722];

const rgbOf = (color: string): Rgb => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255) as Rgb;

/** The tint's two ends: a dark colour of the accent's hue and a light one of the small dot's. */
export function tintEnds(c: BoostColor): { dark: string; light: string } {
  const [h, s] = hslOf(c.accent);
  const sat = Math.max(0.35, s);
  return {
    dark: hexFromHsl(h, sat, 0.1 + 0.22 * c.brightness),
    light: hexFromHsl((h + c.spread / 360) % 1, sat * 0.85, 0.84 + 0.13 * c.brightness),
  };
}

/**
 * The tint as an affine map of sRGB colours, as Zen's duotone does it per colour: a colour's lightness picks a point
 * between the dark end and the light end, some of its own colour is added back, and the result is mixed in by the
 * contrast. Linear, so one feColorMatrix applies it to the page, and its inverse, where there is one, gives images
 * their own colours back.
 */
export function tintMatrix(c: BoostColor): { m: Matrix; b: Rgb } {
  const { dark, light } = tintEnds(c);
  const D = rgbOf(dark);
  const L = rgbOf(light);
  const k = 0.2 + 0.75 * c.contrast;
  const keep = c.saturation;
  const m = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => {
      const identity = i === j ? 1 : 0;
      const tint = (L[i]! - D[i]!) * LUMA[j]! + keep * (identity - LUMA[j]!);
      return (1 - k) * identity + k * tint;
    }),
  ) as Matrix;
  const b = D.map((d) => k * d) as Rgb;
  return { m, b };
}

/** The inverse map (x = M⁻¹(y − b)); null when it's too close to having none for images to come back well. */
export function invertTint({ m, b }: { m: Matrix; b: Rgb }): { m: Matrix; b: Rgb } | null {
  const [[a, bb, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 0.02) return null;
  const inv: Matrix = [
    [(e * i - f * h) / det, (c * h - bb * i) / det, (bb * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (bb * g - a * h) / det, (a * e - bb * d) / det],
  ];
  const offset = inv.map((row) => -(row[0] * b[0] + row[1] * b[1] + row[2] * b[2])) as Rgb;
  return { m: inv, b: offset };
}

const num = (v: number) => (Math.abs(v) < 5e-5 ? "0" : v.toFixed(4).replace(/\.?0+$/, ""));
const matrixValues = ({ m, b }: { m: Matrix; b: Rgb }) => [...m.map((row, i) => [...row.map(num), "0", num(b[i]!)].join(" ")), "0 0 0 1 0"].join(" ");

// What a tinted page gives its own colours back to (the inverse filter): pictures and video, not the page's colours,
// and Boosts' own picker over the page. The inverse can't give back what the tint clipped: under a strong tint, very
// saturated colours in pictures come back a little paler. A page whose CSP doesn't allow data: images doesn't load the
// filter at all and keeps its colours.
const MEDIA = "img, video, canvas, embed, object, iframe, bay-boost-picker, bay-boost-preview";

/** The colour rules: the page through the tint, its pictures through the inverse. */
export function colorCss(c: BoostColor): string {
  const tint = tintMatrix(c);
  const back = invertTint(tint);
  const filter = (id: string, values: string) =>
    `<filter id="${id}" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%"><feColorMatrix type="matrix" values="${values}"/></filter>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg">${filter("t", matrixValues(tint))}${back ? filter("u", matrixValues(back)) : ""}</svg>`;
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  // The root keeps a background, or a page without one would tint the window's own colour, not white.
  let css = `html { filter: url("${url}#t") !important; }\nhtml:not([style*="background"]) { background-color: Canvas; }\n`;
  if (back) css += `:is(${MEDIA}) { filter: url("${url}#u") !important; }\n`;
  return css;
}

/** The tab's own colour, for a Boost that follows the space's (Zen's magic theme): the space's first colour leads. */
export function themedColor(c: BoostColor, spaceColors: string[]): BoostColor {
  const accent = spaceColors.find(isHex)?.toUpperCase();
  if (!accent) return c;
  const second = spaceColors.slice(1).find(isHex);
  const spread = second ? Math.round(((hslOf(second)[0] - hslOf(accent)[0] + 1) % 1) * 360) : c.spread;
  return { ...c, accent, spread };
}

// MARK: Sheets

// Icon fonts and code keep their faces when a Boost changes the font.
const KEEP_FONT =
  'i, code, pre, kbd, samp, tt, var, svg, svg *, mat-icon, [class*="icon" i], [class*="symbol" i], [class^="fa-"], [class*=" fa-"], .fa, .fas, .far, .fab, .material-icons, .google-material-icons, .google-symbols';
const KEEP_CASE = "input, textarea, code, pre, kbd, samp";

/**
 * A Boost's user-origin sheet (its !important rules beat the page's): zaps, focus, font, case, size and colours.
 * `colors: false` leaves the colour rules out (a Boost following its space's colours has them in each tab's sheet).
 */
export function boostUserCss(b: Boost, colors = true): string {
  const parts: string[] = [];
  // Hidden unless the editor is showing it for a moment (data-bay-unzap, while its row is hovered).
  for (const sel of b.zaps) parts.push(`:is(${sel}):not([data-bay-unzap]) { display: none !important; }`);
  if (b.focus.length) parts.push(focusCss(b.focus));
  if (b.font) parts.push(`body *:not(${KEEP_FONT}) { font-family: "${b.font}", ${genericFamily(b.font)} !important; }`);
  if (b.textCase !== "none") parts.push(`body *:not(${KEEP_CASE}) { text-transform: ${b.textCase} !important; }`);
  if (b.size !== 1) parts.push(`html { zoom: ${num(b.size)} !important; }`);
  if (colors && b.color && !b.color.theme) parts.push(colorCss(b.color));
  return parts.join("\n");
}

// The generic family after a font, for pages where it's missing.
function genericFamily(font: string): string {
  if (/mono|menlo|courier|consol/i.test(font)) return "monospace";
  if (/new york|georgia|times|charter|serif|garamond|baskerville/i.test(font)) return "serif";
  return "sans-serif";
}

// Zen's Focus (src/zen/boosts/ZenBoostStyles.sys.mjs, MPL-2.0): what's kept is centred alone, its ancestors' boxes
// dissolve (display: contents) and everything else is hidden. Selectors in :is() are forgiving: one that doesn't parse
// drops out alone.
function focusCss(focus: string[]): string {
  const f = `:is(${focus.join(", ")})`;
  return [
    `${f} { max-width: 70vw !important; width: 100% !important; }`,
    `html:has(${f}) { overflow: auto !important; height: auto !important; }`,
    `html:has(${f}) body { display: flex !important; flex-direction: column !important; align-items: safe center !important; justify-content: safe center !important; box-sizing: border-box !important; min-height: 100vh !important; height: auto !important; overflow: visible !important; margin: 0 !important; padding: 48px 0 !important; }`,
    `html:has(${f}) body *:has(${f}) { display: contents !important; }`,
    `html:has(${f}) body *:not(${f}, ${f} *, :has(${f})) { display: none !important; }`,
  ].join("\n");
}

/** The engine's list: one entry a Boost that's on, in the order made (later ones win). Empty when Boosts are off. */
export function engineBoosts(boosts: Boost[], scripts: Record<string, BoostScript>, on: boolean): EngineBoost[] {
  if (!on) return [];
  return boosts
    .filter((b) => b.enabled)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((b) => {
      const script = scripts[b.id];
      const code = script?.enabled ? script.code.trim() : "";
      return {
        host: b.host,
        // Colours are resolved per tab in Boost order, using its space and the actual document host.
        userCss: boostUserCss(b, false),
        css: b.css,
        // Its own function, so one Boost's names never collide with another's in the shared world.
        script: code ? `(function () {\n${code}\n})();` : "",
        scriptInPrivate: !!code && !!script?.privateWindows,
        invert: b.invert,
      };
    });
}

// MARK: The tab's sheet

/** A tab's palette: its space's colours available to Boost CSS as --bay-palette-* variables. */
export type BoostPalette = {
  background: string;
  backgroundExtra: string;
  foreground: string;
  foregroundSecondary: string;
  foregroundTertiary: string;
  accent: string;
  hover: string;
  colors: string[];
};

/**
 * The tab's palette as --bay-palette-* variables.
 */
export function tabBoostCss(palette: BoostPalette): string {
  const vars: [string, string][] = [
    ["background", palette.background],
    ["background-extra", palette.backgroundExtra],
    ["foreground", palette.foreground],
    ["foreground-secondary", palette.foregroundSecondary],
    ["foreground-tertiary", palette.foregroundTertiary],
    ["accent", palette.accent],
    ["hover", palette.hover],
  ];
  const lines = [...vars.map(([k, v]) => `--bay-palette-${k}: ${v};`), ...palette.colors.map((c, i) => `--bay-palette-color${i}: ${c};`)];
  return `:root {\n  ${lines.join("\n  ")}\n}\n`;
}

/** Every destination's final colour is ready before navigation, including sites the tab has not visited yet. */
export function tabBoostStyle(palette: BoostPalette, boosts: Boost[], on: boolean): EngineBoostStyle {
  const winners = new Map<string, BoostColor>();
  if (on) {
    for (const boost of [...boosts].filter((b) => b.enabled).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
      if (boost.color) winners.set(boost.host, boost.color);
    }
  }
  return {
    palette: tabBoostCss(palette),
    sites: Object.fromEntries([...winners].map(([host, color]) => [host, colorCss(color.theme ? themedColor(color, palette.colors) : color)])),
  };
}

// MARK: Shuffle, import and export

/** Zen's "Shuffle Vibes": a random tint and font, the rest as it was. `random` returns 0–1. */
export function shuffledBoost(b: Boost, random: () => number = Math.random): Boost {
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length) % list.length]!;
  const accent = hexFromHsl(random(), 0.55 + 0.35 * random(), 0.35 + 0.3 * random());
  return {
    ...b,
    color: {
      accent: accent.toUpperCase(),
      spread: pick([0, 30, 40, 60, 150, 180, 210]),
      contrast: 0.35 + 0.5 * random(),
      brightness: 0.25 + 0.6 * random(),
      saturation: 0.15 + 0.5 * random(),
      theme: false,
    },
    font: pick(["", ...BOOST_FONTS]),
  };
}

/** A Boost as a file: its settings, no id, and its script only if asked (scripts aren't shared by default). */
export function exportBoost(b: Boost, script?: BoostScript): string {
  const { id: _id, enabled: _enabled, createdAt: _c, updatedAt: _u, ...settings } = b;
  return JSON.stringify({ bay: "boost", version: 1, ...settings, ...(script?.code ? { script: script.code } : {}) }, null, 2);
}

/**
 * A Boost from a file: Bay's own (exportBoost) or Zen's export (its boostData). Its script comes back separately and
 * off. `host` is used when the file names none (Zen's don't).
 */
export function importBoost(json: string, id: string, host: string, at: number): { boost: Boost; script: string } | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.bay === "boost") {
    const boost = normalizeBoost({ ...d, id, host: typeof d.host === "string" && d.host ? d.host : host, createdAt: at, updatedAt: at, enabled: true });
    return boost ? { boost, script: text(d.script, MAX_BOOST_SCRIPT) } : null;
  }
  // Zen's: { boostName, dotAngleDeg, brightness, saturation, contrast, fontFamily, enableColorBoost, smartInvert,
  // textCaseOverride, sizeOverride, zapSelectors, focusSelectors, customCSS, … }.
  if ("boostName" in d || "zapSelectors" in d || "customCSS" in d) {
    const angle = typeof d.dotAngleDeg === "number" ? d.dotAngleDeg : 0;
    const color: BoostColor | null =
      d.enableColorBoost === true
        ? {
            accent: hexFromHsl((((angle % 360) + 360) % 360) / 360, 0.7, 0.45).toUpperCase(),
            spread: typeof d.secondaryDotAngleDegDelta === "number" ? d.secondaryDotAngleDegDelta : DEFAULT_BOOST_COLOR.spread,
            contrast: clamp01(d.contrast, DEFAULT_BOOST_COLOR.contrast),
            brightness: clamp01(d.brightness, DEFAULT_BOOST_COLOR.brightness),
            saturation: 1 - clamp01(d.saturation, 0.5),
            theme: d.autoTheme === true,
          }
        : null;
    const textCase =
      d.textCaseOverride === "uppercase" || d.textCaseOverride === "lowercase" || d.textCaseOverride === "capitalize" ? d.textCaseOverride : "none";
    const boost = normalizeBoost({
      id,
      host,
      name: d.boostName,
      enabled: true,
      createdAt: at,
      updatedAt: at,
      color,
      invert: d.smartInvert === true,
      font: d.fontFamily,
      size: d.sizeOverride,
      textCase,
      zaps: d.zapSelectors,
      focus: d.focusSelectors,
      css: d.customCSS,
    });
    return boost ? { boost, script: "" } : null;
  }
  return null;
}
