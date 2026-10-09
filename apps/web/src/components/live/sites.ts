// Everything a working window can show: each site's row, its mark and its page.

export type Body =
  | { kind: "doc"; kicker: string; title: string }
  | { kind: "list"; kicker: string; title: string; rows: string[] }
  | { kind: "flights" }
  | { kind: "video"; title: string }
  | { kind: "dev"; title: string }
  | { kind: "news"; title: string }
  | { kind: "search"; q: string }
  | { kind: "blank" };

export type Site = {
  title: string;
  host: string;
  glyph: string;
  tint: string;
  body: Body;
  /** The site its page links to, opened in Peek. */
  link?: string;
  /** How a link to this site reads on another page. */
  linkText?: string;
};

const doc = (kicker: string, title: string): Body => ({ kind: "doc", kicker, title });
const list = (kicker: string, title: string, rows: string[]): Body => ({ kind: "list", kicker, title, rows });

export const SITES: Record<string, Site> = {
  mail: { title: "Inbox", host: "mail.example", glyph: "mail", tint: "#3b82f6",
    body: list("Inbox", "Three new messages", ["Kiln studio: Tuesday works", "Your Lisbon itinerary", "Dana: the grant draft"]) },
  calendar: { title: "Calendar", host: "calendar.example", glyph: "calendar", tint: "#ef4444", body: doc("Calendar", "Tuesday, 14 May") },
  music: { title: "Music", host: "music.example", glyph: "music", tint: "#f43f5e", body: { kind: "video", title: "Late night, slow songs" } },
  notes: { title: "Notes", host: "notes.example", glyph: "note", tint: "#f59e0b", body: doc("Notes", "Packing list"), link: "things" },

  flights: { title: "Flights", host: "flights.example", glyph: "plane", tint: "#14b8a6", body: { kind: "flights" }, link: "hotels" },
  hotels: { title: "Hotels in Alfama", host: "stays.example", glyph: "bed", tint: "#e8663f",
    body: list("stays.example", "Hotels in Alfama", ["Casa do Rio · 4.8", "Pátio 13 · 4.7", "Miradouro Rooms · 4.6"]), linkText: "Hotels near the river" },
  things: { title: "Things to do", host: "lisbon.example", glyph: "star", tint: "#eab308",
    body: list("lisbon.example", "Things to do in Lisbon", ["Tram 28, end to end", "Belém at sunset", "A fado night in Alfama"]), linkText: "Things to do in Lisbon" },
  soup: { title: "Mum’s soup, with nutmeg", host: "recipes.example", glyph: "bowl", tint: "#ea580c", body: doc("recipes.example", "Mum’s soup, with nutmeg"), link: "garden" },
  bridges: { title: "How bridges hold up", host: "video.example", glyph: "play", tint: "#dc2626", body: { kind: "video", title: "How bridges hold up" } },
  garden: { title: "Balcony herbs", host: "garden.example", glyph: "leaf", tint: "#16a34a", body: doc("garden.example", "Balcony herbs that survive"), linkText: "Herbs that survive a balcony" },

  wmail: { title: "Inbox", host: "mail.example", glyph: "mail", tint: "#3b82f6",
    body: list("Work", "Inbox", ["Launch notes, final pass", "Q4 roadmap review moved", "Welcome, new teammates"]) },
  chat: { title: "Chat", host: "chat.example", glyph: "chat", tint: "#7c3aed",
    body: list("chat.example", "#design", ["Read the full spec on the tracker", "Sidebar spacing looks right now", "Ship it Friday?"]), link: "issue" },
  docs: { title: "Docs", host: "docs.example", glyph: "doc", tint: "#2563eb", body: doc("docs.example", "All documents") },
  tracker: { title: "Tracker", host: "tracker.example", glyph: "diamond", tint: "#6366f1",
    body: list("tracker.example", "This cycle", ["BAY-214 Peek keeps its scroll", "BAY-219 Split from a folder", "BAY-231 Space swipe"]), link: "issue" },
  issue: { title: "BAY-214", host: "tracker.example/issue/BAY-214", glyph: "diamond", tint: "#6366f1",
    body: doc("BAY-214", "Peek keeps its scroll"), linkText: "Read the full spec on the tracker", link: "launch" },
  launch: { title: "Launch notes", host: "docs.example/launch-notes", glyph: "doc", tint: "#2563eb", body: doc("Docs", "Launch notes"),
    link: "review", linkText: "Launch notes" },
  review: { title: "Design review", host: "design.example/review", glyph: "pen", tint: "#db2777", body: doc("Design", "Welcome screens"),
    link: "launch", linkText: "The welcome screens" },
  prs: { title: "Pull requests", host: "code.example/pulls", glyph: "code", tint: "#334155",
    body: list("code.example", "Pull requests", ["feat(spaces): tabs belong to their space", "fix(peek): keep the scroll", "perf: open windows faster"]), link: "issue" },
  standup: { title: "Standup notes", host: "docs.example/standup", glyph: "doc", tint: "#2563eb", body: doc("Docs", "Standup, Thursday"), link: "roadmap" },
  roadmap: { title: "Q4 roadmap", host: "docs.example/q4", glyph: "doc", tint: "#2563eb", body: doc("Docs", "Q4 roadmap"), linkText: "the Q4 roadmap" },
  thread: { title: "Old thread about fonts", host: "chat.example/t/fonts", glyph: "chat", tint: "#7c3aed", body: doc("chat.example", "Which serif, again?") },

  local: { title: "localhost:4321", host: "localhost:4321", glyph: "code", tint: "#0f172a", body: { kind: "dev", title: "A tiny weather app." } },
  fonts: { title: "Fonts", host: "type.example", glyph: "type", tint: "#0f766e", body: doc("type.example", "Fonts for headlines"), link: "palette" },
  palette: { title: "Color palettes", host: "palette.example", glyph: "palette", tint: "#a855f7", body: doc("palette.example", "Warm palettes"), linkText: "Warm palettes" },
  frame: { title: "Framework docs", host: "docs.example/framework", glyph: "doc", tint: "#ea580c", body: doc("Docs", "Islands, explained"), link: "fonts" },
  issues: { title: "Open issues", host: "code.example/issues", glyph: "code", tint: "#334155",
    body: list("code.example", "Open issues", ["Dark mode flashes on load", "Add a sitemap", "Footer links wrap on phones"]), link: "frame" },
  checklist: { title: "Launch checklist", host: "notes.example/launch", glyph: "check", tint: "#f59e0b", body: doc("Notes", "Launch checklist") },

  news: { title: "The Daily Example", host: "news.example", glyph: "news", tint: "#111827", body: { kind: "news", title: "The best browsers of the year" }, link: "garden" },
};

