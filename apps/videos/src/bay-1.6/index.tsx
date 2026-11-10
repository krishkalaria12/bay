import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Audio, Img, interpolate, OffthreadVideo, Series, staticFile, useVideoConfig } from "remotion";
import {
  C,
  Caption,
  clamp,
  Frame,
  HAND,
  Keycap,
  Marker,
  Paper,
  Pointer,
  Sticky,
  toFrames,
  useBeat,
  useFonts,
  useIn,
  useSceneFade,
  useSpring,
} from "../bay-1.5.4/ui";
import { PERFORMANCE_LEN, PerformanceScene } from "./performance";

// "What's new in Bay 1.6": the release's features, recorded in Bay Dev (public/clips-1.6), on the site's paper.

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// The recordings (2848 × 1602, the window at 2x) fill a 16:9 window on the paper, above the caption.
const STAGE: CSSProperties = { left: 240, top: 64, width: 1440, height: 810 };

// Window points to stage pixels.
const PT = 1440 / 1424;

/**
 * A recording from `from` seconds, at `rate`, with an optional camera move from frame `at`: it zooms to `scale`, bringing
 * the recording's point (x, y) (fractions of it) to (toX, toY) of the window, kept inside the recording's edges.
 * `children` are drawn over the recording in stage pixels and move with the camera.
 */
type Zoom = { at: number; len: number; scale: number; x: number; y: number; toX: number; toY: number };

function Clip({ name, from, rate = 1, zoom, children }: { name: string; from: number; rate?: number; zoom?: Zoom; children?: ReactNode }) {
  const frame = useBeat();
  const { fps } = useVideoConfig();
  const p = zoom ? interpolate(frame, [zoom.at, zoom.at + zoom.len], [0, 1], { ...clamp, easing: easeInOut }) : 0;
  const s = zoom ? 1 + (zoom.scale - 1) * p : 1;
  const edge = (to: number, at: number) => Math.min(0, Math.max(1 - s, to - s * at));
  const tx = zoom ? edge(zoom.toX, zoom.x) * 100 : 0;
  const ty = zoom ? edge(zoom.toY, zoom.y) * 100 : 0;

  return (
    <div style={{ position: "absolute", inset: 0, transform: `translate(${tx}%, ${ty}%) scale(${s})`, transformOrigin: "0 0" }}>
      <OffthreadVideo
        src={staticFile(`clips-1.6/${name}.mp4`)}
        trimBefore={Math.round(from * fps)}
        playbackRate={rate}
        muted
        style={{ width: "100%", height: "100%" }}
      />
      {children}
    </div>
  );
}

/** A recorded scene: the window rises onto the paper, the caption follows. */
function ClipScene({ children, caption, extra }: { children: ReactNode; caption: ReactNode; extra?: ReactNode }) {
  const fade = useSceneFade();
  const rise = useIn(0, 22);

  return (
    <Paper>
      <AbsoluteFill style={{ opacity: fade }}>
        <Frame style={{ ...STAGE, transform: `translateY(${(1 - rise) * 40}px) scale(${0.97 + rise * 0.03})` }}>{children}</Frame>
        {extra}
        {caption}
      </AbsoluteFill>
    </Paper>
  );
}

/** The pointer gliding in from (x0, y0) to (x, y) in stage pixels and clicking at frame `click`. */
function Click({ x, y, x0, y0, click }: { x: number; y: number; x0: number; y0: number; click: number }) {
  const frame = useBeat();
  const t = interpolate(frame, [click - 22, click - 2], [0, 1], { ...clamp, easing: easeOut });
  const pressed = interpolate(frame, [click - 2, click, click + 5], [0, 1, 0], clamp);
  const show = interpolate(frame, [click - 24, click - 18, click + 30, click + 40], [0, 1, 1, 0], clamp);

  return (
    <div style={{ opacity: show }}>
      <Pointer x={x0 + (x - x0) * t} y={y0 + (y - y0) * t} pressed={pressed} />
    </div>
  );
}

