import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, interpolate, spring } from "remotion";
import { C, clamp, HAND, Marker, MONO, Paper, useBeat, useSceneFade } from "../bay-1.5.4/ui";

// Bay 1.6's performance, in four short acts on the site's paper: what each number means, drawn rather than listed.
//   1. Memory: uBlock Origin's bar struck out, Bay's own Rust blocker at 29% of it (71% less).
//   2. Idle CPU: two live traces, 1.5.4 busy and 1.6 calm (6.84% → 1.24% just after launch: 5x).
//   3. The sidebar: new tabs arrive; every row flashes (redraws) in 1.5.4, only the new tab in 1.6 (92% less).
//   4. The command bar: typing "lisbon"; every result row redraws per key in 1.5.4, one of six in 1.6 (83% less).
// Measured on an M5 against 1.5.4 (the perf thread's benchmarks), said in a footnote.

const ACTS = [84, 78, 92, 92] as const;
export const PERFORMANCE_LEN = ACTS.reduce((a, b) => a + b, 0);
const STARTS = ACTS.map((_, i) => ACTS.slice(0, i).reduce((a, b) => a + b, 0));
const TABS = ["Memory", "Idle CPU", "Sidebar", "Command bar"];

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const ramp = (t: number, at: number, len: number, easing = easeOut) => interpolate(t, [at, at + len], [0, 1], { ...clamp, easing });
const pop = (t: number, at: number) => spring({ frame: t - at, fps: 30, config: { damping: 11, mass: 0.7 } });
// A stable pseudo-random number in [0, 1) for an index.
const rnd = (i: number) => {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

// MARK: Pen work: the site's hand-drawn circle (components/Circled.astro) and strokes, drawn as they appear. `width` is in
// the viewBox's units: a non-scaling stroke would break the dash that draws the line on.

function Pen({
  d,
  p,
  viewBox,
  style,
  width = 1.5,
  color = C.pen,
}: {
  d: string;
  p: number;
  viewBox: string;
  style: CSSProperties;
  width?: number;
  color?: string;
}) {
  return (
    <svg
      viewBox={viewBox}
      preserveAspectRatio="none"
      fill="none"
      // A round cap draws a dot before the line starts.
      style={{ position: "absolute", overflow: "visible", pointerEvents: "none", opacity: p > 0.001 ? 1 : 0, ...style }}
    >
      <path d={d} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - p} stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const CIRCLE = "M150 9C112 0 42 4 14 22C-6 36 4 62 46 72C88 81 160 77 188 60C206 48 196 22 158 12C140 7 112 6 92 8";

/** Children with the pen's loop drawn round them from `at`. */
function Circled({ t, at, children, pad = 0.18 }: { t: number; at: number; children: ReactNode; pad?: number }) {
  const p = ramp(t, at, 16, (x) => x);
  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      {children}
      <Pen d={CIRCLE} p={p} viewBox="0 0 200 80" style={{ left: `-${pad * 100}%`, top: "-14%", width: `${100 + pad * 200}%`, height: "128%" }} />
    </span>
  );
}

/** A handwritten note in the pen's blue. */
function Hand({
  t,
  at,
  style,
  children,
  size = 42,
  tilt = -3,
}: {
  t: number;
  at: number;
  style: CSSProperties;
  children: ReactNode;
  size?: number;
  tilt?: number;
}) {
  const show = ramp(t, at, 14);
  return (
    <div
      style={{
        position: "absolute",
        fontFamily: HAND,
        fontWeight: 600,
        fontSize: size,
        color: C.pen,
        lineHeight: 1.05,
        transform: `rotate(${tilt}deg) translateY(${(1 - show) * 10}px)`,
        opacity: show,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** The big number of an act: counts up, pops when it lands. */
function Count({
  t,
  at,
  to,
  from = 0,
  prefix = "",
  suffix = "",
  size = 230,
  color,
}: {
  t: number;
  at: number;
  to: number;
  from?: number;
  prefix?: string;
  suffix?: string;
  size?: number;
  color: string;
}) {
  const n = from + (to - from) * ramp(t, at, 30);
  const land = pop(t, at + 30);
  const s = 1 + 0.06 * Math.sin(Math.min(1, land) * Math.PI);
  return (
    <div
      style={{
        fontSize: size,
        fontWeight: 800,
        letterSpacing: "-0.065em",
        lineHeight: 0.9,
        transform: `scale(${s})`,
        transformOrigin: "left center",
        opacity: ramp(t, at - 4, 8),
      }}
    >
      <Marker color={color} progress={ramp(t, at + 26, 14)}>
        {prefix}
        {Math.round(n)}
        {suffix}
      </Marker>
    </div>
  );
}

/** The act's line at the bottom, as the other scenes' captions. */
function Line({ t, children }: { t: number; children: ReactNode }) {
  const show = ramp(t, 10, 20);
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
        opacity: show,
        transform: `translateY(${(1 - show) * 18}px)`,
      }}
    >
      {children}
    </div>
  );
}

const Pill = ({ children, on }: { children: ReactNode; on?: boolean }) => (
  <span
    style={{
      display: "inline-block",
      padding: "8px 18px",
      borderRadius: 999,
      fontSize: 24,
      fontWeight: 700,
      letterSpacing: "-0.01em",
      background: on ? C.green : "#fff",
      color: C.ink,
      boxShadow: "0 10px 22px -14px rgba(20,24,40,0.5), 0 0 0 1px rgba(0,0,0,0.05)",
    }}
  >
    {children}
  </span>
);

// MARK: Act 1, memory

function Memory({ t }: { t: number }) {
  const W = 1010;
  const grow1 = ramp(t, 4, 22);
  const grow2 = ramp(t, 30, 22);
  const strike = ramp(t, 50, 10, (x) => x);
  const bar: CSSProperties = { position: "absolute", left: 0, height: 92, borderRadius: 16 };
  return (
    <>
      <div style={{ position: "absolute", left: 170, top: 250, width: W, height: 470 }}>
        <div style={{ position: "absolute", top: 0, display: "flex", alignItems: "baseline", gap: 16, opacity: ramp(t, 0, 12) }}>
          <span style={{ position: "relative", fontSize: 40, fontWeight: 700, letterSpacing: "-0.03em", color: C.muted }}>
            uBlock Origin
            <Pen d="M0 30 C 60 22, 150 26, 240 18" p={strike} viewBox="0 0 240 40" width={4} style={{ left: -8, top: 6, width: "108%", height: 40 }} />
          </span>
          <span style={{ fontSize: 26, color: C.faint, fontWeight: 600 }}>an extension, in Bay 1.5.4</span>
        </div>
        <div
          style={{
            ...bar,
            top: 64,
            width: W * grow1,
            background: "repeating-linear-gradient(135deg, #cfd2d9 0 12px, #dfe1e6 12px 24px)",
            boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.05)",
          }}
        />
        <div style={{ position: "absolute", top: 250, display: "flex", alignItems: "center", gap: 16, opacity: ramp(t, 26, 12) }}>
          <span style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-0.03em" }}>Bay’s own blocker</span>
          <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, padding: "6px 12px", borderRadius: 10, background: C.ink, color: "#fff" }}>Rust</span>
          <span style={{ fontSize: 26, color: C.faint, fontWeight: 600 }}>built in, Bay 1.6</span>
        </div>
        <div
          style={{
            ...bar,
            top: 314,
            width: W * 0.29 * grow2,
            background: C.green,
            transform: "rotate(-0.5deg)",
            boxShadow: "0 16px 26px -18px rgba(40,90,20,0.6)",
          }}
        />
        {/* The memory it no longer uses: the old bar's outline, dashed, behind the new one. */}
        <div
          style={{
            ...bar,
            top: 314,
            left: W * 0.29,
            width: W * 0.71,
            border: `3px dashed ${C.line}`,
            borderLeft: "none",
            borderRadius: "0 16px 16px 0",
            opacity: ramp(t, 46, 10),
          }}
        />
        <Hand t={t} at={58} size={40} tilt={-2} style={{ left: W * 0.29 + 60, top: 334 }}>
          ← all this, given back to your tabs
        </Hand>
      </div>
      <div style={{ position: "absolute", left: 1300, top: 310 }}>
        <Circled t={t} at={64} pad={0.12}>
          <Count t={t} at={34} to={71} prefix="−" suffix="%" size={200} color={C.green} />
        </Circled>
        <div style={{ fontSize: 46, fontWeight: 800, letterSpacing: "-0.03em", marginTop: 34, opacity: ramp(t, 52, 14) }}>less memory</div>
      </div>
      <Line t={t}>
        The ad blocker uses{" "}
        <Marker color={C.green} progress={ramp(t, 26, 16)}>
          71% less memory
        </Marker>
        .
      </Line>
    </>
  );
}

