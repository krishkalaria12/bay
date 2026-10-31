// Uniform values for each effect, from the component props and the effect's clock. Pure, so tests run under Node;
// the timing constants are the Metal views'.

import type { AreaLightProps, EdgeLightProps, PowerUpProps, Rect, WindowBackdropProps } from "../types";
import { color, oklab, palette, type RGBA } from "./colors";
import { grainInputs } from "./grain";
import type { UniformValues } from "./surface";
import { GRAIN_OPACITY, GRAIN_SCALE } from "../constants";

const flat = (colors: RGBA[]) => colors.flat();

export function backdropUniforms(
  { colors, angle = 180, grainOpacity, grainScale }: Pick<WindowBackdropProps, "colors" | "angle" | "grainOpacity" | "grainScale">,
  width: number,
  height: number,
): UniformValues {
  const a = color(colors[0]) ?? [0, 0, 0, 1];
  const b = color(colors[colors.length - 1] ?? colors[0]) ?? a;
  const r = ((Number.isFinite(angle) ? angle : 180) * Math.PI) / 180;
  const grain = grainInputs(grainOpacity, grainScale, { opacity: GRAIN_OPACITY, scale: GRAIN_SCALE });
  return {
    labA: oklab(a),
    labB: oklab(b),
    viewSize: [width, height],
    direction: [Math.sin(r), -Math.cos(r)],
    grainOpacity: grain.opacity,
    grainScale: grain.scale,
  };
}

export const POWER_UP_PALETTES: Record<string, string[]> = {
  pink: ["#FF6AFF", "#FE8097", "#FF9966", "#FCE0FF", "#FA62B1"],
  purple: ["#7293FF", "#7D5DFF", "#E263FF", "#FF81EE", "#A585FF"],
  red: ["#FD3131", "#FA607C", "#FDA733", "#FFEBC9", "#F55F5D"],
  orange: ["#FFBB62", "#FE8026", "#FF7C5F", "#FFFCBE", "#FF9D00"],
  yellow: ["#FFD11A", "#FFE23E", "#FFA144", "#F8FFB5", "#FFE30A"],
  green: ["#90CE01", "#43CC60", "#0CD9EB", "#C3EEAF", "#9EDD73"],
  blue: ["#4ACCFF", "#5FADFF", "#60F0CF", "#9CEEFF", "#72C1FF"],
  default: ["#7E1731", "#334CB4", "#2D81FF", "#2D81FF", "#FFF268", "#F70305", "#FE64CD"],
};

/** Dia: the band runs 3.75 s and the halo 2 s of view time, whatever the speed; each then holds its last frame. */
export const POWER_UP_FINISH = 3.75;
export const HALO_FINISH = 2;
/** The halo's view is the halo frame grown by this on every side. */
export const HALO_INSET = 50;

export function powerUpUniforms({ palette: p = "pink", speed = 1.25, origin = 0.5 }: PowerUpProps, time: number): UniformValues {
  const colors = palette(p, POWER_UP_PALETTES, "pink");
  return {
    direction: 0,
    numberOfColors: colors.length,
    colors: flat(colors.map(oklab)),
    time,
    speed,
    delay: 0,
    fadeOutStart: 1,
    fadeOutDuration: 2,
    origin,
  };
}

export function haloUniforms(
  { palette: p = "pink", speed = 1.25, cornerRadius = 20 }: PowerUpProps,
  time: number,
  size: [number, number],
  dark: boolean,
): UniformValues {
  const [first, second = first] = palette(p, POWER_UP_PALETTES, "pink");
  return {
    resolution: size,
    direction: 0,
    colors: [...first!, ...second!],
    isDark: dark ? 1 : 0,
    time,
    speed,
    delay: 0.18,
    fadeOutStart: 1,
    fadeOutDuration: 0.2,
    inset: HALO_INSET,
    cornerRadius: cornerRadius + 2,
  };
}

export const AREA_LIGHT_PALETTES: Record<string, string[]> = {
  blue: ["#4691C3", "#4BA5B9", "#418CBE", "#48B6DA", "#55A2E4"],
  red: ["#C1575C", "#C35F4B", "#B95058", "#DB463C", "#E16070"],
  pink: ["#D37B8B", "#C387A0", "#C3738C", "#D27DA8", "#E37C94"],
  orange: ["#D87249", "#D08C64", "#D26941", "#DA965A", "#DE7034"],
  yellow: ["#E3AC38", "#F0BE55", "#EBB441", "#EEBB26", "#F3C93B"],
  green: ["#3EB489", "#73B982", "#4BAA82", "#84C978", "#45BE74"],
  purple: ["#7873AF", "#8C69AF", "#7D78B4", "#877ECB", "#856BD0"],
};

