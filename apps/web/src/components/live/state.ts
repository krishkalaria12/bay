import { useCallback, useMemo, useRef, useState } from "react";
import { SITES, type Site } from "./sites";

export type Item = { tab: string } | { folder: string; name: string; open: boolean; kids: string[] } | { line: true };
export type Pair = { a: string; b: string; front: string };
export type SpaceIcon = "house" | "briefcase" | "leaf" | "sparkles";

/** Bay's theme colours, as a space's menu offers them. */
export const THEMES = [
  ["Plum", "#C07A98"],
  ["Blue", "#4691C3"],
  ["Purple", "#7873AF"],
  ["Pink", "#D37B8B"],
  ["Red", "#C1575C"],
  ["Orange", "#D87249"],
  ["Yellow", "#E3AC38"],
  ["Green", "#3EB489"],
  ["Neutral", "#8E8E93"],
] as const;

export type Space = {
  name: string;
  /** The space's glyph in the switcher, filled, in its own colour (Bay's symbolColors). */
  icon: SpaceIcon;
  /** The space's theme colour (Bay's SPACE_COLORS swatch); it tints the window. */
  theme: string;
  pins: string[];
  items: Item[];
  active: string;
  pair?: Pair | null;
  /** Hours before a tab is put away. */
  keep: number;
};

type Loc = [number, string];

export type State = {
  spaces: Space[];
  space: number;
  /** Which way the last space change went, for the rows' slide. */
  dir: -1 | 0 | 1;
  /** The space whose menu is open (a right-click on its icon). */
  menu: number | null;
  peek: string | null;
  /** The peek was there from the start, so it doesn't grow out of its link. */
  peekQuiet: boolean;
  omni: boolean;
  omniQuiet: boolean;
  panel: boolean;
  blocking: boolean;
  back: Loc[];
  fwd: Loc[];
  born: string | null;
  reloads: number;
  sites: Record<string, Site>;
  /** Hours since each tab was last looked at; shown when the preset asks. */
  ages: Record<string, number>;
  showAges: boolean;
  putAway: { id: string; space: number }[];
  leaving: string[];
  toast: string | null;
  picked: number | null;
  held: boolean;
  made: number;
};

const PERSONAL = (o: Partial<Space> = {}): Space => ({
  name: "Personal",
  icon: "house",
  theme: "#C07A98",
  pins: ["mail", "calendar", "music", "notes"],
  items: [
    { folder: "trip", name: "Lisbon trip", open: false, kids: ["flights", "hotels", "things"] },
    { line: true },
    { tab: "soup" },
    { tab: "bridges" },
    { tab: "garden" },
  ],
  active: "soup",
  keep: 168,
  ...o,
});

const WORK = (o: Partial<Space> = {}): Space => ({
  name: "Work",
  icon: "briefcase",
  theme: "#4691C3",
  pins: ["wmail", "chat", "docs", "tracker"],
  items: [
    { folder: "launch", name: "Launch", open: false, kids: ["launch", "review"] },
    { line: true },
    { tab: "prs" },
    { tab: "standup" },
    { tab: "roadmap" },
  ],
  active: "prs",
  keep: 12,
  ...o,
});

const SIDE = (o: Partial<Space> = {}): Space => ({
  name: "Side project",
  icon: "leaf",
  theme: "#3EB489",
  pins: ["local", "fonts", "mail", "music"],
  items: [{ folder: "research", name: "Research", open: false, kids: ["frame", "palette"] }, { line: true }, { tab: "issues" }, { tab: "checklist" }],
  active: "local",
  keep: 24,
  ...o,
});

type Preset = Partial<Omit<State, "spaces">> & { spaces: Space[] };

