import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { FREQUENT, ICONS, type Site } from "./sites";
import { tabsOf, THEMES, type Bay, type Item, type SpaceIcon } from "./state";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const ARRIVE = "cubic-bezier(.2,.8,.2,1)";
// A sidebar row, as yab measures it: 30px tall, 13px type, at 900px wide.
const ROW = "flex h-[2.31em] w-full cursor-pointer items-center gap-[0.69em] rounded-[0.62em] pr-[0.62em] pl-[0.69em] text-left text-[0.925em] transition-colors";

// MARK: small pieces

const PATHS = {
  back: "M15 5l-7 7 7 7",
  fwd: "M9 5l7 7-7 7",
  reload: "M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5",
  plus: "M12 5v14M5 12h14",
  x: "M6 6l12 12M18 6L6 18",
  search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM16.5 16.5L21 21",
  expand: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7",
  split: "M4 5h16v14H4zM12 5v14",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z",
  shield: "M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z",
  cam: "M4 7h11v10H4zM15 10l5-3v10l-5-3",
  mic: "M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v3",
  pin: "M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 3",
  download: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5v8M8.5 12.5l3.5 3.5 3.5-3.5",
} as const;

function Ic({ d, className }: { d: keyof typeof PATHS; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cx("size-[1em] shrink-0", className)} fill="none" aria-hidden>
      <path d={PATHS[d]} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Mark({ site, size = 1.15 }: { site: Site; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-grid shrink-0 place-items-center leading-none text-white"
      style={{ width: `${size}em`, height: `${size}em`, borderRadius: `${size * 0.28}em`, background: `linear-gradient(${site.tint}f2, ${site.tint}bf)` }}
    >
      {ICONS[site.glyph] ? (
        <svg viewBox="0 0 24 24" style={{ width: "68%", height: "68%" }} fill={site.glyph === "play" ? "currentColor" : "none"}>
          <path d={ICONS[site.glyph]} stroke="currentColor" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <span className="font-bold" style={{ fontSize: `${size * 0.52}em` }}>{site.glyph}</span>
      )}
    </span>
  );
}

export function Keys({ keys, dark }: { keys: string[]; dark?: boolean }) {
  return (
    <span className="ml-auto flex gap-[0.2em]">
      {keys.map((k) => (
        <kbd
          key={k}
          className={cx(
            "grid h-[1.45em] min-w-[1.45em] place-items-center rounded-[0.32em] px-[0.25em] font-sans text-[0.75em] font-medium",
            dark ? "bg-white/15 text-white/80" : "bg-black/[0.06] text-black/50",
          )}
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

// A space's glyph in the switcher: filled, in the colour Bay's symbolColors give it.
const SPACE_GLYPHS: Record<SpaceIcon, [string, string]> = {
  house: ["M3.5 11.2L12 4l8.5 7.2V19.5a1 1 0 0 1-1 1H15v-5.5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5.5H4.5a1 1 0 0 1-1-1z", "#FF9500"],
  briefcase: ["M8.5 7V5.8A1.8 1.8 0 0 1 10.3 4h3.4a1.8 1.8 0 0 1 1.8 1.8V7h3.7A1.8 1.8 0 0 1 21 8.8v9.4a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 18.2V8.8A1.8 1.8 0 0 1 4.8 7zm1.8 0h3.4V5.8h-3.4z", "#A2845E"],
  leaf: ["M20.5 3.5C10.5 3.5 4 8.5 4 15.2c0 1.5.4 2.9 1 4 1.2-4 4.2-7.4 9-9.6-3.9 2.7-6.6 6-7.7 10 1 .4 2.1.6 3.2.6 7 0 11-6.3 11-16.7z", "#34C759"],
  sparkles: ["M11 3l1.9 5.6L18.5 10.5l-5.6 1.9L11 18l-1.9-5.6L3.5 10.5l5.6-1.9zM18 14l.9 2.6 2.6.9-2.6.9L18 21l-.9-2.6-2.6-.9 2.6-.9z", "#AF52DE"],
};

function SpaceGlyph({ icon }: { icon: SpaceIcon }) {
  const [d, color] = SPACE_GLYPHS[icon];
  return (
    <svg viewBox="0 0 24 24" className="size-[1.2em]" aria-hidden>
      <path d={d} fill={color} fillRule="evenodd" />
    </svg>
  );
}

/** A folder whose front tips forward as it opens. */
function Folder({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="size-[1.15em] shrink-0 overflow-visible" fill="none" aria-hidden>
      <path d="M3 18.5V6.5a2 2 0 0 1 2-2h4.3l1.9 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#ebebed" stroke="#3d3d40" strokeWidth="1.8" strokeLinejoin="round" />
      <path
        d="M3.6 10h16.8a1 1 0 0 1 1 1.2l-1.4 7.6a2 2 0 0 1-2 1.7H5.5a2 2 0 0 1-2-1.7L2.6 11.2A1 1 0 0 1 3.6 10z"
        fill="#f8f8f9"
        stroke="#3d3d40"
        strokeWidth="1.8"
        strokeLinejoin="round"
        style={{
          transformOrigin: "12px 20px",
          transform: open ? "skewX(-14deg) scaleY(0.72) translateX(2.4px)" : "none",
          transition: `transform 320ms ${ARRIVE}`,
        }}
      />
    </svg>
  );
}

const Bar = ({ w, className }: { w: number; className?: string }) => (
  <i className={cx("block h-[0.5em] rounded-full bg-black/[0.07]", className)} style={{ width: `${w}%` }} />
);

// MARK: pages

function Page({ id, bay, inPeek }: { id: string; bay: Bay; inPeek?: boolean }) {
  const { s } = bay;
  const site = s.sites[id];
  const b = site.body;
  const link = site.link && !inPeek ? (
    <button type="button" data-peek-link={site.link} onClick={() => bay.peek(site.link!)} className="cursor-pointer text-left text-[0.85em] text-[#1f5fe0] underline decoration-[#1f5fe0]/40 underline-offset-[0.2em] hover:decoration-[#1f5fe0]">
      {s.sites[site.link].linkText ?? `Open ${s.sites[site.link].title}`}
    </button>
  ) : null;

  if (b.kind === "flights") {
    const rows = [["07:15", "10:05", "€84"], ["09:40", "12:25", "€97"], ["13:20", "16:10", "€112"]];
    return (
      <div className="flex h-full flex-col gap-[0.7em] p-[1.4em]">
        <p className="text-[1.55em] font-semibold tracking-tight">London to Lisbon</p>
        <div className="grid grid-cols-2 gap-[0.5em] text-[0.85em]">
          <span className="rounded-[0.6em] border border-black/10 px-[0.8em] py-[0.55em]"><span className="text-black/40">From </span>London</span>
          <span className="rounded-[0.6em] border border-black/10 px-[0.8em] py-[0.55em]"><span className="text-black/40">To </span>Lisbon</span>
        </div>
        {s.held && s.picked !== null ? (
          <div className="rounded-[0.7em] border border-black/10 p-[0.9em] text-[0.85em] animate-[fade_300ms_ease_both]">
            <p className="flex font-semibold">Seat held<span className="ml-auto font-normal text-black/45">for 15 minutes</span></p>
            <p className="mt-[0.5em] flex gap-[0.6em]"><b>{rows[s.picked][0]}</b><span className="text-black/45">to {rows[s.picked][1]}</span><b className="ml-auto">{rows[s.picked][2]}</b></p>
            <span className="mt-[0.8em] inline-block rounded-[0.5em] bg-[#3b6ff0] px-[0.9em] py-[0.35em] font-semibold text-white">Pay {rows[s.picked][2]}</span>
          </div>
        ) : (
          <>
            <span className="w-fit rounded-[0.5em] bg-[#3b6ff0] px-[1em] py-[0.35em] text-[0.85em] font-semibold text-white">Search</span>
            {rows.map(([a, c, p], i) => (
              <button
                key={a}
                type="button"
                data-spot={i === 1 ? "result" : undefined}
                onClick={() => bay.pick(i)}
                className={cx(
                  "flex cursor-pointer items-center gap-[0.8em] rounded-[0.6em] border px-[0.8em] py-[0.5em] text-left text-[0.85em] transition-colors",
                  s.picked === i ? "border-black/80 shadow-[0_0_0_1px_rgba(0,0,0,0.8)]" : "border-black/10 hover:bg-black/[0.03]",
                )}
              >
                <b className="font-semibold">{a}</b>
                <i className="h-px w-[4em] bg-black/15" />
                <span className="text-black/45">{c}</span>
                <b className="ml-auto font-semibold">{p}</b>
              </button>
            ))}
            {s.picked !== null ? (
              <button type="button" onClick={bay.hold} className="w-fit cursor-pointer rounded-[0.5em] bg-[#141414] px-[0.9em] py-[0.4em] text-[0.8em] font-semibold text-white animate-[fade_250ms_ease_both]">
                Continue with {rows[s.picked][0]} · {rows[s.picked][2]}
              </button>
            ) : (
              link
            )}
          </>
        )}
      </div>
    );
  }
  if (b.kind === "video") {
    return (
      <div className="flex h-full flex-col gap-[0.7em] p-[1.2em]">
        <div className="relative grid aspect-video w-full place-items-center rounded-[0.6em] bg-gradient-to-br from-[#2e2f52] to-[#11121c]">
          <span className="grid size-[3em] place-items-center rounded-full bg-white/90 pl-[0.2em] text-[#11121c]">▶</span>
          <span className="absolute inset-x-[1em] bottom-[0.8em] h-[0.3em] rounded-full bg-white/20"><span className="block h-full w-1/3 rounded-full bg-[#ec6a3c]" /></span>
        </div>
        <p className="text-[1.1em] font-semibold">{b.title}</p>
        <Bar w={60} />
      </div>
    );
  }
  if (b.kind === "dev") {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-[0.6em] bg-[#1c1e23] px-[0.9em] py-[0.45em] text-[0.75em] text-white/75">
          <span className="rounded-[0.3em] bg-[#ec6a3c] px-[0.45em] py-[0.05em] font-semibold text-white">Developer Mode</span>
          <span>localhost:4321</span>
          <span className="ml-auto">Inspect</span>
          <Keys keys={["⌥", "⌘", "I"]} dark />
        </div>
        <div className="flex flex-1 flex-col items-start justify-center gap-[0.8em] bg-[#fbf7ef] px-[2em]">
          <span className="rounded-full bg-[#b8e6a0] px-[0.7em] py-[0.1em] text-[0.75em] font-semibold">v0.1 · coming soon</span>
          <p className="text-[2em] font-bold tracking-tight">{b.title}</p>
          <Bar w={55} className="bg-black/10" />
          <Bar w={40} className="bg-black/10" />
        </div>
      </div>
    );
  }
  if (b.kind === "news") {
    const ad = (wide?: boolean) =>
      s.blocking ? (
        <div className={cx("grid place-items-center rounded-[0.6em] border border-dashed border-black/15 text-[0.75em] text-black/35", wide ? "h-[3em]" : "h-full")}>Ad blocked</div>
      ) : (
        <div className={cx("grid place-items-center rounded-[0.6em] bg-[repeating-linear-gradient(45deg,#ffe14d_0_10px,#ffd000_10px_20px)] text-center font-black text-[#c40000] animate-[fade_200ms_ease_both]", wide ? "h-[3em] text-[0.95em]" : "h-full text-[0.85em] leading-tight")}>
          {wide ? "YOU WON’T BELIEVE #7 →" : <>70% OFF<br />TODAY ONLY</>}
        </div>
      );
    return (
      <div className="relative flex h-full flex-col gap-[0.7em] p-[1.4em]">
        <p className="text-[0.75em] text-black/40">The Daily Example</p>
        <p className="text-[1.55em] font-semibold tracking-tight">{b.title}</p>
        <div className="grid h-[6.5em] grid-cols-[1fr_9em] gap-[0.6em]">
          <div className="rounded-[0.6em] bg-gradient-to-br from-[#e4e4e7] to-[#cdcdd2]" />
          {ad()}
        </div>
        <Bar w={96} />
        <Bar w={88} />
        {ad(true)}
        {link}
        <Bar w={70} />
        {s.blocking ? (
          <div data-spot="adpill" className="absolute bottom-[1em] left-1/2 flex -translate-x-1/2 items-center gap-[0.4em] whitespace-nowrap rounded-full bg-white px-[0.9em] py-[0.4em] text-[0.75em] font-medium shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_4px_14px_rgba(0,0,0,0.12)] animate-[fade_300ms_ease_both]">
            <Ic d="shield" className="text-[#16a34a]" />
            Ads and trackers stopped<span className="text-black/40">· 38 on this page</span>
          </div>
        ) : null}
      </div>
    );
  }
  if (b.kind === "blank") {
    return (
      <div className="grid h-full place-items-center">
        <button type="button" aria-label="Search or type a URL" onClick={() => bay.omni(true)} className="grid size-[3.2em] cursor-pointer place-items-center rounded-full text-[1.4em] text-black/25 transition-colors hover:bg-black/[0.04] hover:text-black/45">
          <Ic d="plus" />
        </button>
      </div>
    );
  }
  if (b.kind === "search") {
    return (
      <div className="flex h-full flex-col gap-[0.8em] p-[1.4em]">
        <p className="text-[0.75em] text-black/40">Search</p>
        <p className="text-[1.55em] font-semibold tracking-tight">{b.q}</p>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-[0.35em]">
            <Bar w={[34, 42, 28, 38][i]} className="h-[0.6em] bg-[#1f5fe0]/45" />
            <Bar w={[92, 80, 86, 70][i]} />
          </div>
        ))}
      </div>
    );
  }
  if (b.kind === "list") {
    return (
      <div className="flex h-full flex-col gap-[0.6em] p-[1.4em]">
        <p className="text-[0.75em] text-black/40">{b.kicker}</p>
        <p className="text-[1.55em] font-semibold tracking-tight">{b.title}</p>
        {b.rows.map((r, i) => (
          <span key={r} className="flex items-center gap-[0.8em] rounded-[0.6em] border border-black/[0.08] px-[0.8em] py-[0.6em]">
            <i className="size-[1.6em] shrink-0 rounded-full" style={{ background: ["#ffd84d", "#ffb3c8", "#a8d5fb"][i % 3] }} />
            <span className="flex min-w-0 flex-col gap-[0.35em]">
              <span className="truncate text-[0.85em] font-medium">{r}</span>
              <Bar w={[70, 55, 62][i % 3]} />
            </span>
          </span>
        ))}
        {link}
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col gap-[0.7em] p-[1.4em]">
      <p className="text-[0.75em] text-black/40">{b.kicker}</p>
      <p className="text-[1.55em] font-semibold tracking-tight">{b.title}</p>
      <div className="h-[6em] rounded-[0.6em]" style={{ background: `linear-gradient(135deg, ${site.tint}33, ${site.tint}12)` }} />
      <Bar w={100} />
      <Bar w={92} />
      {link}
      <Bar w={96} />
      <Bar w={80} />
      <Bar w={58} />
    </div>
  );
}

// MARK: the command bar

type OmniRow = { site: Site; key: string; sub: string; end?: string; act: string; run: () => void };

function Omni({ bay, quiet }: { bay: Bay; quiet: boolean }) {
  const { s } = bay;
  const [q, setQ] = useState("");
  const [pick, setPick] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!quiet) input.current?.focus({ preventScroll: true }); }, [quiet]);

  const sp = s.spaces[s.space];
  const sections = useMemo((): [string, OmniRow[]][] => {
    const tabRow = (id: string, headed: boolean): OmniRow => ({
      site: s.sites[id], key: s.sites[id].title, sub: s.sites[id].host, end: headed ? undefined : "Open Tab", act: "Switch to Tab", run: () => bay.go(id),
    });
    const keptRow = (id: string): OmniRow => ({
      site: s.sites[id], key: s.sites[id].title, sub: s.sites[id].host, end: "Put away", act: "Bring Back", run: () => bay.restore(id),
    });
    const all = [...sp.pins, ...tabsOf(sp)].filter((id, i, a) => a.indexOf(id) === i);
    const ql = q.trim().toLowerCase();
    if (!ql) {
      return [
        ["Recent Tabs", tabsOf(sp).filter((t) => t !== sp.active).slice(0, 3).map((t) => tabRow(t, true))],
        ["Put Away", s.putAway.slice(-3).reverse().map((p) => keptRow(p.id))],
        ["Frequent", FREQUENT.map((id) => ({ site: s.sites[id], key: s.sites[id].title, sub: s.sites[id].host, act: "Open", run: () => bay.openSite(id) }))],
      ];
    }
    const hit = (id: string) => s.sites[id].title.toLowerCase().includes(ql) || s.sites[id].host.includes(ql);
    const url = /\.[a-z]{2,}/i.test(ql) && !/\s/.test(ql);
    const neu: OmniRow = url
      ? { site: { title: q, host: q, glyph: "◎", tint: "#8e8e93", body: { kind: "search", q } }, key: q.trim(), sub: "", act: "Open", run: () => bay.open(q.trim(), false) }
      : { site: { title: q, host: "", glyph: "⌕", tint: "#8e8e93", body: { kind: "search", q } }, key: q.trim(), sub: "Search", act: "Search", run: () => bay.open(q.trim(), true) };
    return [["", [...all.filter(hit).slice(0, 3).map((t) => tabRow(t, false)), ...s.putAway.filter((p) => hit(p.id)).slice(0, 2).map((p) => keptRow(p.id)), neu]]];
  }, [q, s, sp, bay]);

  const rows = sections.flatMap(([, r]) => r);
  const at = Math.min(pick, rows.length - 1);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { setPick(Math.min(rows.length - 1, at + 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp") { setPick(Math.max(0, at - 1)); e.preventDefault(); }
    else if (e.key === "Enter") { rows[at]?.run(); e.preventDefault(); }
    else if (e.key === "Escape") { bay.omni(false); e.preventDefault(); e.stopPropagation(); }
  };

  // As yab draws it (live.js): a frosted card over the page, the field on top with no rule under it, sections of
  // 35px rows, and what Return does on a small grey plate at the card's foot.
  const kbd = (k: string) => (
    <kbd key={k} className="grid size-[1.28em] place-items-center rounded-[0.36em] bg-[rgba(133,133,134,0.14)] font-sans text-[0.82em] text-[#858586]">
      {k}
    </kbd>
  );
  let i = -1;
  return (
    <div
      data-omni
      className="absolute inset-x-[1.42em] inset-y-[4.48em] z-30 flex flex-col overflow-hidden rounded-[1.71em] bg-white/90 shadow-[0_0_0_0.5px_rgba(20,20,20,0.12),0_2.13em_5.7em_rgba(20,20,20,0.18)] backdrop-blur-[30px] backdrop-saturate-[1.6] animate-[omni_220ms_cubic-bezier(.2,.8,.2,1)_both]"
    >
      <label data-spot="omni" className="flex h-[3.77em] shrink-0 items-center gap-[0.78em] px-[1.07em] text-[#8e8e90]">
        <Ic d="search" className="text-[1.21em]" />
        <input
          ref={input}
          value={q}
          onChange={(e) => { setQ(e.target.value); setPick(0); }}
          onKeyDown={onKey}
          spellCheck={false}
          autoComplete="off"
          placeholder="Search or enter address"
          aria-label="Search or enter address"
          className="min-w-0 flex-1 bg-transparent text-[1.21em] tracking-[-0.01em] text-[#141414] caret-[#3b82f6] outline-none placeholder:text-[#a5a5a7]"
        />
      </label>
      <div className="min-h-0 flex-1 overflow-hidden px-[0.5em]">
        {sections.filter(([, r]) => r.length).map(([name, list]) => (
          <div key={name || "hits"}>
            {name ? <p className="px-[0.78em] pt-[0.87em] pb-[0.43em] text-[0.82em] text-[#959596]">{name}</p> : null}
            {list.map((r) => {
              i++;
              const on = i === at, n = i;
              return (
                <button
                  key={`${name}-${r.key}-${n}`}
                  type="button"
                  onMouseMove={() => n !== at && setPick(n)}
                  onClick={r.run}
                  className={cx("flex h-[2.49em] w-full cursor-pointer items-center gap-[0.78em] rounded-[0.64em] px-[0.64em] text-left text-[0.96em]", on && "bg-[rgba(20,20,20,0.07)]")}
                >
                  <Mark site={r.site} size={1.48} />
                  <span className="truncate text-[#141414]">{r.key}</span>
                  <span className="truncate text-[#6b6b6c]">{r.sub}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-[0.6em]">
                    {r.end ? <span className="text-[0.92em] text-[#959596]">{r.end}</span> : null}
                    {on ? kbd("↩") : null}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="absolute right-[0.71em] bottom-[0.71em] flex h-[2.28em] items-center gap-[0.71em] rounded-[0.71em] bg-[rgba(20,20,20,0.05)] pr-[0.43em] pl-[0.85em] text-[0.89em] text-[rgba(20,20,20,0.8)]">
        <span className="flex items-center gap-[0.4em]">{rows[at]?.act ?? "Open"} {kbd("↩")}</span>
        <i className="h-[1em] w-px bg-[rgba(20,20,20,0.12)]" />
        <span className="flex items-center gap-[0.4em]">Actions <span className="flex gap-[0.2em]">{kbd("⌘")}{kbd("K")}</span></span>
      </div>
    </div>
  );
}

// MARK: the site panel

function Panel({ bay }: { bay: Bay }) {
  const { s } = bay;
  const id = s.spaces[s.space].active;
  const site = s.sites[id];
  const count = site.body.kind === "news" ? 38 : 3;
  const row = (icon: keyof typeof PATHS, label: string, value: string) => (
    <div className="flex items-center gap-[0.6em] px-[0.8em] py-[0.4em]">
      <Ic d={icon} className="text-black/45" />
      <span>{label}</span>
      <span className="ml-auto text-black/40">{value}</span>
    </div>
  );
  return (
    <div data-panel data-spot="panel" className="absolute top-[0.6em] left-[0.6em] z-30 w-[17em] overflow-hidden rounded-[0.9em] bg-white/95 py-[0.4em] text-[0.8em] shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_1em_2.6em_-0.6em_rgba(0,0,0,0.35)] backdrop-blur animate-[omni_200ms_cubic-bezier(.2,.8,.2,1)_both]">
      <div className="flex items-center gap-[0.6em] px-[0.8em] py-[0.4em]">
        <Mark site={site} size={1.5} />
        <span className="min-w-0">
          <b className="block truncate font-semibold">{site.host.split("/")[0]}</b>
          <span className="block truncate text-black/45">{site.title}</span>
        </span>
      </div>
      <i className="mx-[0.8em] my-[0.3em] block h-px bg-black/[0.07]" />
      {row("lock", "Connection is secure", "")}
      <button type="button" onClick={bay.block} data-spot="blockswitch" className="flex w-full cursor-pointer items-center gap-[0.6em] px-[0.8em] py-[0.4em] text-left hover:bg-black/[0.04]">
        <Ic d="shield" className="text-black/45" />
        <span>
          Block ads &amp; trackers
          <span className="block text-[0.85em] text-black/40">{s.blocking ? `${count} blocked on this page` : "Off for this site"}</span>
        </span>
        <span role="switch" aria-checked={s.blocking} className={cx("ml-auto flex h-[1.25em] w-[2.2em] items-center rounded-full p-[0.15em] transition-colors", s.blocking ? "bg-[#3b82f6]" : "bg-black/20")}>
          <i className={cx("size-[0.95em] rounded-full bg-white shadow transition-transform", s.blocking && "translate-x-[0.95em]")} />
        </span>
      </button>
      {row("cam", "Camera", "Ask")}
      {row("mic", "Microphone", "Ask")}
      {row("pin", "Location", "Ask")}
    </div>
  );
}

// MARK: the window

export type LiveWindowProps = { bay: Bay };

export default function LiveWindow({ bay }: LiveWindowProps) {
  const { s } = bay;
  const sp = s.spaces[s.space];
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const pageEl = useRef<HTMLDivElement>(null);
  const peekCard = useRef<HTMLDivElement>(null);
  const [peekLeaving, setPeekLeaving] = useState(false);

  const pair = sp.pair && (sp.active === sp.pair.a || sp.active === sp.pair.b) ? sp.pair : null;
  const activeSite = s.sites[sp.active];

  // Peek grows out of the link it came from, and goes back into it.
  const linkRect = (to: string) => pageEl.current?.querySelector<HTMLElement>(`[data-peek-link="${to}"]`)?.getBoundingClientRect() ?? null;
  const toward = (card: HTMLElement, r: DOMRect) => {
    const c = card.getBoundingClientRect();
    return `translate(${r.left - c.left}px, ${r.top - c.top}px) scale(${r.width / c.width}, ${r.height / c.height})`;
  };
  const shownPeek = useRef<string | null>(null);
  useLayoutEffect(() => {
    const card = peekCard.current;
    if (s.peek && s.peek !== shownPeek.current && card && !s.peekQuiet) {
      const r = linkRect(s.peek);
      card.animate(
        [{ transformOrigin: "0 0", transform: r ? toward(card, r) : "scale(.9)", opacity: 0.4 }, { transformOrigin: "0 0", transform: "none", opacity: 1 }],
        { duration: 460, easing: "cubic-bezier(.2,.9,.25,1.05)" },
      );
    }
    shownPeek.current = s.peek;
  }, [s.peek, s.peekQuiet]);

  const closePeek = async () => {
    const card = peekCard.current;
    if (!card || !s.peek) return bay.unpeek();
    const r = linkRect(s.peek);
    setPeekLeaving(true);
    await card.animate(
      [{ transformOrigin: "0 0", transform: "none", opacity: 1 }, { transformOrigin: "0 0", transform: r ? toward(card, r) : "scale(.9)", opacity: 0 }],
      { duration: 260, easing: ARRIVE, fill: "forwards" },
    ).finished.catch(() => {});
    setPeekLeaving(false);
    bay.unpeek();
  };
  const peekToTab = async () => {
    const card = peekCard.current, page = pageEl.current;
    if (card && page) {
      const c = card.getBoundingClientRect(), p = page.getBoundingClientRect();
      await card.animate(
        [{ transformOrigin: "0 0", transform: "none" }, { transformOrigin: "0 0", transform: `translate(${p.left - c.left}px, ${p.top - c.top}px) scale(${p.width / c.width}, ${p.height / c.height})` }],
        { duration: 300, easing: ARRIVE, fill: "forwards" },
      ).finished.catch(() => {});
    }
    bay.peekToTab();
  };

  // Two fingers across the sidebar switch spaces, as on a trackpad; a finger does too.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const REACH = 110;
    let travel = 0, way: "x" | "y" | null = null, sumX = 0, sumY = 0, spent = false;
    let quiet = 0, idle = 0;
    const inner = () => el.querySelector<HTMLElement>("[data-rows]");
    const follow = () => {
      const r = inner();
      if (!r) return;
      const p = Math.min(1, Math.abs(travel) / REACH);
      r.style.transition = "none";
      r.style.transform = `translateX(${(-Math.sign(travel) * REACH * p * 0.6).toFixed(1)}px)`;
      r.style.opacity = String(Math.max(0, 1 - 1.4 * p));
    };
    const land = () => {
      const p = Math.min(1, Math.abs(travel) / REACH), w: 1 | -1 = travel > 0 ? 1 : -1;
      travel = 0;
      if (p >= 0.4) { bay.touch(); bay.step(w); return true; }
      const r = inner();
      if (r) { r.style.transition = `transform .3s ${ARRIVE}, opacity .2s`; r.style.transform = ""; r.style.opacity = ""; }
      return false;
    };
    const wheel = (e: WheelEvent) => {
      clearTimeout(quiet);
      quiet = window.setTimeout(() => { way = null; sumX = sumY = 0; spent = false; }, 160);
      if (spent) { if (way === "x") e.preventDefault(); return; }
      if (!way) {
        sumX += e.deltaX; sumY += e.deltaY;
        if (Math.abs(sumY) > 8 && Math.abs(sumY) >= Math.abs(sumX)) way = "y";
        else if (Math.abs(sumX) > 10 && Math.abs(sumX) > Math.abs(sumY) * 2) way = "x";
        else { if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) e.preventDefault(); return; }
      }
      if (way !== "x") return;
      e.preventDefault();
      travel += e.deltaX;
      follow();
      clearTimeout(idle);
      if (Math.abs(travel) >= REACH) { land(); spent = true; return; }
      idle = window.setTimeout(() => { if (land()) spent = true; }, 140);
    };
    let startX: number | null = null;
    const down = (e: PointerEvent) => { if (e.pointerType !== "mouse") startX = e.clientX; };
    const move = (e: PointerEvent) => { if (startX === null) return; travel = (startX - e.clientX) * 1.2; follow(); };
    const up = () => { if (startX === null) return; startX = null; land(); };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, [bay]);

  // A click beside a card puts it away.
  const onPointerDown = (e: ReactPointerEvent) => {
    bay.touch();
    const t = e.target as HTMLElement;
    if (s.omni && !t.closest("[data-omni]") && !t.closest("[data-new]")) bay.omni(false);
    if (s.panel && !t.closest("[data-panel]") && !t.closest("[data-plate]")) bay.panel(false);
    if (s.menu !== null && !t.closest("[data-space-menu]")) bay.menu(null);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (s.omni) bay.omni(false);
      else if (s.peek) closePeek();
      else if (s.panel) bay.panel(false);
      else if (s.menu !== null) bay.menu(null);
    }
    if (e.ctrlKey && /^[1-9]$/.test(e.key) && +e.key <= s.spaces.length) { bay.toSpace(+e.key - 1); e.preventDefault(); }
  };

  // MARK: the sidebar's rows
  const age = (id: string) => {
    if (!s.showAges || s.ages[id] === undefined) return null;
    const h = s.ages[id];
    const soon = h >= sp.keep - 4 && id !== sp.active;
    const label = h === 0 ? "now" : h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
    return <em className={cx("ml-auto shrink-0 pr-[0.2em] text-[0.78em] not-italic", soon ? "font-semibold text-[#e8663f]" : "text-black/35")}>{label}</em>;
  };
  const row = (id: string, indent = false) => {
    if (pair && id === pair.b) return null;
    if (sp.pair && id === sp.pair.a) {
      const on = !!pair;
      const half = (t: string) => (
        <button key={t} type="button" onClick={() => bay.front(t)} className={cx("flex min-w-0 flex-1 cursor-pointer items-center gap-[0.45em] rounded-[0.5em] px-[0.45em]", on && sp.pair!.front === t && "bg-white shadow-[0_1px_2px_rgba(20,20,20,0.1)]")}>
          <Mark site={s.sites[t]} />
          <span className="truncate">{s.sites[t].title}</span>
        </button>
      );
      return (
        <div key={id} data-spot="pairrow" className={cx("flex h-[2.31em] gap-[0.2em] rounded-[0.62em] p-[0.18em] text-[0.925em]", indent && "ml-[1.4em]", on ? "bg-white/70 text-[#141414]" : "text-[#777778] hover:bg-black/[0.04]")}>
          {half(sp.pair.a)}
          {half(sp.pair.b)}
        </div>
      );
    }
    const on = sp.active === id && !pair;
    const leaving = s.leaving.includes(id);
    return (
      <div
        key={id}
        className={cx("grid transition-[grid-template-rows,opacity,transform] duration-[400ms]", leaving ? "grid-rows-[0fr] -translate-x-[1em] opacity-0" : "grid-rows-[1fr]")}
      >
        <div className="overflow-hidden">
          <div className={cx("group relative", s.born === id && "animate-[born_380ms_cubic-bezier(.2,.8,.2,1)_both]")}>
            <button
              type="button"
              data-tab={id}
              onClick={() => bay.go(id)}
              className={cx(
                ROW,
                indent && "pl-[2.1em]",
                on ? "bg-white text-[#141414] shadow-[0_1px_2px_rgba(20,20,20,0.08),0_0_0_0.5px_rgba(20,20,20,0.06)]" : "text-[#777778] hover:bg-black/[0.04]",
              )}
            >
              <Mark site={s.sites[id]} />
              <span className="truncate">{s.sites[id].title}</span>
              {age(id)}
            </button>
            <button
              type="button"
              aria-label={`Close ${s.sites[id].title}`}
              onClick={() => bay.close(id)}
              className="absolute top-1/2 right-[0.35em] hidden size-[1.35em] -translate-y-1/2 cursor-pointer place-items-center rounded-[0.35em] text-[0.8em] text-black/50 group-hover:grid hover:bg-black/10"
            >
              <Ic d="x" />
            </button>
          </div>
        </div>
      </div>
    );
  };
  const item = (it: Item, i: number) => {
    if ("line" in it) return <i key={`line-${i}`} className="mx-[0.7em] my-[0.45em] block h-px bg-black/[0.08]" />;
    if ("tab" in it) return row(it.tab);
    const stays = it.kids.filter((k) => k === sp.active || k === pair?.a);
    return (
      <div key={it.folder}>
        <button
          type="button"
          aria-expanded={it.open}
          onClick={() => bay.fold(it.folder)}
          data-spot={`folder-${it.folder}`}
          className={cx(ROW, "text-[#777778] hover:bg-black/[0.04]")}
        >
          <Folder open={it.open} />
          {it.name}
        </button>
        <div className={cx("grid transition-[grid-template-rows] duration-300", it.open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
          <div className="overflow-hidden">{it.kids.map((k) => row(k, true))}</div>
        </div>
        {!it.open && stays.length ? <div>{stays.map((k) => row(k, true))}</div> : null}
      </div>
    );
  };

  const plate = (() => {
    if (activeSite.body.kind === "dev" || pair) return null;
    if (activeSite.body.kind === "blank")
      return (
        <button type="button" data-plate onClick={() => bay.omni(true)} className="mb-[0.45em] w-full cursor-pointer truncate rounded-[0.45em] px-[0.25em] py-[0.15em] text-left text-[0.925em] text-[#8e8e90] hover:bg-black/[0.04]">
          Search or type a URL
        </button>
      );
    const name = activeSite.host.split("/")[0].replace(/^www\./, "");
    const owner = name.split(".").slice(-2).join(".");
    return (
      <button
        type="button"
        data-plate
        data-spot="plate"
        onClick={() => bay.panel()}
        className={cx("mb-[0.45em] w-full cursor-pointer truncate rounded-[0.45em] px-[0.25em] py-[0.15em] text-left text-[0.925em] transition-colors hover:bg-black/[0.04]", s.panel && "bg-black/[0.05]")}
      >
        <span className="text-[#8e8e90]">{name.slice(0, name.length - owner.length)}</span>
        {owner}
      </button>
    );
  })();

  const pageKey = `${s.space}-${sp.active}-${pair ? pair.a + pair.b : ""}`;

  return (
    <div
      ref={root}
      onPointerDownCapture={onPointerDown}
      onKeyDown={onKeyDown}
      className="relative flex h-full w-full overflow-hidden rounded-[1em] text-[#141414] shadow-[0_0_0_1px_rgba(20,20,20,0.08),0_1.85em_3.55em_-1.55em_rgba(10,10,40,0.5)] transition-colors duration-500 select-none"
      style={{ background: `color-mix(in oklab, #ececee 86%, ${sp.theme})` }}
    >

      {/* The sidebar */}
      <aside className="relative z-10 flex w-[15.2em] shrink-0 flex-col px-[0.71em] pt-[0.85em] pb-[0.71em]" aria-label="Sidebar">
        <div className="mb-[0.7em] flex items-center gap-[0.25em] pl-[0.35em]">
          <span className="flex gap-[0.45em]" aria-hidden>
            <i className="size-[0.75em] rounded-full bg-[#ff5f57]" />
            <i className="size-[0.75em] rounded-full bg-[#febc2e]" />
            <i className="size-[0.75em] rounded-full bg-[#28c840]" />
          </span>
          <span className="flex-1" />
          {(["back", "fwd", "reload"] as const).map((w) => (
            <button
              key={w}
              type="button"
              aria-label={w === "fwd" ? "Forward" : w === "back" ? "Back" : "Reload"}
              disabled={(w === "back" && !s.back.length) || (w === "fwd" && !s.fwd.length)}
              onClick={() => bay.nav(w)}
              className="grid size-[1.75em] cursor-pointer place-items-center rounded-[0.45em] text-[0.9em] text-[#7e7e80] hover:bg-black/[0.05] disabled:cursor-default disabled:text-black/20 disabled:hover:bg-transparent"
            >
              <Ic d={w} />
            </button>
          ))}
        </div>
        {plate}
        <div className="mb-[0.6em] grid grid-cols-4 gap-[0.42em]">
          {sp.pins.map((id) => {
            const on = sp.active === id && !pair;
            return (
              <button
                key={id}
                type="button"
                aria-label={s.sites[id].title}
                onClick={() => bay.go(id)}
                className={cx("grid h-[2.7em] cursor-pointer place-items-center rounded-[0.71em] transition-colors", on ? "bg-white shadow-[0_1px_2px_rgba(20,20,20,0.08),0_0_0_0.5px_rgba(20,20,20,0.06)]" : "bg-white/60 hover:bg-white/85")}
              >
                <Mark site={s.sites[id]} size={1.2} />
              </button>
            );
          })}
        </div>

        <div ref={stage} className="relative min-h-0 flex-1 touch-pan-y overflow-hidden">
          <div
            key={s.space}
            data-rows
            className={cx("flex flex-col gap-[0.1em]", s.dir === 1 && "animate-[from-next_320ms_cubic-bezier(.2,.8,.2,1)_both]", s.dir === -1 && "animate-[from-prev_320ms_cubic-bezier(.2,.8,.2,1)_both]")}
          >
            {sp.items.map(item)}
            <button
              type="button"
              data-new
              data-spot="newtab"
              onClick={() => bay.omni(!s.omni)}
              className={cx(ROW, "text-[#a3a3a5] hover:bg-black/[0.04]")}
            >
              <Ic d="plus" className="w-[1.15em]" />
              New tab
            </button>
          </div>
        </div>

        {/* Bay's space switcher (SpaceSwitcher): downloads on the left, a space's icon each in the middle (the shown one
            strongest, dots once they don't fit), + for a new space on the right. Right-click an icon for its menu. */}
        <div data-spot="spaces" className="relative mt-[0.3em] flex h-[2.9em] items-center justify-center">
          <span className="absolute left-0 grid size-[2em] place-items-center rounded-[0.57em] text-[0.95em] text-[#7e7e80]" title="Downloads" aria-hidden>
            <Ic d="download" />
          </span>
          <div className="flex items-center">
            {s.spaces.map((x, i) => {
              const on = i === s.space;
              const dots = s.spaces.length > 4;
              return (
                <button
                  key={`${x.name}-${i}`}
                  type="button"
                  title={x.name}
                  aria-label={x.name}
                  aria-pressed={on}
                  onClick={() => bay.toSpace(i)}
                  onContextMenu={(e) => { e.preventDefault(); bay.menu(i); }}
                  className={cx(
                    "grid cursor-pointer place-items-center rounded-[0.5em] transition-opacity duration-300",
                    dots ? "h-[2em] w-[0.86em]" : "size-[1.85em]",
                    on ? "opacity-95" : "opacity-[0.38] hover:opacity-60",
                  )}
                >
                  {dots ? <i className="size-[0.43em] rounded-full bg-black" /> : <SpaceGlyph icon={x.icon} />}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            title="New Space"
            aria-label="New Space"
            data-spot="newspace"
            onClick={bay.newSpace}
            disabled={s.spaces.length >= 6}
            className="absolute right-0 grid size-[2em] cursor-pointer place-items-center rounded-[0.57em] text-[0.95em] text-[#7e7e80] hover:bg-black/[0.05] disabled:cursor-default disabled:opacity-40"
          >
            <Ic d="plus" />
          </button>

          {s.menu !== null && s.spaces[s.menu] ? (
            <div data-space-menu className="absolute bottom-[2.6em] left-1/2 z-30 w-[13.5em] -translate-x-1/2 rounded-[0.7em] bg-white/95 p-[0.3em] text-[0.85em] shadow-[0_0_0_0.5px_rgba(20,20,20,0.12),0_0.8em_2em_-0.4em_rgba(10,10,40,0.35)] backdrop-blur animate-[omni_180ms_cubic-bezier(.2,.8,.2,1)_both]">
              <p className="flex items-center gap-[0.5em] px-[0.6em] pt-[0.35em] pb-[0.3em] font-semibold">
                <SpaceGlyph icon={s.spaces[s.menu].icon} />
                {s.spaces[s.menu].name}
              </p>
              <p className="px-[0.6em] pt-[0.3em] text-[0.85em] text-black/45">Theme</p>
              <div className="grid grid-cols-9 gap-[0.2em] px-[0.5em] py-[0.45em]">
                {THEMES.map(([label, color]) => (
                  <button
                    key={label}
                    type="button"
                    title={label}
                    aria-label={label}
                    onClick={() => bay.theme(s.menu!, color)}
                    className={cx("size-[1.15em] cursor-pointer rounded-full transition-transform hover:scale-125", s.spaces[s.menu!].theme === color && "ring-[0.15em] ring-black/30 ring-offset-[0.1em]")}
                    style={{ background: color }}
                  />
                ))}
              </div>
              <i className="mx-[0.6em] my-[0.2em] block h-px bg-black/[0.07]" />
              <button
                type="button"
                disabled={s.spaces.length < 2}
                onClick={() => bay.deleteSpace(s.menu!)}
                className="flex w-full cursor-pointer rounded-[0.45em] px-[0.6em] py-[0.35em] text-left hover:bg-[#3b82f6] hover:text-white disabled:cursor-default disabled:text-black/30 disabled:hover:bg-transparent"
              >
                Delete Space…
              </button>
            </div>
          ) : null}
        </div>
      </aside>

      {/* The page */}
      <main className="relative z-10 flex min-w-0 flex-1 py-[0.57em] pr-[0.57em]">
        <div ref={pageEl} className="relative flex min-w-0 flex-1 gap-[0.4em]">
          {pair ? (
            [pair.a, pair.b].map((t) => (
              <div
                key={t}
                data-spot={t === pair.b ? "half" : undefined}
                onPointerDown={() => pair.front !== t && bay.front(t)}
                className={cx(
                  "relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[0.6em] bg-white transition-shadow animate-[from-next_360ms_cubic-bezier(.2,.8,.2,1)_both]",
                  pair.front === t ? "shadow-[0_0_0_1.5px_rgba(20,20,20,0.55),0_2px_8px_rgba(0,0,0,0.1)]" : "shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.08)]",
                )}
              >
                <div className="flex items-center gap-[0.5em] border-b border-black/[0.06] px-[0.6em] py-[0.35em] text-[0.72em] text-black/45">
                  <Ic d="back" /><Ic d="fwd" /><Ic d="reload" />
                  <span className="min-w-0 flex-1 truncate">{s.sites[t].host}</span>
                  <button type="button" aria-label="Separate" onClick={() => bay.separate(t)} className="grid size-[1.5em] cursor-pointer place-items-center rounded-full hover:bg-black/10">
                    <Ic d="x" />
                  </button>
                </div>
                <div className="min-h-0 flex-1 text-[1.02em]"><Page id={t} bay={bay} /></div>
              </div>
            ))
          ) : (
            <div className="relative min-w-0 flex-1 overflow-hidden rounded-[0.71em] bg-white shadow-[0_0_0_1px_rgba(20,20,20,0.06),0_1px_2px_rgba(20,20,20,0.05)]">
              {s.reloads ? <i key={`bar-${s.reloads}`} className="absolute inset-x-0 top-0 z-10 h-[0.18em] origin-left bg-[#3b82f6] animate-[loadbar_600ms_ease-out_both]" /> : null}
              <div key={`${pageKey}-${s.reloads}`} className={cx("h-full text-[1.22em]", s.reloads ? "animate-[reload_600ms_ease_both]" : "animate-[fade_300ms_ease_both]")}>
                <Page id={sp.active} bay={bay} />
              </div>
            </div>
          )}

          {s.peek ? (
            <div
              className={cx("absolute inset-0 z-20 rounded-[0.6em] bg-black/25 transition-opacity", peekLeaving ? "opacity-0 duration-200" : "animate-[fade_200ms_ease_both]")}
              onClick={(e) => { if (e.target === e.currentTarget) closePeek(); }}
            >
              <div ref={peekCard} data-spot="peek" className="absolute inset-y-[5%] left-[6%] right-[12%] flex flex-col overflow-hidden rounded-[0.8em] bg-white shadow-[0_1em_3em_-0.5em_rgba(0,0,0,0.45)]">
                <div className="flex items-center gap-[0.5em] border-b border-black/[0.06] px-[0.8em] py-[0.45em] text-[0.75em] text-black/45">
                  <Mark site={s.sites[s.peek]} />
                  {s.sites[s.peek].host}
                </div>
                <div className="min-h-0 flex-1 text-[1.15em]"><Page id={s.peek} bay={bay} inPeek /></div>
              </div>
              <div className={cx("absolute top-[5%] right-[3%] flex flex-col gap-[0.4em]", peekLeaving && "opacity-0")}>
                {([["x", "Close", closePeek], ["expand", "Open as a tab", peekToTab], ["split", "Open in Split View", () => bay.peekToSplit()]] as const).map(([d, label, fn]) => (
                  <button
                    key={d}
                    type="button"
                    title={label}
                    aria-label={label}
                    onClick={() => fn()}
                    className="grid size-[2em] cursor-pointer place-items-center rounded-full bg-white text-[0.85em] text-black/70 shadow-[0_2px_8px_rgba(0,0,0,0.2)] transition-transform hover:scale-110 animate-[omni_260ms_120ms_cubic-bezier(.2,.8,.2,1)_both]"
                  >
                    <Ic d={d} />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {s.panel ? <Panel bay={bay} /> : null}
          {s.omni ? <Omni bay={bay} quiet={s.omniQuiet} /> : null}
          {s.toast ? (
            <div key={s.toast} className="absolute bottom-[1em] left-1/2 z-30 flex -translate-x-1/2 items-center gap-[0.5em] whitespace-nowrap rounded-full bg-[#141414] px-[1em] py-[0.5em] text-[0.78em] font-medium text-white shadow-lg animate-[omni_260ms_cubic-bezier(.2,.8,.2,1)_both]">
              <Ic d="clock" />
              {s.toast}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