/** The light's whole run, after which it holds a still frame. */
export const AREA_LIGHT_DURATION = 60;

const smooth = (x: number) => {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
};

/** AreaLightView.encode: `time` is the light's clock in seconds, `key` whether its window is focused. */
export function areaLightUniforms(
  props: AreaLightProps,
  noiseSeed: number,
  time: number,
  key: boolean,
  dark: boolean,
  width: number,
  height: number,
): UniformValues {
  const {
    source,
    cornerRadius = 22,
    lift: liftProp = 10,
    intensity: intensityProp = 4,
    falloff = 1,
    tilt = [5, 0],
    introDelay = 0.05,
    introDuration = 0.4,
  } = props;
  const colors = palette(props.palette ?? "pink", AREA_LIGHT_PALETTES, "pink");
  const A = AREA_LIGHT_DURATION;
  const T = time;
  const k = key ? 1 : 0.5;
  const e = Math.max(T - introDelay, 0);
  let progress = 1,
    introFade = 1;
  if (introDuration > 0) {
    const t = Math.min(Math.max(e / introDuration, 0), 1);
    const u = 1 - (1 + 3 * t) * Math.exp(-3 * t);
    progress = u * u * (3 - 2 * u) - 0.25 * (1 - t) * Math.sin(Math.PI * t);
    introFade = smooth(Math.min(e / (0.25 * introDuration), 1));
  }
  const lift = 3 + (k * liftProp - 3) * progress;
  let effectiveTime = T;
  if (T > 0.75 * A) {
    const x = Math.min((T - 0.75 * A) / (0.25 * A), 1);
    effectiveTime = 0.75 * A + 0.25 * A * (x - x * x * x + 0.5 * x * x * x * x);
  }
  // Dia: 6 s cycle, 2.19 s peak.
  const phase = (T % 6) / 6;
  const sigma = phase < 0.365 ? 0.15 : 0.3;
  const breath = Math.exp(-((phase - 0.365) ** 2) / (2 * sigma * sigma));
  const fadeOut = 1 - smooth(Math.min(Math.max((T / A - 0.75) * 4, 0), 1));
  const intensity = intensityProp * introFade * (1 + 0.5 * breath * fadeOut);
  const a = (progress * k * tilt[0] * Math.PI) / 180;
  const b = (progress * k * tilt[1] * Math.PI) / 180;
  const frame = validRect(source);
  return {
    shapeFrame: frame ? [frame.x, frame.y, frame.width, frame.height] : [0, 0, 0, 0],
    rotationTrig: [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)],
    viewSize: [width, height],
    cornerRadius,
    falloff,
    noiseSeed,
    lift: Math.max(lift, 0.001),
    time: effectiveTime,
    intensity,
    numberOfColors: colors.length,
    lightMode: dark ? 0 : 1,
    colors: flat(colors),
  };
}

export function edgeLightUniforms(props: EdgeLightProps, time: number, width: number, height: number): UniformValues {
  const { rectFrame, cornerRadius = 20, lightStart, lightEnd, lightColor, logoFrame, animationDuration = 1, animationDelay = 0 } = props;
  const rect = validRect(rectFrame);
  const logo = validRect(logoFrame);
  return {
    resolution: [width, height],
    time,
    animationDuration,
    animationDelay,
    rectFrame: rect ? [rect.x, rect.y, rect.width, rect.height] : [0, 0, 0, 0],
    cornerRadius,
    lightStart: [lightStart.x, lightStart.y],
    lightEnd: [lightEnd.x, lightEnd.y],
    lightColor: (lightColor && color(lightColor)) || [1, 1, 1, 0.5],
    diaLogoFrame: logo ? [logo.x, logo.y, logo.width, logo.height] : [0, 0, 0, 0],
  };
}

/** A rect worth drawing: finite, with area. */
export function validRect(r: Rect | null | undefined): Rect | null {
  return r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0 ? r : null;
}