/** Each mark's drawing: white strokes on the site's tint (play is filled). */
export const ICONS: Record<string, string> = {
  mail: "M4 6.5h16v11H4zM4.5 7l7.5 6 7.5-6",
  calendar: "M5 6h14v13H5zM5 10h14M9 4v4M15 4v4",
  music: "M9 17V6l10-2v11M9 17a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 15a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
  note: "M6 4h9l3 3v13H6zM9 11h6M9 15h6",
  plane: "M3.5 13L20 6l-6.5 16-2.6-6.4z",
  bed: "M3 18V7M3 14h18v4M21 14v-1.5A3.5 3.5 0 0 0 17.5 9H11v5M7 12a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  star: "M12 4l2.4 5 5.6.6-4.2 3.8 1.2 5.6L12 16.2 7 19l1.2-5.6L4 9.6 9.6 9z",
  bowl: "M4 11h16a8 8 0 0 1-16 0zM9.5 4.5c-1 1 1 2 0 3M14.5 4.5c-1 1 1 2 0 3",
  play: "M8 5.5v13l10.5-6.5z",
  leaf: "M5 19C5 11 11 5 19 5c0 8-6 14-14 14zM5 19l7-7",
  chat: "M5 5h14v10h-8l-4 4v-4H5z",
  doc: "M7 3.5h7l4 4V20.5H7zM14 3.5v4h4M10 12h5M10 16h5",
  diamond: "M12 3.5l8.5 8.5-8.5 8.5L3.5 12z",
  pen: "M4.5 19.5l4-1 10.5-10.5-3-3L5.5 15.5zM14 7l3 3",
  code: "M9 7.5L4.5 12 9 16.5M15 7.5l4.5 4.5-4.5 4.5",
  type: "M4 18l4.5-12h1L14 18M5.5 14h7M16 11.5c.6-.8 1.4-1 2.2-1 1.6 0 2.3.8 2.3 2.4V18M20.5 14.5c-3.5 0-4.5.8-4.5 2 0 .9.7 1.5 1.8 1.5 1.6 0 2.7-1.2 2.7-3.5",
  palette: "M12 3.5a8.5 8.5 0 1 0 0 17c1 0 1.5-.7 1.5-1.4 0-1.1-.9-1.4-.9-2.3 0-.8.6-1.3 1.4-1.3h2a4.5 4.5 0 0 0 4.5-4.5c0-4.1-3.8-7.5-8.5-7.5zM7.5 12h.01M9.5 8h.01M14.5 8h.01",
  news: "M4 5.5h13V19H6.5A2.5 2.5 0 0 1 4 16.5zM17 9h3v7.5a2.5 2.5 0 0 1-2.5 2.5M7.5 9h6M7.5 12.5h6M7.5 16h4",
  check: "M5 7.5l2 2 3.5-3.5M5 15.5l2 2 3.5-3.5M13.5 8.5h5.5M13.5 16.5h5.5",
  globe: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM3.5 12h17M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17",
  search: "M11 17.5a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zM16 16l4 4",
};

/** Sites the command bar offers before you type. */
export const FREQUENT = ["news", "docs", "prs"];
