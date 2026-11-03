import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Audio, Img, interpolate, OffthreadVideo, Series, staticFile, useVideoConfig } from "remotion";
import {
  BEAT,
  C,
  Caption,
  clamp,
  Frame,
  HAND,
  Keycap,
  Marker,
  MONO,
  Paper,
  Pointer,
  Sticky,
  toFrames,
  useBeat,
  useFonts,
  useIn,
  useSceneFade,
  useSpring,
} from "./ui";

// "What's new in Bay 1.5.4": the release's features, recorded in the app (apps/videos/public/clips), on the site's paper.

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

// The recordings fill a 16:9 window on the paper, above the caption.
const STAGE: CSSProperties = { left: 240, top: 64, width: 1440, height: 810 };

/**
 * A recording from `from` seconds, at `rate`, with an optional camera move from frame `at`: it zooms to `scale`, bringing
 * the recording's point (x, y) (fractions of it) to (toX, toY) of the window, kept inside the recording's edges.
 */
type Zoom = { at: number; len: number; scale: number; x: number; y: number; toX: number; toY: number };
function Clip({ name, from, rate = 1, zoom }: { name: string; from: number; rate?: number; zoom?: Zoom }) {
  const frame = useBeat();
  const { fps } = useVideoConfig();
  const p = zoom ? interpolate(frame, [zoom.at, zoom.at + zoom.len], [0, 1], { ...clamp, easing: easeOut }) : 0;
  const s = zoom ? 1 + (zoom.scale - 1) * p : 1;
  const edge = (to: number, at: number) => Math.min(0, Math.max(1 - s, to - s * at));
  const tx = zoom ? edge(zoom.toX, zoom.x) * 100 : 0;
  const ty = zoom ? edge(zoom.toY, zoom.y) * 100 : 0;
  return (
    <div style={{ position: "absolute", inset: 0, transform: `translate(${tx}%, ${ty}%) scale(${s})`, transformOrigin: "0 0" }}>
      <OffthreadVideo
        src={staticFile(`clips/${name}.mov`)}
        trimBefore={Math.round(from * fps)}
        playbackRate={rate}
        muted
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}

/** A recorded scene: the window rises onto the paper, the caption follows. */
function ClipScene({ children, caption, stage = STAGE, extra }: { children: ReactNode; caption: ReactNode; stage?: CSSProperties; extra?: ReactNode }) {
  const fade = useSceneFade();
  const rise = useIn(0, 22);
  return (
    <Paper>
      <AbsoluteFill style={{ opacity: fade }}>
        <Frame style={{ ...stage, transform: `translateY(${(1 - rise) * 40}px) scale(${0.97 + rise * 0.03})` }}>{children}</Frame>
        {extra}
        {caption}
      </AbsoluteFill>
    </Paper>
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
          Bay <Marker progress={mark}>1.5.4</Marker>
        </div>
        <div style={{ fontSize: 34, color: C.muted, marginTop: 30, opacity: sub, transform: `translateY(${(1 - sub) * 12}px)` }}>
          Your tabs, still in order. A few new tricks.
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
            Bay <Marker progress={mark}>1.5.4</Marker>
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
            transform: `rotate(-6deg)`,
            opacity: note,
          }}
        >
          for your Mac ↙
        </div>
      </AbsoluteFill>
    </Paper>
  );
}

// MARK: The bay command: the recording beside a terminal typing what drove it

const CMD1 = `bay exec 'await newTab("en.wikipedia.org/wiki/Kyoto")'`;
const CMD2 = `bay exec 'await newTab("github.com/krishkalaria12/bay")'`;

function typed(text: string, frame: number, start: number, cps = 34) {
  const n = Math.max(0, Math.min(text.length, Math.floor(((frame - start) / BEAT) * cps)));
  return text.slice(0, n);
}

function Terminal() {
  const frame = useBeat();
  const show = useIn(6, 18);
  // In scene frames (the clip plays at 1.4x from 0.4s): tab one lands at ~34, tab two at ~141.
  const line1 = typed(CMD1, frame, 2, 72);
  const line2 = frame > 104 ? typed(CMD2, frame, 106, 72) : "";
  const caret = Math.floor(frame / 15) % 2 === 0;
  const lines: ReactNode[] = [
    <div key="c" style={{ color: "#7d8492" }}>
      # opens behind the page you’re on
    </div>,
    <div key="1">
      <span style={{ color: "#8fd18b" }}>~ %</span> {line1}
      {frame <= 28 && caret ? "▍" : ""}
    </div>,
  ];
  if (frame > 36)
    lines.push(
      <div key="1o" style={{ color: "#7d8492" }}>
        ✓ Kyoto – Wikipedia
      </div>,
    );
  if (frame > 104)
    lines.push(
      <div key="2">
        <span style={{ color: "#8fd18b" }}>~ %</span> {line2}
        {frame <= 132 && caret ? "▍" : ""}
      </div>,
    );
  if (frame > 146)
    lines.push(
      <div key="2o" style={{ color: "#7d8492" }}>
        ✓ GitHub – krishkalaria12/bay
      </div>,
    );
  return (
    <div
      style={{
        position: "absolute",
        left: 1010,
        top: 470,
        width: 820,
        borderRadius: 16,
        background: "#16181d",
        boxShadow: "0 40px 70px -30px rgba(10,12,20,0.7), 0 0 0 1px rgba(255,255,255,0.06)",
        opacity: show,
        transform: `translateY(${(1 - show) * 30}px)`,
        overflow: "hidden",
      }}
    >
      <div style={{ height: 40, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", background: "#1f2228" }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <span key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />
        ))}
        <span style={{ flex: 1, textAlign: "center", color: "#8b909b", fontSize: 15, fontWeight: 600, marginRight: 52 }}>Terminal — zsh</span>
      </div>
      <div
        style={{ padding: "18px 22px 24px", fontFamily: MONO, fontSize: 20, lineHeight: 1.7, color: "#e8eaee", whiteSpace: "pre-wrap", wordBreak: "break-all" }}
      >
        {lines}
      </div>
    </div>
  );
}

