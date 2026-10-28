// The Windows and Linux entry: the Metal views' contracts drawn with WebGL2, each over a CSS base that stays when
// WebGL2 is off (BAY_WEB_SHADERS), unavailable, failed or lost.

import { capabilities, View } from "@bay/platform";
import { useEffect, useRef, useState } from "react";
import { GRAIN_OPACITY, GRAIN_SCALE } from "./constants";
import type { AreaLightProps, EdgeLightProps, PowerUpProps, WindowBackdropProps } from "./types";
import { adjustLightness, color, css } from "./webgl/colors";
import { AreaGlow, EdgeOutline, GrainLayer, gradientCss } from "./webgl/fallbacks";
import { grainInputs } from "./webgl/grain";
import { drawPowerUp, POWER_UP_SOURCES } from "./webgl/powerUpRenderer";
import { fill, useAnimatedCanvas, useContrast, useFocused, useMedia, webShaders } from "./webgl/ShaderView";
import { areaLight } from "./webgl/shaders/areaLight";
import { backdrop } from "./webgl/shaders/backdrop";
import { edgeLight } from "./webgl/shaders/edgeLight";
import { registerStatic } from "./webgl/staticRenderer";
import {
  AREA_LIGHT_DURATION,
  AREA_LIGHT_PALETTES,
  areaLightUniforms,
  backdropUniforms,
  edgeLightUniforms,
  HALO_FINISH,
  HALO_INSET,
  haloUniforms,
  POWER_UP_FINISH,
  powerUpUniforms,
  validRect,
} from "./webgl/uniforms";
export { DIA_SPECTRUM } from "./constants";
export type { Rect, AreaLightPalette, AreaLightProps, EdgeLightProps, PowerUpProps, WindowBackdropProps } from "./types";

const DARK = "(prefers-color-scheme: dark)";
const AREA_LIGHT_SOURCES = [areaLight];
const EDGE_LIGHT_SOURCES = [edgeLight];
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export function WindowBackdrop({
  colors,
  vibrancy = false,
  angle = 180,
  tintColor,
  tintAlpha = 0,
  tintLightness = 0.25,
  grainOpacity = GRAIN_OPACITY,
  grainScale = GRAIN_SCALE,
  style,
  children,
}: WindowBackdropProps) {
  const contrast = useContrast();
  const dark = useMedia(DARK);
  const grain = grainInputs(contrast.more || contrast.forced ? 0 : grainOpacity, grainScale, { opacity: GRAIN_OPACITY, scale: GRAIN_SCALE });
  const [drawn, setDrawn] = useState(false);
  // A glass window over the system backdrop (Mica) keeps the tint and grain, as macOS keeps them over vibrancy.
  if (vibrancy && capabilities.windowBackdrop) {
    const tint = tintColor ? color(tintColor) : null;
    // WindowTreatmentView: the tint over its lightened self, at the tint's alpha scaled for the appearance.
    const alpha = Math.max(0, Math.min(1, tintAlpha)) * (dark ? 0.5 : 0.75);
    return (
      <View pointerEvents="none" style={[{ overflow: "hidden" }, style]}>
        {tint && alpha > 0 ? (
          <div
            aria-hidden="true"
            style={{ ...fill, background: `linear-gradient(180deg, ${css(tint, alpha)}, ${css(adjustLightness(tint, tintLightness), alpha)})` }}
          />
        ) : null}
        <GrainLayer opacity={grain.opacity} scale={grain.scale} />
        {children}
      </View>
    );
  }
  const from = colors[0],
    to = colors[colors.length - 1] ?? from;
  return (
    <View pointerEvents="none" style={[{ backgroundColor: from, overflow: "hidden" }, style]}>
      {drawn ? null : (
        <>
          <div aria-hidden="true" style={{ ...fill, background: gradientCss(angle, from, to) }} />
          <GrainLayer opacity={grain.opacity} scale={grain.scale} />
        </>
      )}
      {webShaders ? <BackdropCanvas colors={[from, to]} angle={angle} grainOpacity={grain.opacity} grainScale={grain.scale} onDrawn={setDrawn} /> : null}
      {children}
    </View>
  );
}

function BackdropCanvas({
  colors,
  angle,
  grainOpacity,
  grainScale,
  onDrawn,
}: Required<Pick<WindowBackdropProps, "colors" | "angle" | "grainOpacity" | "grainScale">> & { onDrawn(ok: boolean): void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [slot, setSlot] = useState<ReturnType<typeof registerStatic> | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0, dpr: 1 });
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const handle = registerStatic(canvas, (drawn) => {
      setOk(drawn);
      onDrawn(drawn);
    });
    setSlot(handle);
    const measure = () => {
      const r = canvas.getBoundingClientRect();
      setSize((s) =>
        s.width === r.width && s.height === r.height && s.dpr === devicePixelRatio ? s : { width: r.width, height: r.height, dpr: devicePixelRatio },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    let dpr = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    const onDpr = () => {
      dpr.removeEventListener("change", onDpr);
      dpr = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
      dpr.addEventListener("change", onDpr);
      measure();
    };
    dpr.addEventListener("change", onDpr);
    measure();
    return () => {
      observer.disconnect();
      dpr.removeEventListener("change", onDpr);
      handle.dispose();
      onDrawn(false);
    };
  }, [onDrawn]);
  const [from, to] = colors;
  useEffect(() => {
    if (!slot || !(size.width > 0 && size.height > 0)) return;
    slot.update({
      source: backdrop,
      cssWidth: size.width,
      cssHeight: size.height,
      values: (w, h) => backdropUniforms({ colors: [from, to], angle, grainOpacity, grainScale }, w, h),
    });
  }, [slot, size, from, to, angle, grainOpacity, grainScale]);
  return <canvas ref={ref} aria-hidden="true" style={{ ...fill, visibility: ok ? "visible" : "hidden" }} />;
}