// MARK: Act 2, idle CPU: two traces scrolling in, as Activity Monitor draws them

const POINTS = 150;
function trace(level: number, spikes: number, seed: number) {
  const d: string[] = [];
  for (let i = 0; i <= POINTS; i++) {
    const r = rnd(i + seed);
    const spike = rnd(i * 7 + seed) < spikes ? 0.55 + rnd(i * 3 + seed) * 0.45 : 0;
    const v = Math.min(1, level * (0.35 + r * 0.65) + spike * level * 1.6);
    d.push(`${i === 0 ? "M" : "L"}${((i / POINTS) * 1000).toFixed(1)} ${(100 - v * 100).toFixed(1)}`);
  }
  return d.join(" ");
}
const BUSY = trace(0.55, 0.16, 11);
const CALM = trace(0.1, 0.03, 53);

function Lane({ t, top, label, sub, d, color, p }: { t: number; top: number; label: string; sub: string; d: string; color: string; p: number }) {
  return (
    <div style={{ position: "absolute", left: 40, right: 40, top, height: 200, opacity: ramp(t, 2, 12) }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
        <span style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em" }}>{label}</span>
        <span style={{ fontSize: 22, fontWeight: 600, color: C.faint }}>{sub}</span>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 48, height: 140, borderRadius: 12, background: "#f6f7f9", overflow: "hidden" }}>
        {[0.25, 0.5, 0.75].map((y) => (
          <div key={y} style={{ position: "absolute", left: 0, right: 0, top: `${y * 100}%`, height: 1, background: C.line }} />
        ))}
        <svg
          viewBox="0 0 1000 100"
          preserveAspectRatio="none"
          style={{ position: "absolute", inset: "10px 0 0 0", width: "100%", height: "calc(100% - 10px)" }}
        >
          <clipPath id={`reveal-${top}`}>
            <rect x={0} y={-10} width={1000 * p} height={130} />
          </clipPath>
          <g clipPath={`url(#reveal-${top})`}>
            <path d={`${d} L1000 100 L0 100 Z`} fill={color} opacity={0.35} />
            <path d={d} fill="none" stroke={color} strokeWidth={2.4} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </g>
        </svg>
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${p * 100}%`, width: 2, background: C.ink, opacity: p > 0 && p < 1 ? 0.35 : 0 }} />
      </div>
    </div>
  );
}

function IdleCpu({ t }: { t: number }) {
  const p = ramp(t, 4, 56, (x) => x);
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 150,
          top: 210,
          width: 1060,
          height: 560,
          borderRadius: 26,
          background: "#fff",
          boxShadow: "0 50px 90px -50px rgba(20,24,40,0.45), 0 0 0 1px rgba(0,0,0,0.05)",
          opacity: ramp(t, 0, 12),
          transform: `translateY(${(1 - ramp(t, 0, 18)) * 30}px)`,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 40,
            top: 30,
            fontSize: 22,
            fontWeight: 700,
            color: C.faint,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          CPU, one tab, idle just after launch
        </div>
        <Lane t={t} top={80} label="Bay 1.5.4" sub="with uBlock Origin" d={BUSY} color={C.pink} p={p} />
        <Lane t={t} top={320} label="Bay 1.6" sub="with Bay’s own blocker" d={CALM} color={C.green} p={p} />
      </div>
      <div style={{ position: "absolute", left: 1320, top: 290 }}>
        <Count t={t} at={30} from={1} to={5} suffix="×" color={C.blue} />
        <div style={{ fontSize: 46, fontWeight: 800, letterSpacing: "-0.03em", marginTop: 34, opacity: ramp(t, 48, 14) }}>calmer at idle</div>
      </div>
      <Hand t={t} at={56} size={44} tilt={-4} style={{ left: 1330, top: 610 }}>
        6.84% → 1.24%
      </Hand>
      <Line t={t}>
        <Marker color={C.blue} progress={ramp(t, 26, 16)}>
          5× less CPU
        </Marker>{" "}
        while Bay sits idle.
      </Line>
    </>
  );
}

// MARK: Acts 3 and 4: redraws made visible. Each flash is a row being drawn again, as React's "highlight updates" shows.

/** A flash that fades over 14 frames after each time in `at` (the last one that has passed). */
function flash(t: number, at: number[]) {
  const last = at.filter((a) => a <= t).pop();
  return last === undefined ? 0 : Math.max(0, 1 - (t - last) / 14);
}

function FlashBox({ v, color }: { v: number; color: string }) {
  if (v <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        inset: 2,
        borderRadius: 10,
        border: `2.5px solid ${color}`,
        background: `${color}33`,
        boxShadow: `0 0 18px ${color}`,
        opacity: v,
      }}
    />
  );
}

/** One version's mock, under its pill, with a handwritten note beneath. */
function Side({ t, left, version, on, note, children }: { t: number; left: number; version: string; on?: boolean; note: string; children: ReactNode }) {
  const show = ramp(t, on ? 6 : 0, 16);
  return (
    <div style={{ position: "absolute", left, top: 150, width: 560, opacity: show, transform: `translateY(${(1 - show) * 30}px)` }}>
      <div style={{ marginBottom: 20 }}>
        <Pill on={on}>{version}</Pill>
      </div>
      {children}
      <Hand t={t} at={30} size={38} tilt={on ? -3 : 2} style={{ left: 10, top: 735 }}>
        {note}
      </Hand>
    </div>
  );
}

// The sidebar: Bay's dark sidebar, new tabs arriving at the top of its list.
const BASE_ROWS = [
  ["#e74c3c", "Time Out Lisbon"],
  ["#1f5fe0", "Lisbon Travel – Lonely Planet"],
  ["#0b3d91", "Jupiter"],
  ["#0b3d91", "Saturn"],
  ["#f4b400", "Inter – Google Fonts"],
  ["#f4b400", "Instrument Serif – Google Fonts"],
  ["#8e5a2b", "Pastéis de nata recipe"],
  ["#0b3d91", "James Webb Space Telescope"],
  ["#f4b400", "Geist – Google Fonts"],
] as const;
const NEW_ROWS = [
  { at: 20, color: "#6c5ce7", title: "Q3 2026 Report" },
  { at: 44, color: "#e50914", title: "Netflix" },
  { at: 68, color: "#f36f21", title: "AccuWeather – Lisbon" },
];
const ROW = 54;

function SidebarMock({ t, everyRow }: { t: number; everyRow: boolean }) {
  const events = NEW_ROWS.map((r) => r.at);
  const rows = [
    ...NEW_ROWS.filter((r) => r.at <= t)
      .reverse()
      .map((r) => ({ key: r.title, color: r.color, title: r.title, grow: ramp(t, r.at, 8), at: r.at })),
    ...BASE_ROWS.map(([color, title]) => ({ key: title, color, title, grow: 1, at: -1 })),
  ];
  let y = 0;
  return (
    <div
      style={{
        position: "relative",
        height: 640,
        borderRadius: 22,
        overflow: "hidden",
        background: "linear-gradient(180deg, #2c3038 0%, #24272d 100%)",
        boxShadow: "0 50px 90px -40px rgba(20,24,40,0.6), 0 0 0 1px rgba(0,0,0,0.1)",
      }}
    >
      <div style={{ display: "flex", gap: 9, padding: "20px 22px" }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <span key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />
        ))}
      </div>
      <div
        style={{
          margin: "0 16px 10px",
          height: 44,
          borderRadius: 12,
          background: "rgba(255,255,255,0.08)",
          color: "rgba(255,255,255,0.45)",
          fontSize: 20,
          padding: "0 16px",
          display: "flex",
          alignItems: "center",
        }}
      >
        Search or enter address
      </div>
      <div style={{ margin: "14px 22px 8px", color: "#fff", fontSize: 22, fontWeight: 700 }}>🏠 Personal</div>
      <div style={{ position: "relative", margin: "0 10px" }}>
        {rows.map((r) => {
          const top = y;
          y += ROW * r.grow;
          const isNew = r.at >= 0;
          const v = everyRow ? flash(t, events) : isNew ? flash(t, [r.at]) : 0;
          return (
            <div
              key={r.key}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top,
                height: ROW,
                opacity: r.grow,
                transform: `translateX(${(1 - r.grow) * -20}px)`,
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "0 14px",
                borderRadius: 10,
                background: isNew && r.at === NEW_ROWS[NEW_ROWS.length - 1]!.at ? "rgba(255,255,255,0.1)" : "transparent",
                color: "#e8eaee",
                fontSize: 22,
                fontWeight: 500,
              }}
            >
              <span style={{ width: 20, height: 20, borderRadius: 5, background: r.color, flexShrink: 0 }} />
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</span>
              <FlashBox v={v} color={everyRow ? C.pink : C.yellow} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SidebarAct({ t }: { t: number }) {
  return (
    <>
      <Side t={t} left={130} version="Bay 1.5.4" note="every row redraws">
        <SidebarMock t={t} everyRow />
      </Side>
      <Side t={t} left={1230} version="Bay 1.6" on note="only the new tab">
        <SidebarMock t={t} everyRow={false} />
      </Side>
      <div style={{ position: "absolute", left: 730, width: 460, top: 330, textAlign: "center" }}>
        <div style={{ display: "inline-block", textAlign: "left" }}>
          <Circled t={t} at={74} pad={0.1}>
            <Count t={t} at={44} to={92} suffix="%" size={190} color={C.yellow} />
          </Circled>
        </div>
        <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-0.03em", marginTop: 30, opacity: ramp(t, 62, 14) }}>less redrawing</div>
        <div style={{ fontSize: 26, color: C.muted, marginTop: 8, opacity: ramp(t, 66, 14) }}>when you open a tab</div>
      </div>
      <Line t={t}>
        The sidebar redraws{" "}
        <Marker color={C.yellow} progress={ramp(t, 26, 16)}>
          92% less
        </Marker>
        .
      </Line>
    </>
  );
}

// The command bar: "lisbon" typed a key at a time; the top row is the only one whose content changes.
const KEYS = [12, 21, 30, 39, 48, 57];
const QUERY = "lisbon";
const RESULTS = [
  ["#1f5fe0", "Lisbon Travel – Lonely Planet", "lonelyplanet.com"],
  ["#e74c3c", "Time Out Lisbon", "timeout.com"],
  ["#2ea44f", "Lisboa Region", "visitportugal.com"],
  ["#8e5a2b", "Pastéis de nata recipe", "bbcgoodfood.com"],
  ["#f36f21", "Lisbon weather", "accuweather.com"],
] as const;

function CommandBarMock({ t, everyRow }: { t: number; everyRow: boolean }) {
  const typed = QUERY.slice(0, KEYS.filter((k) => k <= t).length);
  const caret = Math.floor(t / 12) % 2 === 0;
  const keyFlash = flash(t, KEYS);
  const rows = [["#5c616d", typed ? `Search for “${typed}”` : "Search or enter address", "Google"] as const, ...RESULTS];
  return (
    <div
      style={{
        height: 640,
        borderRadius: 22,
        overflow: "hidden",
        background: "#fff",
        boxShadow: "0 50px 90px -40px rgba(20,24,40,0.5), 0 0 0 1px rgba(0,0,0,0.06)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          height: 92,
          padding: "0 28px",
          borderBottom: `1px solid ${C.line}`,
          fontSize: 32,
          fontWeight: 600,
        }}
      >
        <span style={{ color: C.faint, fontSize: 30 }}>⌕</span>
        <span>
          {typed}
          <span style={{ opacity: caret ? 1 : 0, color: C.pen }}>|</span>
        </span>
      </div>
      <div style={{ padding: "12px 14px" }}>
        {rows.map(([color, title, host], i) => {
          const changes = i === 0;
          const v = everyRow || changes ? keyFlash : 0;
          return (
            <div
              key={i}
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                gap: 16,
                height: 82,
                padding: "0 16px",
                borderRadius: 12,
                background: i === 0 ? "#eef2fb" : "transparent",
              }}
            >
              <span style={{ width: 30, height: 30, borderRadius: 8, background: color, flexShrink: 0, opacity: i === 0 ? 0.5 : 1 }} />
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontSize: 23, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
                <span style={{ fontSize: 18, color: C.faint }}>{host}</span>
              </span>
              <FlashBox v={v} color={everyRow ? C.pink : C.yellow} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CommandBarAct({ t }: { t: number }) {
  return (
    <>
      <Side t={t} left={130} version="Bay 1.5.4" note="every row, every key">
        <CommandBarMock t={t} everyRow />
      </Side>
      <Side t={t} left={1230} version="Bay 1.6" on note="only the row that changed">
        <CommandBarMock t={t} everyRow={false} />
      </Side>
      <div style={{ position: "absolute", left: 730, width: 460, top: 330, textAlign: "center" }}>
        <div style={{ display: "inline-block", textAlign: "left" }}>
          <Circled t={t} at={74} pad={0.1}>
            <Count t={t} at={44} to={83} suffix="%" size={190} color={C.pink} />
          </Circled>
        </div>
        <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-0.03em", marginTop: 30, opacity: ramp(t, 62, 14) }}>less redrawing</div>
        <div style={{ fontSize: 26, color: C.muted, marginTop: 8, opacity: ramp(t, 66, 14) }}>as you type</div>
      </div>
      <Line t={t}>
        The command bar does{" "}
        <Marker color={C.pink} progress={ramp(t, 26, 16)}>
          83% less
        </Marker>{" "}
        as you type.
      </Line>
    </>
  );
}

// MARK: The scene: the acts in turn, crossfading, under a strip that says which one is on

const RENDER = [Memory, IdleCpu, SidebarAct, CommandBarAct];

export function PerformanceScene() {
  const frame = useBeat();
  const fade = useSceneFade();
  const current = STARTS.reduce((at, s, i) => (frame >= s ? i : at), 0);
  return (
    <Paper>
      <AbsoluteFill style={{ opacity: fade }}>
        {RENDER.map((Act, i) => {
          const t = frame - STARTS[i]!;
          const len = ACTS[i]!;
          if (t < -8 || t > len + 8) return null;
          const inOut = interpolate(t, [-8, 0, len - 6, len + 2], [0, 1, 1, 0], clamp);
          const drift = interpolate(t, [-8, 0, len - 6, len + 2], [30, 0, 0, -30], clamp);
          return (
            <AbsoluteFill key={i} style={{ opacity: inOut, transform: `translateX(${drift}px)` }}>
              <Act t={Math.max(0, t)} />
            </AbsoluteFill>
          );
        })}
        <div style={{ position: "absolute", left: 0, right: 0, top: 54, display: "flex", justifyContent: "center", alignItems: "center", gap: 34 }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: C.faint, textTransform: "uppercase", letterSpacing: "0.12em", marginRight: 6 }}>
            Faster in 1.6
          </span>
          {TABS.map((name, i) => {
            const on = i === current;
            const p = on ? ramp(frame - STARTS[i]!, 0, 14) : 0;
            return (
              <span key={name} style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", color: on ? C.ink : C.faint }}>
                <Marker color={[C.green, C.blue, C.yellow, C.pink][i]!} progress={p}>
                  {name}
                </Marker>
              </span>
            );
          })}
        </div>
        <div style={{ position: "absolute", right: 70, bottom: 26, fontSize: 18, color: C.faint, fontWeight: 600 }}>
          Measured on an M5 MacBook, Bay 1.6 against 1.5.4
        </div>
      </AbsoluteFill>
    </Paper>
  );
}
