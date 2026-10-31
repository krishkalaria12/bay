import "@fontsource/caveat/600.css";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { continueRender, delayRender, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

// The site's look (apps/web/src/styles/global.css): light paper, ink, highlighter notes, the handwriting's pen.
export const C = {
  paper: "#edeef1",
  ink: "#1c1e23",
  muted: "#5c616d",
  faint: "#8b909b",
  line: "#dfe1e6",
  yellow: "#ffd84d",
  pink: "#ffb3c8",
  green: "#b8e6a0",
  blue: "#a8d5fb",
  pen: "#1f5fe0",
};
export const SANS = '"SF Pro Display", system-ui, -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif';
export const MONO = '"SF Mono", ui-monospace, Menlo, monospace';
export const HAND = '"Caveat", "Bradley Hand", cursive';

/** Holds the render until the handwriting's font is in. */
export function useFonts() {
  const [handle] = useState(() => delayRender("Caveat"));
  useEffect(() => {
    document.fonts.load('600 40px "Caveat"').then(
      () => continueRender(handle),
      () => continueRender(handle),
    );
  }, [handle]);
}

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// The edit is timed in 30ths of a second ("beats"), whatever the render's frame rate: at 60 fps a beat is two frames.
export const BEAT = 30;
export const toFrames = (beats: number, fps: number) => Math.round((beats * fps) / BEAT);

/** The scene's time in beats (fractional at higher frame rates, so motion stays smooth). */
export function useBeat() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (frame * BEAT) / fps;
}
export const ARRIVE = Easing.bezier(0.2, 0.8, 0.2, 1);

/** 0 → 1 as a scene's frame passes `from`, over `len` frames, with the site's arrive curve. */
export function useIn(from: number, len = 18) {
  const frame = useBeat();
  return interpolate(frame, [from, from + len], [0, 1], { ...clamp, easing: ARRIVE });
}

/** A spring that starts at `from`. */
export function useSpring(from: number, config: Parameters<typeof spring>[0]["config"] = { damping: 14, mass: 0.8 }) {
  const frame = useBeat();
  return spring({ frame: frame - from, fps: BEAT, config });
}

/** The scene's opacity: in over its first frames, out over its last. */
export function useSceneFade(inLen = 10, outLen = 10) {
  const frame = useBeat();
  const { durationInFrames, fps } = useVideoConfig();
  const len = (durationInFrames * BEAT) / fps;
  return interpolate(frame, [0, inLen, len - outLen, len], [0, 1, 1, 0], clamp);
}

export function Paper({ children }: { children: ReactNode }) {
  return (
    <div style={{ position: "absolute", inset: 0, background: C.paper, fontFamily: SANS, color: C.ink, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse 70% 55% at 50% 0%, rgba(255,255,255,0.85), rgba(255,255,255,0) 70%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse 90% 60% at 50% 110%, rgba(28,30,35,0.07), rgba(28,30,35,0) 70%)",
        }}
      />
      {children}
    </div>
  );
}

/** A highlighter stroke behind a word, a touch crooked, drawn left to right. */
export function Marker({ children, color = C.yellow, progress }: { children: ReactNode; color?: string; progress: number }) {
  return (
    <span style={{ position: "relative", whiteSpace: "nowrap", isolation: "isolate", display: "inline-block", margin: "0 0.08em" }}>
      <span
        style={{
          position: "absolute",
          zIndex: -1,
          left: "-0.06em",
          right: "-0.06em",
          bottom: "0.04em",
          height: "0.36em",
          background: color,
          borderRadius: "0.08em",
          transform: `rotate(-0.6deg) scaleX(${progress})`,
          transformOrigin: "left center",
        }}
      />
      {children}
    </span>
  );
}

export function Keycap({ children, pressed = 0 }: { children: ReactNode; pressed?: number }) {
  return (
    <span
      style={{
        display: "inline-grid",
        placeItems: "center",
        minWidth: "1.5em",
        height: "1.5em",
        padding: "0 0.32em",
        borderRadius: "0.32em",
        background: "#fff",
        border: `1px solid ${C.line}`,
        borderBottomWidth: `${3 - pressed * 2}px`,
        boxShadow: "0 6px 14px -8px rgba(28,30,35,0.35)",
        fontSize: "0.62em",
        fontWeight: 600,
        color: C.ink,
        transform: `translateY(${pressed * 2}px)`,
        verticalAlign: "0.18em",
        marginLeft: "0.22em",
        letterSpacing: 0,
      }}
    >
      {children}
    </span>
  );
}

/** A sticky note, slightly crooked, as on a real desk. */
export function Sticky({ children, color = C.yellow, tilt = -3, style }: { children: ReactNode; color?: string; tilt?: number; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: color,
        fontFamily: HAND,
        fontWeight: 600,
        color: C.ink,
        padding: "22px 26px 26px",
        boxShadow: "0 18px 30px -14px rgba(40,30,0,0.4), 0 2px 4px rgba(0,0,0,0.06)",
        transform: `rotate(${tilt}deg)`,
        lineHeight: 1.1,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** The caption under a scene: bold, tight, the site's headline type, rising in after `delay`. */
export function Caption({ children, delay = 8 }: { children: ReactNode; delay?: number }) {
  const t = useIn(delay, 20);
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 64,
        textAlign: "center",
        fontSize: 58,
        fontWeight: 700,
        letterSpacing: "-0.035em",
        lineHeight: 1.05,
        opacity: t,
        transform: `translateY(${(1 - t) * 18}px)`,
      }}
    >
      {children}
    </div>
  );
}

/** A window on the paper: rounded, with the site's soft shadow, its contents clipped. */
export function Frame({ children, style }: { children: ReactNode; style: CSSProperties }) {
  return (
    <div
      style={{
        position: "absolute",
        borderRadius: 18,
        overflow: "hidden",
        background: "#1d1f24",
        boxShadow: "0 50px 90px -40px rgba(20,24,40,0.55), 0 18px 36px -24px rgba(20,24,40,0.35), 0 0 0 1px rgba(0,0,0,0.08)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Pointer({ x, y, pressed = 0 }: { x: number; y: number; pressed?: number }) {
  return (
    <svg
      width={30}
      height={30}
      viewBox="0 0 24 24"
      style={{ position: "absolute", left: x - 6, top: y - 3, transform: `scale(${1 - pressed * 0.12})`, filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.3))" }}
    >
      <path d="M5 2.5v17.2l4.6-4.4 3 6.8 3-1.3-3-6.6h6.3z" fill="#000" stroke="#fff" strokeWidth={1.6} strokeLinejoin="round" />
    </svg>
  );
}