function CliScene() {
  const mark = useIn(26, 16);
  const note = useSpring(118, { damping: 12, mass: 0.8 });
  return (
    <ClipScene
      stage={{ left: 90, top: 70, width: 1260, height: 709 }}
      extra={
        <>
          <Terminal />
          <div style={{ position: "absolute", left: 1450, top: 120, transform: `scale(${note})`, transformOrigin: "left bottom" }}>
            <Sticky tilt={4} style={{ width: 330, fontSize: 40 }}>
              <span style={{ fontFamily: MONO, fontSize: 21, fontWeight: 600 }}>bay skills install</span>
              <br />
              and your coding agents can drive Bay too
            </Sticky>
          </div>
        </>
      }
      caption={
        <Caption>
          Drive Bay from your <Marker progress={mark}>terminal</Marker>.
        </Caption>
      }
    >
      <Clip name="cli" from={0.4} rate={1.4} />
    </ClipScene>
  );
}

// MARK: The rest of the recordings

function PinSplitScene() {
  const mark = useIn(24, 16);
  return (
    <ClipScene
      caption={
        <Caption>
          Pin a{" "}
          <Marker color={C.pink} progress={mark}>
            split view
          </Marker>
          . It stays side by side.
        </Caption>
      }
    >
      <Clip name="pinsplit" from={0.9} rate={1.15} zoom={{ at: 4, len: 40, scale: 1.18, x: 0, y: 0, toX: 0, toY: 0 }} />
    </ClipScene>
  );
}

function SpacesScene() {
  const mark = useIn(24, 16);
  return (
    <ClipScene
      caption={
        <Caption>
          Reorder spaces with{" "}
          <Marker color={C.green} progress={mark}>
            a drag
          </Marker>
          .
        </Caption>
      }
    >
      <Clip name="spaces" from={0.6} rate={1} zoom={{ at: 0, len: 30, scale: 2.6, x: 0.08, y: 0.97, toX: 0.2, toY: 0.88 }} />
    </ClipScene>
  );
}

function ClearScene() {
  const frame = useBeat();
  const mark = useIn(24, 16);
  // ⌘T is pressed ~0.2s into the scene.
  const press = interpolate(frame, [4, 7, 12], [0, 1, 0], clamp);
  return (
    <ClipScene
      caption={
        <Caption>
          <Marker color={C.blue} progress={mark}>
            Clear cookies
          </Marker>{" "}
          and cache from
          <Keycap pressed={press}>⌘</Keycap>
          <Keycap pressed={press}>T</Keycap>
        </Caption>
      }
    >
      <Clip name="clear" from={0.6} rate={1.6} />
    </ClipScene>
  );
}

function PeekScene() {
  const mark = useIn(24, 16);
  return (
    <ClipScene
      caption={
        <Caption>
          Peek{" "}
          <Marker color={C.pink} progress={mark}>
            springs
          </Marker>{" "}
          out of the link, and back in.
        </Caption>
      }
    >
      <Clip name="peek" from={1.3} rate={1.4} />
    </ClipScene>
  );
}

function ImportScene() {
  const frame = useBeat();
  const mark = useIn(20, 16);
  // Return is pressed at 3.2s in the recording (0.8x from 0.9s): ~86 frames in.
  const press = interpolate(frame, [84, 87, 95], [0, 1, 0], clamp);
  return (
    <ClipScene
      caption={
        <Caption>
          Moving in? Drag your{" "}
          <Marker color={C.green} progress={mark}>
            old browser
          </Marker>{" "}
          to Bay, or press
          <Keycap pressed={press}>↩</Keycap>
        </Caption>
      }
    >
      <Clip name="import" from={0.9} rate={0.8} zoom={{ at: 0, len: 110, scale: 1.12, x: 0.5, y: 0.45, toX: 0.5, toY: 0.45 }} />
    </ClipScene>
  );
}