/** A sticky note that springs in at `at`. */
function Note({
  at,
  left,
  top,
  tilt = -3,
  color,
  width = 330,
  children,
}: {
  at: number;
  left: number;
  top: number;
  tilt?: number;
  color?: string;
  width?: number;
  children: ReactNode;
}) {
  const pop = useSpring(at, { damping: 12, mass: 0.8 });

  return (
    <div style={{ position: "absolute", left, top, transform: `scale(${pop})`, transformOrigin: "left bottom" }}>
      <Sticky tilt={tilt} color={color} style={{ width, fontSize: 40 }}>
        {children}
      </Sticky>
    </div>
  );
}

// MARK: Intro and end card

function Intro() {
  const fade = useSceneFade(1, 12);
  const icon = useSpring(2);
  const title = useIn(8, 22);
  const mark = useIn(22, 16);
  const sub = useIn(28, 20);

  return (
    <Paper>
      <AbsoluteFill style={{ opacity: fade, alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
        <Img
          src={staticFile("app-icon.png")}
          style={{ width: 150, height: 150, transform: `scale(${icon}) rotate(${(1 - icon) * -8}deg)`, marginBottom: 34 }}
        />
        <div style={{ fontSize: 30, fontWeight: 600, color: C.muted, letterSpacing: "-0.01em", opacity: title, marginBottom: 6 }}>What’s new in</div>
        <div
          style={{ fontSize: 150, fontWeight: 800, letterSpacing: "-0.05em", lineHeight: 1, opacity: title, transform: `translateY(${(1 - title) * 24}px)` }}
        >
          Bay <Marker progress={mark}>1.6</Marker>
        </div>
        <div style={{ fontSize: 34, color: C.muted, marginTop: 30, opacity: sub, transform: `translateY(${(1 - sub) * 12}px)` }}>
          Tidier tabs, named downloads, and a lighter, faster Bay.
        </div>
      </AbsoluteFill>
    </Paper>
  );
}

function EndCard() {
  const fade = useSceneFade(10, 1);
  const icon = useSpring(0);
  const title = useIn(6, 20);
  const pill = useSpring(18, { damping: 12, mass: 0.7 });
  const note = useIn(30, 16);
  const mark = useIn(16, 16);

  return (
    <Paper>
      <AbsoluteFill style={{ opacity: fade, alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 30, opacity: title, transform: `translateY(${(1 - title) * 20}px)` }}>
          <Img src={staticFile("app-icon.png")} style={{ width: 120, height: 120, transform: `scale(${icon})` }} />
          <div style={{ fontSize: 120, fontWeight: 800, letterSpacing: "-0.05em" }}>
            Bay <Marker progress={mark}>1.6</Marker>
          </div>
        </div>
        <div style={{ fontSize: 32, color: C.muted, marginTop: 26, opacity: title }}>Out now. Bay › Check for Updates…, or download it fresh.</div>
        <div
          style={{
            marginTop: 40,
            padding: "18px 34px",
            borderRadius: 16,
            background: C.ink,
            color: "#fff",
            fontSize: 30,
            fontWeight: 600,
            transform: `scale(${pill})`,
            boxShadow: "0 18px 30px -16px rgba(28,30,35,0.6)",
          }}
        >
          bay.krishkalaria.in
        </div>
        <div
          style={{
            position: "absolute",
            right: 360,
            bottom: 300,
            fontFamily: HAND,
            fontWeight: 600,
            fontSize: 46,
            color: C.pen,
            transform: "rotate(-6deg)",
            opacity: note,
          }}
        >
          for your Mac ↙
        </div>
      </AbsoluteFill>
    </Paper>
  );
}

// MARK: Tidy Tabs: the sidebar's Tidy sorts the loose tabs into topics, then ⌘Z puts them back

// The take plays from 0.7 s: Tidy is pressed at 1.2 s (frame 15), the groups land at 3.3 s (frame 78). Then the undo
// take, from 0.6 s: the tabs come back at 1.1 s (15 frames in).
const TIDY_LEN = 159;
const UNDO_LEN = 66;

function TidyScene() {
  const frame = useBeat();
  const { fps } = useVideoConfig();
  const mark = useIn(24, 16);
  // Toward the sidebar, its whole tab list in view: the bottom-left corner stays put.
  const zoom: Zoom = { at: 0, len: 34, scale: 1.2, x: 0, y: 1, toX: 0, toY: 1 };
  const press = interpolate(frame, [TIDY_LEN + 10, TIDY_LEN + 14, TIDY_LEN + 22], [0, 1, 0], clamp);

  return (
    <ClipScene
      extra={
        <>
          <Note at={92} left={1380} top={150} tilt={4}>
            Apple Intelligence,
            <br />
            right on your Mac
          </Note>
          <Note at={TIDY_LEN} left={1380} top={470} tilt={-3} color={C.blue} width={380}>
            <Keycap pressed={press}>⌘</Keycap>
            <Keycap pressed={press}>Z</Keycap> puts them back
          </Note>
        </>
      }
      caption={
        <Caption>
          Tidy sorts your tabs <Marker progress={mark}>by topic</Marker>.
        </Caption>
      }
    >
      <Series>
        <Series.Sequence durationInFrames={toFrames(TIDY_LEN, fps)}>
          <Clip name="tidy" from={0.7} zoom={zoom}>
            <Click x={159.5 * PT} y={293 * PT} x0={420} y0={520} click={14} />
          </Clip>
        </Series.Sequence>
        <Series.Sequence durationInFrames={toFrames(UNDO_LEN, fps)}>
          <Clip name="tidy-undo" from={0.6} zoom={{ ...zoom, at: -100 }} />
        </Series.Sequence>
      </Series>
    </ClipScene>
  );
}

// MARK: Tidy Downloads: a machine-named PDF is renamed as it finishes

function DownloadsScene() {
  const mark = useIn(24, 16);

  return (
    <ClipScene
      extra={
        <Note at={84} left={1400} top={170} tilt={3} width={360}>
          names you gave
          <br />
          files stay as they are
        </Note>
      }
      caption={
        <Caption>
          Downloads get{" "}
          <Marker color={C.green} progress={mark}>
            names you can find
          </Marker>
          .
        </Caption>
      }
    >
      {/* The click is at 1.2 s (frame 18 from 0.6 s); the toast lands at 2.2 s (frame 49). */}
      <Clip name="downloads" from={0.6} zoom={{ at: 50, len: 34, scale: 1.4, x: 0.578, y: 0.92, toX: 0.578, toY: 0.92 }}>
        <Click x={525 * PT} y={518 * PT} x0={820} y0={700} click={18} />
      </Clip>
    </ClipScene>
  );
}

// MARK: Performance: four short drawn acts (performance.tsx)

// MARK: Protected media: Netflix opens in Safari's engine, and Site Controls says why

function NetflixScene() {
  const mark = useIn(24, 16);

  return (
    <ClipScene
      extra={
        <Note at={70} left={1420} top={170} tilt={3} width={300}>
          Bay opens them in Safari’s engine, for the DRM
        </Note>
      }
      caption={
        <Caption>
          Netflix and Disney+{" "}
          <Marker color={C.blue} progress={mark}>
            just play
          </Marker>
          .
        </Caption>
      }
    >
      {/* Site Controls opens at 1.2 s (frame 16 from 0.7 s). */}
      <Clip name="netflix" from={0.7} zoom={{ at: 26, len: 34, scale: 1.75, x: 0.13, y: 0.3, toX: 0.3, toY: 0.42 }} />
    </ClipScene>
  );
}

// MARK: The library in the sidebar

function LibraryScene() {
  const mark = useIn(24, 16);

  return (
    <ClipScene
      caption={
        <Caption>
          Your library opens{" "}
          <Marker color={C.green} progress={mark}>
            in the sidebar
          </Marker>
          .
        </Caption>
      }
    >
      {/* At 1.3x from 0.8 s: Downloads opens at frame 12, Spaces (in columns) at frame 82. */}
      <Clip name="library" from={0.8} rate={1.3} zoom={{ at: 70, len: 40, scale: 1.3, x: 0, y: 0.5, toX: 0, toY: 0.5 }} />
    </ClipScene>
  );
}

// MARK: A space's theme, edited from the sidebar

function ThemeScene() {
  const mark = useIn(24, 16);

  return (
    <ClipScene
      caption={
        <Caption>
          Give a space{" "}
          <Marker color={C.pink} progress={mark}>
            a new look
          </Marker>{" "}
          from the sidebar.
        </Caption>
      }
    >
      {/* At 1.4x from 0.9 s: the editor opens at frame 8, the colours change at 56, 99 and 142. */}
      <Clip name="theme" from={0.9} rate={1.4} zoom={{ at: 6, len: 34, scale: 1.4, x: 0.2, y: 0.62, toX: 0.34, toY: 0.6 }} />
    </ClipScene>
  );
}

// MARK: The smaller things, drawn as a list on a card

const ALSO = [
  "Undo and redo in the search bar",
  "Type a site you have open, and Bay switches to it",
  "A shorter tab menu, with the rest under More",
  "Background tabs sleep sooner on Macs with less memory",
];

function AlsoScene() {
  const frame = useBeat();
  const fade = useSceneFade();
  const card = useIn(0, 22);
  const mark = useIn(14, 16);

  return (
    <Paper>
      <AbsoluteFill style={{ opacity: fade }}>
        <div
          style={{
            position: "absolute",
            left: 460,
            top: 150,
            width: 1000,
            padding: "46px 56px 50px",
            borderRadius: 26,
            background: "#fff",
            boxShadow: "0 50px 90px -50px rgba(20,24,40,0.45), 0 0 0 1px rgba(0,0,0,0.05)",
            opacity: card,
            transform: `translateY(${(1 - card) * 40}px)`,
          }}
        >
          <div style={{ fontSize: 54, fontWeight: 800, letterSpacing: "-0.04em", marginBottom: 26 }}>
            And <Marker progress={mark}>also</Marker>
          </div>
          {ALSO.map((item, i) => {
            const t = interpolate(frame, [18 + i * 9, 34 + i * 9], [0, 1], { ...clamp, easing: easeOut });

            return (
              <div
                key={item}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 22,
                  fontSize: 34,
                  fontWeight: 600,
                  letterSpacing: "-0.02em",
                  padding: "14px 0",
                  borderTop: i ? `1px solid ${C.line}` : "none",
                  opacity: t,
                  transform: `translateX(${(1 - t) * 24}px)`,
                }}
              >
                <span
                  style={{ width: 40, height: 40, borderRadius: 20, background: C.green, display: "grid", placeItems: "center", fontSize: 24, fontWeight: 800 }}
                >
                  ✓
                </span>
                {item}
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </Paper>
  );
}

// MARK: The edit

const SCENES: [ReactNode, number][] = [
  [<Intro />, 84],
  [<TidyScene />, TIDY_LEN + UNDO_LEN],
  [<DownloadsScene />, 150],
  [<PerformanceScene />, PERFORMANCE_LEN],
  [<NetflixScene />, 140],
  [<LibraryScene />, 150],
  [<ThemeScene />, 170],
  [<AlsoScene />, 110],
  [<EndCard />, 100],
];

/** The edit's length in frames at `fps`. */
export const bay16Frames = (fps: number) => SCENES.reduce((n, [, len]) => n + toFrames(len, fps), 0);

export function Bay16() {
  useFonts();
  const { width, fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ background: C.paper }}>
      {/* The score (scripts/music/bay-1.6.py), its swells on these scene changes. */}
      <Audio src={staticFile("music/bay-1.6.wav")} />
      {/* Laid out at 1920 × 1080; any other size scales it whole. */}
      <div style={{ position: "absolute", width: 1920, height: 1080, transform: `scale(${width / 1920})`, transformOrigin: "0 0" }}>
        <Series>
          {SCENES.map(([scene, len], i) => (
            <Series.Sequence key={i} durationInFrames={toFrames(len, fps)}>
              {scene}
            </Series.Sequence>
          ))}
        </Series>
      </div>
    </AbsoluteFill>
  );
}