export const PRESETS = {
  hero: {
    spaces: [
      PERSONAL({
        items: [
          { folder: "trip", name: "Lisbon trip", open: true, kids: ["flights", "hotels", "things"] },
          { line: true },
          { tab: "soup" },
          { tab: "bridges" },
          { tab: "garden" },
        ],
        active: "flights",
      }),
      WORK(),
      SIDE(),
    ],
  },
  spaces: { spaces: [WORK({ active: "chat" }), PERSONAL({ active: "bridges" }), SIDE()] },
  tidy: {
    spaces: [
      WORK({
        items: [
          { folder: "launch", name: "Launch", open: false, kids: ["launch", "review"] },
          { line: true },
          { tab: "prs" },
          { tab: "standup" },
          { tab: "roadmap" },
          { tab: "thread" },
        ],
      }),
      PERSONAL(),
      SIDE(),
    ],
    showAges: true,
    ages: { prs: 0, standup: 4, roadmap: 7, thread: 10, soup: 30, bridges: 60, garden: 140, issues: 5, checklist: 15 },
  },
  folders: {
    spaces: [
      WORK({
        items: [
          { folder: "launch", name: "Launch", open: false, kids: ["launch", "review"] },
          { folder: "research", name: "Research", open: false, kids: ["frame", "palette"] },
          { line: true },
          { tab: "prs" },
          { tab: "standup" },
        ],
        active: "tracker",
      }),
      PERSONAL(),
      SIDE(),
    ],
  },
  peek: { spaces: [WORK({ active: "chat" }), PERSONAL(), SIDE()], peek: "issue", peekQuiet: true },
  split: {
    spaces: [
      WORK({
        items: [{ folder: "launch", name: "Launch", open: true, kids: ["launch"] }, { line: true }, { tab: "prs" }, { tab: "standup" }],
        active: "launch",
        pair: { a: "launch", b: "review", front: "review" },
      }),
      PERSONAL(),
      SIDE(),
    ],
  },
  privacy: {
    spaces: [PERSONAL({ items: [{ tab: "news" }, { tab: "soup" }, { tab: "garden" }, { line: true }, { tab: "bridges" }], active: "news" }), WORK(), SIDE()],
  },
  command: { spaces: [WORK({ active: "standup" }), PERSONAL(), SIDE()], omni: true, omniQuiet: true },
  card: {
    spaces: [
      PERSONAL({
        items: [{ folder: "trip", name: "Lisbon trip", open: true, kids: ["flights", "hotels"] }, { line: true }, { tab: "soup" }, { tab: "bridges" }],
        active: "flights",
      }),
      WORK(),
      SIDE(),
    ],
  },
} satisfies Record<string, Preset>;

export type PresetName = keyof typeof PRESETS;

const initial = (name: PresetName): State => ({
  space: 0,
  dir: 0,
  menu: null,
  peek: null,
  peekQuiet: false,
  omni: false,
  omniQuiet: false,
  panel: false,
  blocking: true,
  back: [],
  fwd: [],
  born: null,
  reloads: 0,
  sites: { ...SITES },
  ages: {},
  showAges: false,
  putAway: [],
  leaving: [],
  toast: null,
  picked: null,
  held: false,
  made: 0,
  ...structuredClone(PRESETS[name] as Preset),
});

// MARK: reading a space

export const tabsOf = (s: Space) => {
  const out: string[] = [];
  for (const it of s.items) {
    if ("tab" in it) out.push(it.tab);
    if ("kids" in it) out.push(...it.kids);
  }
  if (s.pair && !out.includes(s.pair.b)) out.push(s.pair.b);
  return out;
};

const has = (s: Space, id: string) => s.pins.includes(id) || tabsOf(s).includes(id);

/** Adds a tab after another, inside its folder when it's in one. */
const after = (s: Space, id: string, neu: string) => {
  for (const it of s.items)
    if ("kids" in it && it.kids.includes(id)) {
      it.kids.splice(it.kids.indexOf(id) + 1, 0, neu);
      it.open = true;
      return;
    }
  const i = s.items.findIndex((it) => "tab" in it && it.tab === id);
  if (i >= 0) s.items.splice(i + 1, 0, { tab: neu });
  else s.items.push({ tab: neu });
};

const drop = (s: Space, id: string) => {
  s.items = s.items.filter((it) => !("tab" in it) || it.tab !== id);
  for (const it of s.items) if ("kids" in it) it.kids = it.kids.filter((k) => k !== id);
};

// MARK: the hook every working window runs on