function RightScene() {
  const mark = useIn(24, 16);
  return (
    <ClipScene
      caption={
        <Caption>
          Sidebar on the{" "}
          <Marker color={C.blue} progress={mark}>
            right
          </Marker>
          ? The window buttons move in with it.
        </Caption>
      }
    >
      {/* The sidebar arrives on the right ~2.5s in (1.4x from 3.4s): then the camera goes to its header. */}
      <Clip name="right" from={3.4} rate={1.4} zoom={{ at: 92, len: 34, scale: 2.4, x: 0.9, y: 0.08, toX: 0.75, toY: 0.25 }} />
    </ClipScene>
  );
}

// MARK: Update channels, drawn: a Settings row as the site draws its windows

function ChannelScene() {
  const frame = useBeat();
  const fade = useSceneFade();
  const card = useIn(0, 22);
  const mark = useIn(24, 16);
  const pick = useSpring(44, { damping: 16, mass: 0.6 });
  const knobX = interpolate(pick, [0, 1], [0, 170]);
  // The pointer comes in from the bottom right and clicks Nightly at frame 42.
  const px = interpolate(frame, [8, 40], [1460, 1205], { ...clamp, easing: easeOut });
  const py = interpolate(frame, [8, 40], [760, 449], { ...clamp, easing: easeOut });
  const pressed = interpolate(frame, [40, 43, 48], [0, 1, 0], clamp);
  const note = useIn(56, 18);
  const seg = (label: string, on: boolean) => (
    <div style={{ width: 170, textAlign: "center", fontSize: 24, fontWeight: 600, color: on ? C.ink : C.faint, position: "relative", zIndex: 1 }}>{label}</div>
  );
  return (
    <Paper>
      <AbsoluteFill style={{ opacity: fade }}>
        <div
          style={{
            position: "absolute",
            left: 410,
            top: 200,
            width: 1100,
            padding: "40px 48px",
            borderRadius: 26,
            background: "#fff",
            boxShadow: "0 50px 90px -50px rgba(20,24,40,0.45), 0 0 0 1px rgba(0,0,0,0.05)",
            opacity: card,
            transform: `translateY(${(1 - card) * 40}px)`,
          }}
        >
          <div style={{ fontSize: 22, fontWeight: 700, color: C.faint, textTransform: "uppercase", letterSpacing: "0.06em" }}>Settings › General › Updates</div>
          <div style={{ display: "flex", alignItems: "center", marginTop: 30, gap: 40 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: "-0.02em" }}>Update channel</div>
              <div style={{ fontSize: 24, color: C.muted, marginTop: 8, lineHeight: 1.35 }}>
                Nightly gets each day’s fixes first and is tested less. Switching back to Stable never downgrades.
              </div>
            </div>
            <div style={{ position: "relative", display: "flex", padding: 6, borderRadius: 16, background: "#eceef2", height: 64, alignItems: "center" }}>
              <div
                style={{
                  position: "absolute",
                  left: 6 + knobX,
                  top: 6,
                  width: 170,
                  height: 52,
                  borderRadius: 12,
                  background: "#fff",
                  boxShadow: "0 4px 10px -4px rgba(28,30,35,0.3)",
                }}
              />
              {seg("Stable", pick < 0.5)}
              {seg("Nightly", pick >= 0.5)}
            </div>
          </div>
          <div style={{ height: 1, background: C.line, margin: "34px 0 26px" }} />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 26 }}>
            <span style={{ fontWeight: 600 }}>
              Bay 1.5.4 <span style={{ color: C.faint, fontWeight: 500 }}>· up to date</span>
            </span>
            <span style={{ padding: "10px 20px", borderRadius: 12, border: `1px solid ${C.line}`, fontWeight: 600, fontSize: 22 }}>Check Now</span>
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 1130,
            top: 140,
            fontFamily: HAND,
            fontWeight: 600,
            fontSize: 44,
            color: C.pen,
            transform: "rotate(-5deg)",
            opacity: note,
          }}
        >
          new builds every night
        </div>
        <Pointer x={px} y={py} pressed={pressed} />
        <Caption>
          Stable or <Marker progress={mark}>Nightly</Marker>. Your pick.
        </Caption>
      </AbsoluteFill>
    </Paper>
  );
}

// MARK: The edit

const SCENES: [ReactNode, number][] = [
  [<Intro />, 84],
  [<CliScene />, 186],
  [<PinSplitScene />, 156],
  [<SpacesScene />, 128],
  [<ClearScene />, 172],
  [<ChannelScene />, 96],
  [<PeekScene />, 158],
  [<ImportScene />, 112],
  [<RightScene />, 150],
  [<EndCard />, 100],
];

/** The edit's length in frames at `fps`. */
export const bay154Frames = (fps: number) => SCENES.reduce((n, [, len]) => n + toFrames(len, fps), 0);

export function Bay154() {
  useFonts();
  const { width, fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: C.paper }}>
      {/* The score (scripts/music/bay-1.5.4.py), on the edit's bar grid. */}
      <Audio src={staticFile("music/bay-1.5.4.wav")} />
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