export function PowerUp({ style, ...props }: PowerUpProps) {
  const reduced = useMedia(REDUCED_MOTION);
  const { forced } = useContrast();
  const dark = useMedia(DARK);
  const time = useRef({ band: 0, halo: 0 });
  const live = webShaders && !reduced && !forced;
  const haloFrame = validRect(props.halo);
  const { ref, failed } = useAnimatedCanvas(
    live,
    POWER_UP_SOURCES,
    (surface, size, dt) => {
      const t = time.current;
      t.band = Math.min(t.band + dt, POWER_UP_FINISH);
      t.halo = Math.min(t.halo + dt, HALO_FINISH);
      const region = haloFrame && {
        x: haloFrame.x - HALO_INSET,
        y: haloFrame.y - HALO_INSET,
        width: haloFrame.width + 2 * HALO_INSET,
        height: haloFrame.height + 2 * HALO_INSET,
      };
      const ok = drawPowerUp(
        surface,
        size,
        powerUpUniforms(props, t.band),
        region ? { ...region, values: haloUniforms(props, t.halo, [region.width, region.height], dark) } : null,
      );
      return ok && (t.band < POWER_UP_FINISH || (!!region && t.halo < HALO_FINISH));
    },
    JSON.stringify([props.palette, props.speed, props.origin, props.cornerRadius, haloFrame, dark]),
  );
  // Decorative: with reduced motion, forced colours or no GPU there is nothing to show.
  return (
    <View pointerEvents="none" style={style}>
      {live && !failed ? <canvas ref={ref} aria-hidden="true" style={fill} /> : null}
    </View>
  );
}

export function AreaLight({ style, ...props }: AreaLightProps) {
  const reduced = useMedia(REDUCED_MOTION);
  const { forced } = useContrast();
  const dark = useMedia(DARK);
  const focused = useFocused();
  const [noiseSeed] = useState(() => (Number.isFinite(props.noiseSeed) ? props.noiseSeed! : Math.random() * 1000));
  // AreaLightView.replayIntro: focused and moving, from the start; otherwise the still frame at 5 s.
  const clock = useRef({ time: 5, running: false });
  const source = validRect(props.source);
  const live = webShaders && !forced && !!source;
  useEffect(() => {
    // A replay is the mount or a new replayKey only.
    clock.current = focused && !reduced ? { time: 0, running: true } : { time: 5, running: false };
  }, [props.replayKey]);
  useEffect(() => {
    clock.current.running = focused && !reduced;
  }, [focused, reduced]);
  const { ref, failed } = useAnimatedCanvas(
    live,
    AREA_LIGHT_SOURCES,
    (surface, size, dt) => {
      const c = clock.current;
      if (c.running) c.time = Math.min(c.time + dt, AREA_LIGHT_DURATION);
      const values = areaLightUniforms(props, noiseSeed, c.time, focused, dark, size.cssWidth, size.cssHeight);
      surface.gl.disable(surface.gl.BLEND);
      return surface.draw(areaLight, values) && c.running && c.time < AREA_LIGHT_DURATION;
    },
    JSON.stringify([props, focused, reduced, dark]),
  );
  if (forced || !source) return <View pointerEvents="none" style={style} />;
  const first = typeof props.palette === "object" ? props.palette[0] : AREA_LIGHT_PALETTES[props.palette ?? "pink"]?.[0];
  return (
    <View pointerEvents="none" style={[{ opacity: 0.75 }, style]}>
      {live && !failed ? (
        <canvas ref={ref} aria-hidden="true" style={fill} />
      ) : (
        <AreaGlow source={source} colorHex={first ?? "#D37B8B"} cornerRadius={props.cornerRadius ?? 22} />
      )}
    </View>
  );
}

export function EdgeLight({ style, ...props }: EdgeLightProps) {
  const reduced = useMedia(REDUCED_MOTION);
  const { forced } = useContrast();
  const end = (props.animationDelay ?? 0) + (props.animationDuration ?? 1);
  // EdgeLightView.replay: from the start, or settled past the end with reduced motion.
  const time = useRef(reduced ? end + 5 : 0);
  useEffect(() => {
    if (reduced) time.current = Math.max(time.current, end + 5);
  }, [reduced, end]);
  const rect = validRect(props.rectFrame);
  const live = webShaders && !forced && !!rect;
  const { ref, failed } = useAnimatedCanvas(
    live,
    EDGE_LIGHT_SOURCES,
    (surface, size, dt) => {
      if (time.current <= end + 0.1) time.current += dt;
      surface.gl.disable(surface.gl.BLEND);
      return surface.draw(edgeLight, edgeLightUniforms(props, time.current, size.cssWidth, size.cssHeight)) && time.current <= end + 0.1;
    },
    JSON.stringify([props, reduced]),
  );
  if (forced || !rect) return <View pointerEvents="none" style={style} />;
  return (
    <View pointerEvents="none" style={style}>
      {live && !failed ? (
        <canvas ref={ref} aria-hidden="true" style={fill} />
      ) : (
        <EdgeOutline rect={rect} colorHex={props.lightColor} cornerRadius={props.cornerRadius ?? 20} />
      )}
    </View>
  );
}