export function useBay(name: PresetName) {
  const [s, setS] = useState(() => initial(name));
  const [touched, setTouched] = useState(false);
  const timers = useRef<number[]>([]);

  const mut = useCallback(
    (fn: (n: State) => void) =>
      setS((prev) => {
        const n = structuredClone(prev);
        fn(n);
        return n;
      }),
    [],
  );
  const later = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const actions = useMemo(() => {
    const where = (n: State): Loc => [n.space, n.spaces[n.space].active];
    const goIn = (n: State, id: string) => {
      const sp = n.spaces[n.space];
      if (sp.active === id && !n.peek) return;
      n.back.push(where(n));
      n.fwd = [];
      sp.active = id;
      n.peek = null;
      n.panel = false;
      n.held = false;
      n.picked = null;
      if (n.ages[id] !== undefined) n.ages[id] = 0;
    };
    const toSpaceIn = (n: State, to: number) => {
      const count = n.spaces.length;
      const next = ((to % count) + count) % count;
      n.menu = null;
      if (next === n.space) return;
      n.back.push(where(n));
      n.fwd = [];
      n.dir = (next - n.space + count) % count === 1 ? 1 : -1;
      n.space = next;
      n.peek = null;
      n.panel = false;
    };

    return {
      touch: () => setTouched(true),
      reset: () => {
        timers.current.forEach(clearTimeout);
        timers.current = [];
        setS(initial(name));
        setTouched(false);
      },
      go: (id: string) => mut((n) => goIn(n, id)),
      toSpace: (to: number) => mut((n) => toSpaceIn(n, to)),
      step: (by: 1 | -1) => mut((n) => toSpaceIn(n, n.space + by)),
      menu: (i: number | null) =>
        mut((n) => {
          n.menu = i;
        }),
      theme: (i: number, color: string) =>
        mut((n) => {
          n.spaces[i].theme = color;
          n.menu = null;
        }),
      /** + in the switcher: a new space with one blank tab, shown at once. */
      newSpace: () =>
        mut((n) => {
          const id = `n${++n.made}`;
          n.sites[id] = { title: "New Tab", host: "", glyph: "globe", tint: "#8e8e93", body: { kind: "blank" } };
          n.spaces.push({ name: `Space ${n.spaces.length + 1}`, icon: "sparkles", theme: "#7873AF", pins: [], items: [{ tab: id }], active: id, keep: 24 });
          n.back.push(where(n));
          n.dir = 1;
          n.space = n.spaces.length - 1;
          n.peek = null;
          n.panel = false;
          n.menu = null;
        }),
      deleteSpace: (i: number) =>
        mut((n) => {
          if (n.spaces.length < 2) return;
          n.spaces.splice(i, 1);
          n.back = [];
          n.fwd = [];
          n.dir = 0;
          n.space = Math.min(n.space > i ? n.space - 1 : n.space, n.spaces.length - 1);
          n.menu = null;
        }),
      fold: (id: string) =>
        mut((n) => {
          const it = n.spaces[n.space].items.find((x) => "folder" in x && x.folder === id);
          if (it && "folder" in it) it.open = !it.open;
        }),
      close: (id: string) =>
        mut((n) => {
          const sp = n.spaces[n.space];
          const order = tabsOf(sp);
          const i = order.indexOf(id);
          drop(sp, id);
          if (sp.active === id) sp.active = tabsOf(sp)[Math.min(i, tabsOf(sp).length - 1)] ?? sp.pins[0];
        }),
      nav: (way: "back" | "fwd" | "reload") =>
        mut((n) => {
          if (way === "reload") {
            n.reloads++;
            return;
          }
          const from = way === "back" ? n.back : n.fwd,
            to = way === "back" ? n.fwd : n.back;
          const loc = from.pop();
          if (!loc) return;
          to.push(where(n));
          n.dir = 0;
          n.space = loc[0];
          n.spaces[n.space].active = loc[1];
          n.peek = null;
        }),

      peek: (to: string) =>
        mut((n) => {
          n.peek = to;
          n.peekQuiet = false;
          n.panel = false;
        }),
      unpeek: () =>
        mut((n) => {
          n.peek = null;
        }),
      peekToTab: () =>
        mut((n) => {
          const to = n.peek;
          if (!to) return;
          const sp = n.spaces[n.space];
          if (!has(sp, to)) after(sp, sp.active, to);
          n.born = to;
          goIn(n, to);
        }),
      peekToSplit: () =>
        mut((n) => {
          const to = n.peek;
          if (!to) return;
          const sp = n.spaces[n.space];
          drop(sp, to);
          sp.pair = { a: sp.active, b: to, front: to };
          n.peek = null;
        }),
      front: (id: string) =>
        mut((n) => {
          const sp = n.spaces[n.space];
          if (!sp.pair) return;
          sp.pair.front = id;
          sp.active = sp.pair.a;
          n.peek = null;
        }),
      separate: (id: string) =>
        mut((n) => {
          const sp = n.spaces[n.space];
          const p = sp.pair;
          if (!p) return;
          sp.pair = null;
          if (!tabsOf(sp).includes(p.b)) after(sp, p.a, p.b);
          sp.active = p.a === id ? p.b : p.a;
        }),

      omni: (on: boolean) =>
        mut((n) => {
          n.omni = on;
          n.omniQuiet = false;
          n.menu = null;
          n.panel = false;
        }),
      /** A new tab from the command bar: an address, or a search. */
      open: (q: string, search: boolean) =>
        mut((n) => {
          const id = `n${++n.made}`;
          const host = q
            .replace(/^https?:\/\//, "")
            .replace(/\/.*$/, "")
            .replace(/^www\./, "");
          const word = host.split(".")[0];
          n.sites[id] = search
            ? { title: q, host: "search.example", glyph: "search", tint: "#8e8e93", body: { kind: "search", q } }
            : {
                title: word.charAt(0).toUpperCase() + word.slice(1),
                host,
                glyph: "globe",
                tint: "#5b6b7f",
                body: { kind: "doc", kicker: host, title: `Welcome to ${host}` },
              };
          n.spaces[n.space].items.push({ tab: id });
          n.born = id;
          n.omni = false;
          goIn(n, id);
        }),
      openSite: (id: string) =>
        mut((n) => {
          const sp = n.spaces[n.space];
          if (!has(sp, id)) {
            sp.items.push({ tab: id });
            n.born = id;
          }
          n.omni = false;
          goIn(n, id);
        }),
      restore: (id: string) =>
        mut((n) => {
          const kept = n.putAway.find((p) => p.id === id);
          n.putAway = n.putAway.filter((p) => p.id !== id);
          const sp = n.spaces[kept?.space ?? n.space];
          if (!tabsOf(sp).includes(id)) sp.items.push({ tab: id });
          if (kept) n.space = kept.space;
          n.born = id;
          n.omni = false;
          n.ages[id] = 0;
          goIn(n, id);
        }),

      panel: (open?: boolean) =>
        mut((n) => {
          n.panel = open ?? !n.panel;
          n.menu = null;
        }),
      block: () =>
        mut((n) => {
          n.blocking = !n.blocking;
        }),
      pick: (i: number) =>
        mut((n) => {
          n.picked = i;
        }),
      hold: () =>
        mut((n) => {
          n.held = true;
        }),

      /** Tidy: time passes; tabs past their space's limit leave, then are put away. */
      skip: (hours: number) => {
        mut((n) => {
          const sp = n.spaces[n.space];
          for (const id of tabsOf(sp)) {
            if (id === sp.active) continue;
            n.ages[id] = (n.ages[id] ?? 0) + hours;
          }
          n.leaving = sp.items.flatMap((it) => ("tab" in it && it.tab !== sp.active && (n.ages[it.tab] ?? 0) >= sp.keep ? [it.tab] : []));
        });
        later(420, () =>
          mut((n) => {
            const sp = n.spaces[n.space];
            const leaving = n.leaving;
            if (!leaving.length) return;
            leaving.forEach((id) => drop(sp, id));
            n.putAway.push(...leaving.map((id) => ({ id, space: n.space })));
            n.toast = `${leaving.length} ${leaving.length === 1 ? "tab" : "tabs"} put away. New tab finds ${leaving.length === 1 ? "it" : "them"}.`;
            n.leaving = [];
          }),
        );
        later(3600, () =>
          mut((n) => {
            n.toast = null;
          }),
        );
      },
      keep: (hours: number) =>
        mut((n) => {
          n.spaces[n.space].keep = hours;
        }),
    };
  }, [mut, name]);

  return { s, touched, ...actions };
}

export type Bay = ReturnType<typeof useBay>;
