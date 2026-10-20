import { useEffect, useLayoutEffect, useRef, useState } from "react";
import LiveWindow, { cx } from "./LiveWindow";
import { useBay, type Bay, type PresetName } from "./state";

type Box = { x: number; y: number; w: number; h: number };

/** The point on a box's edge toward p, pushed out by pad. */
const edge = (b: Box, p: { x: number; y: number }, pad: number) => {
  const midX = b.x + b.w / 2,
    midY = b.y + b.h / 2,
    dx = p.x - midX,
    dy = p.y - midY;
  const s = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity);
  const L = Math.hypot(dx, dy) || 1;
  return { x: midX + dx * s + (dx / L) * pad, y: midY + dy * s + (dy / L) * pad };
};

/** A pen stroke from a to b, bent a little, then its head. */
const arrow = (a: { x: number; y: number }, b: { x: number; y: number }, bend: number) => {
  const mx = (a.x + b.x) / 2,
    my = (a.y + b.y) / 2,
    dx = b.x - a.x,
    dy = b.y - a.y;
  const qx = mx - dy * bend,
    qy = my + dx * bend;
  const tx = b.x - qx,
    ty = b.y - qy,
    tl = Math.hypot(tx, ty) || 1,
    ux = tx / tl,
    uy = ty / tl;
  const turn = (t: number) => ({ x: -ux * Math.cos(t) + uy * Math.sin(t), y: -uy * Math.cos(t) - ux * Math.sin(t) });
  const h1 = turn(0.5),
    h2 = turn(-0.5),
    hl = 11;
  return [`M${a.x} ${a.y} Q${qx} ${qy} ${b.x} ${b.y}`, `M${b.x + h1.x * hl} ${b.y + h1.y * hl} L${b.x} ${b.y} L${b.x + h2.x * hl} ${b.y + h2.y * hl}`];
};

function TidyControls({ bay }: { bay: Bay }) {
  const sp = bay.s.spaces[bay.s.space];
  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-[13px]">
      <span className="text-muted">Put away after</span>
      <span className="flex rounded-xl bg-white p-1 shadow-[0_0_0_1px_var(--color-line)]">
        {[
          [12, "12 hours"],
          [24, "1 day"],
          [168, "7 days"],
        ].map(([h, label]) => (
          <button
            key={h}
            type="button"
            onClick={() => {
              bay.touch();
              bay.keep(h as number);
            }}
            className={cx(
              "cursor-pointer rounded-lg px-3 py-1.5 font-semibold transition-colors",
              sp.keep === h ? "bg-ink text-white" : "text-muted hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </span>
      <button
        type="button"
        data-spot="skip"
        onClick={() => {
          bay.touch();
          bay.skip(6);
        }}
        className="btn cursor-pointer px-4 py-2 text-[13px]"
      >
        Skip ahead 6 hours ⏩
      </button>
    </div>
  );
}

export type LiveFigureProps = {
  preset: PresetName;
  /** The pen's note, and the part of the window it points at (a data-spot). */
  note?: string;
  spot?: string;
  noteClass?: string;
  bend?: number;
  label: string;
  tidy?: boolean;
};

export default function LiveFigure({ preset, note, spot, noteClass, bend = 0.2, label, tidy }: LiveFigureProps) {
  const bay = useBay(preset);
  const fig = useRef<HTMLElement>(null);
  const noteEl = useRef<HTMLParagraphElement>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [seen, setSeen] = useState(false);

  // The arrow follows what it points at: drawn again on every change and resize.
  useLayoutEffect(() => {
    const draw = () => {
      const f = fig.current,
        n = noteEl.current;
      const t = spot ? f?.querySelector<HTMLElement>(`[data-spot="${spot}"]`) : null;
      if (!f || !n || !t || !t.getClientRects().length) return setPaths([]);
      const o = f.getBoundingClientRect();
      const box = (el: Element): Box => {
        const r = el.getBoundingClientRect();
        return { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height };
      };
      const nb = box(n),
        tb = box(t);
      const end = edge(tb, { x: nb.x + nb.w / 2, y: nb.y + nb.h / 2 }, 8);
      setPaths(arrow(edge(nb, end, 6), end, bend).map((d) => d.replace(/\d+\.\d+/g, (x) => (+x).toFixed(1))));
    };
    draw();
    const ro = new ResizeObserver(draw);
    if (fig.current) ro.observe(fig.current);
    return () => ro.disconnect();
  }, [bay.s, spot, bend]);

  useEffect(() => {
    const f = fig.current;
    if (!f) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -15% 0px" },
    );
    io.observe(f);
    return () => io.disconnect();
  }, []);

  return (
    <figure ref={fig} className="relative" aria-label={label} data-nosnippet="">
      {note ? (
        <p
          ref={noteEl}
          aria-hidden
          className={cx(
            "hand pointer-events-none absolute z-10 text-[23px] leading-none whitespace-nowrap transition-[clip-path] duration-[900ms] ease-out sm:text-[26px]",
            seen ? "[clip-path:inset(-40%_0%_-40%_0)]" : "[clip-path:inset(-40%_100%_-40%_0)]",
            noteClass,
          )}
        >
          {note}
        </p>
      ) : null}
      <svg aria-hidden className="pointer-events-none absolute inset-0 z-20 size-full overflow-visible text-pen" fill="none">
        {paths.map((d, i) => (
          <path
            key={i}
            d={d}
            pathLength={1}
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={1}
            style={{
              strokeDashoffset: seen && !bay.touched ? 0 : 1,
              transition: `stroke-dashoffset ${i ? 200 : 450}ms cubic-bezier(.4,0,.2,1) ${bay.touched ? 0 : 700 + i * 450}ms`,
            }}
          />
        ))}
      </svg>
      <button
        type="button"
        onClick={bay.reset}
        className={cx(
          "hand absolute -top-9 right-1 z-10 cursor-pointer text-[21px] transition-opacity duration-300 hover:underline",
          bay.touched ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        tabIndex={bay.touched ? 0 : -1}
      >
        start over ↺
      </button>
      <div className="card p-2 shadow-[0_30px_60px_-30px_rgba(30,32,60,0.4)] sm:p-3">
        <div className="@container">
          <div className="mock mock-frame relative w-full">
            <LiveWindow bay={bay} />
          </div>
        </div>
      </div>
      {tidy ? <TidyControls bay={bay} /> : null}
    </figure>
  );
}
