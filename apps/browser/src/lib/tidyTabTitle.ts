import { tidyHost } from "../store/groupNames";

// Separators sites put between the page name and the site name in a tab title
// (Arc's and our group namer use the same set).
const SEPARATORS = [" / ", " | ", " - ", " — ", " – ", " · ", " • ", " :: ", ": "];

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// A short name for a pinned tab, derived from its title (and, when available,
// its host). Returns null when no shorter name can be found, so the caller
// leaves the title as it is. Mirrors Arc's "Tidy Tab Titles": "Inbox – Gmail"
// becomes "Gmail". The original title is still recoverable via Reset Name,
// because this only ever sets `customTitle`.
export function tidyTabTitle(title: string, url: string = ""): string | null {
  const t = (title || "").trim();
  if (!t || t === url) return null;

  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    host = "";
  }
  const brand = host ? tidyHost(host) : "";
  const brandSquash = brand ? squash(brand) : "";

  // Generic page/section words: when one side of a title is one of these, the
  // other side is almost always the site or product name (Arc's "Inbox – Gmail").
  const GENERIC = new Set([
    "inbox",
    "home",
    "dashboard",
    "settings",
    "profile",
    "account",
    "search",
    "new",
    "untitled",
    "loading",
    "overview",
    "notifications",
    "messages",
  ]);

  // Collect every piece a separator splits the title into.
  const pieces: string[] = [];
  for (const sep of SEPARATORS) {
    const last = t.lastIndexOf(sep);
    if (last > 0) {
      pieces.push(t.slice(0, last).trim(), t.slice(last + sep.length).trim());
    }
    const first = t.indexOf(sep);
    if (first > 0 && first !== last) {
      pieces.push(t.slice(0, first).trim(), t.slice(first + sep.length).trim());
    }
  }

  // Prefer the piece that matches the host's brand.
  if (brandSquash) {
    for (const c of pieces) {
      if (!c || c === t) continue;
      const cs = squash(c);
      if (!cs) continue;
      const matches = cs === brandSquash || (cs.length >= 3 && (brandSquash.includes(cs) || cs.includes(brandSquash)));
      if (matches && c.length < t.length) return c;
    }
  }

  // If one side is a generic page word, the other side is the name.
  for (const sep of SEPARATORS) {
    const idx = t.lastIndexOf(sep);
    if (idx <= 0) continue;
    const a = t.slice(0, idx).trim();
    const b = t.slice(idx + sep.length).trim();
    if (a && b && a !== t && b !== t) {
      const aGen = GENERIC.has(squash(a));
      const bGen = GENERIC.has(squash(b));
      if (aGen && !bGen) return b;
      if (bGen && !aGen) return a;
    }
  }

  // Fallback: the shorter side of a separator split, when it is meaningfully
  // shorter. On a tie, prefer the right-hand side (the common "Page – Site"
  // convention), which is why candidates are tried right side first.
  let best: string | null = null;
  for (const sep of SEPARATORS) {
    const idx = t.lastIndexOf(sep);
    if (idx <= 0) continue;
    const a = t.slice(0, idx).trim();
    const b = t.slice(idx + sep.length).trim();
    for (const c of [b, a]) {
      if (!c || c === t) continue;
      if (c.length <= 24 && c.length < t.length - 2) {
        if (!best || c.length < best.length) best = c;
      }
    }
  }
  return best;
}
