export type Bang = { trigger: string; name: string; template: string; home: string };

export type BangTable = { size: number; get(trigger: string): Bang | undefined };

export type BangMatch = { bang: Bang; query: string; url: string };

export const BANG_PLACEHOLDER = "{searchTerms}";
const STORED_PLACEHOLDER = "{s}";
const MIN_BANGS = 1000;
export const MAX_BANG_LIST_CHARS = 4_000_000;
const REQUIRED_TRIGGERS = ["gh", "w", "yt"];
const BANG_DOCUMENT = "bay-bangs 1";

function endOfString(text: string, from: number): number {
  let at = from;
  for (;;) {
    const quote = text.indexOf('"', at);
    if (quote < 0) return text.length;
    let slashes = 0;
    while (text.charCodeAt(quote - 1 - slashes) === 92) slashes++;
    if (slashes % 2 === 0) return quote + 1;
    at = quote + 1;
  }
}

function skipBlank(text: string, from: number): number {
  let at = from;
  for (;;) {
    while (at < text.length && /\s/.test(text[at]!)) at++;
    if (text.startsWith("//", at)) {
      const end = text.indexOf("\n", at);
      at = end < 0 ? text.length : end;
    } else if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2);
      at = end < 0 ? text.length : end + 2;
    } else return at;
  }
}

export function parseLooseJson(text: string): unknown {
  const parts: string[] = [];
  const special = /["/,]/g;
  let from = 0;
  for (let m = special.exec(text); m; m = special.exec(text)) {
    const at = m.index;
    const c = m[0];
    if (c === '"') {
      special.lastIndex = endOfString(text, at + 1);
    } else if (c === "/") {
      const next = text[at + 1];
      if (next !== "/" && next !== "*") continue;
      parts.push(text.slice(from, at));
      const end = next === "/" ? text.indexOf("\n", at) : text.indexOf("*/", at + 2);
      from = end < 0 ? text.length : next === "/" ? end : end + 2;
      special.lastIndex = from;
    } else {
      const close = text[skipBlank(text, at + 1)];
      if (close === "]" || close === "}") {
        parts.push(text.slice(from, at));
        from = at + 1;
      }
    }
  }
  parts.push(text.slice(from));
  return JSON.parse(parts.join(""));
}

const VALID_TEMPLATE = /^https?:\/\/(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::\d+)?(?:[/?#]\S*)?$/i;
const ORIGIN = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\\]*)/i;

export const isValidBangTemplate = (template: string) => VALID_TEMPLATE.test(template);

export function staysOnSite(url: string, template: string): boolean {
  const to = ORIGIN.exec(url);
  const from = ORIGIN.exec(template);
  // Control characters can change how the browser parses the destination URL.
  // eslint-disable-next-line no-control-regex
  if (!to || !from || !from[2] || /[\s\x00-\x1f\x7f]/.test(url)) return false;
  return to[1]!.toLowerCase() === from[1]!.toLowerCase() && to[2]!.toLowerCase() === from[2].toLowerCase();
}

const expandTemplate = (stored: string) => (/^https?:\/\//i.test(stored) ? stored : `https://${stored}`).split(STORED_PLACEHOLDER).join(BANG_PLACEHOLDER);

export function slimBangs(json: string): string | null {
  let list: unknown;
  try {
    list = parseLooseJson(json);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of list as unknown[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { s, ts, u } = entry as Record<string, unknown>;
    if (typeof s !== "string" || !Array.isArray(ts) || typeof u !== "string") continue;
    if (!isValidBangTemplate(u) || u.includes(STORED_PLACEHOLDER)) continue;
    const name = s.replace(/\s+/g, " ").trim();
    if (!name) continue;
    const triggers: string[] = [];
    for (const t of ts) {
      if (typeof t !== "string") continue;
      const trigger = t.trim().toLowerCase();
      if (!trigger || /[\s!]/.test(trigger) || seen.has(trigger)) continue;
      seen.add(trigger);
      triggers.push(trigger);
    }
    if (!triggers.length) continue;
    const stored = u
      .replace(/^https:\/\//i, "")
      .split(BANG_PLACEHOLDER)
      .join(STORED_PLACEHOLDER);
    lines.push(`${triggers.join(" ")}\t${name}\t${stored}`);
  }
  return lines.length >= MIN_BANGS ? lines.join("\n") : null;
}

function homeOf(template: string): string {
  const origin = /^https?:\/\/[^/?#]+/i.exec(template)?.[0];
  return origin ? `${origin}/` : template;
}

function indexTriggers(slim: string): Map<string, number> {
  const lines = new Map<string, number>();
  for (let at = 0; at < slim.length;) {
    let end = slim.indexOf("\n", at);
    if (end < 0) end = slim.length;
    const tab = slim.indexOf("\t", at);
    if (tab > at && tab < end) {
      for (let from = at; from < tab;) {
        const space = slim.indexOf(" ", from);
        const stop = space < 0 || space > tab ? tab : space;
        const trigger = slim.slice(from, stop);
        if (trigger && !lines.has(trigger)) lines.set(trigger, at);
        from = stop + 1;
      }
    }
    at = end + 1;
  }
  return lines;
}

export function bangTable(slim: string): BangTable {
  const lines = indexTriggers(slim);
  const parsed = new Map<string, Bang | null>();
  const get = (trigger: string): Bang | undefined => {
    const key = trigger.toLowerCase();
    const cached = parsed.get(key);
    if (cached !== undefined) return cached ?? undefined;
    const at = lines.get(key);
    let bang: Bang | null = null;
    if (at !== undefined) {
      const end = slim.indexOf("\n", at);
      const [, name = "", stored = ""] = slim.slice(at, end < 0 ? slim.length : end).split("\t");
      const template = expandTemplate(stored);
      if (name && isValidBangTemplate(template)) bang = { trigger: key, name, template, home: homeOf(template) };
    }
    parsed.set(key, bang);
    return bang ?? undefined;
  };
  return { size: lines.size, get };
}

export function checkedBangTable(slim: string): BangTable | null {
  if (slim.length > MAX_BANG_LIST_CHARS) return null;
  let count = 0;
  for (const line of slim.split("\n")) {
    const [triggers, name, stored, extra] = line.split("\t");
    if (!triggers || !name || !stored || extra !== undefined || !/^[^\s!]+(?: [^\s!]+)*$/.test(triggers)) return null;
    if (!isValidBangTemplate(expandTemplate(stored))) return null;
    count++;
  }
  if (count < MIN_BANGS) return null;
  const table = bangTable(slim);
  return REQUIRED_TRIGGERS.every((t) => table.get(t)) ? table : null;
}

export const bangDocument = (etag: string | null, slim: string) => `${BANG_DOCUMENT}\t${etag ?? ""}\n${slim}`;

export function readBangDocument(doc: string | null | undefined): { etag: string | null; table: BangTable } | null {
  if (!doc || doc.length > MAX_BANG_LIST_CHARS + 1024) return null;
  const firstLine = doc.indexOf("\n");
  if (firstLine < 0) return null;
  const [magic, etag = "", extra] = doc.slice(0, firstLine).split("\t");
  if (magic !== BANG_DOCUMENT || extra !== undefined) return null;
  const table = checkedBangTable(doc.slice(firstLine + 1));
  return table ? { etag: etag || null, table } : null;
}

export function joinBangTables(tables: readonly BangTable[]): BangTable {
  return {
    size: tables.reduce((n, t) => n + t.size, 0),
    get: (trigger) => {
      for (const t of tables) {
        const bang = t.get(trigger);
        if (bang) return bang;
      }
      return undefined;
    },
  };
}

// Search settings use Chromium's %s templates for both Tab shortcuts and bangs.
export function customBangTable(engines: readonly { name: string; keyword: string; url: string }[]): BangTable {
  const lines: string[] = [];
  for (const engine of engines) {
    const trigger = engine.keyword.trim().replace(/^!/, "").toLowerCase();
    const name = engine.name.replace(/\s+/g, " ").trim();
    const template = engine.url.trim().split("%s").join(BANG_PLACEHOLDER);
    if (!trigger || /[\s!]/.test(trigger) || !name || !engine.url.includes("%s") || !isValidBangTemplate(template)) continue;
    lines.push(`${trigger}\t${name}\t${template}`);
  }
  return bangTable(lines.join("\n"));
}

export function findBang(text: string, table: BangTable | null | undefined): BangMatch | null {
  if (!table || !text.includes("!") || text.trimStart().startsWith("?")) return null;
  const words = text.trim().split(/\s+/);
  const last = words.length - 1;
  for (const at of last > 0 ? [0, last] : [0]) {
    const word = words[at]!;
    if (word.length < 2 || word[0] !== "!") continue;
    const bang = table.get(word.slice(1));
    if (!bang) continue;
    const query = words.filter((_, i) => i !== at).join(" ");
    const url = query ? fillBangTemplate(bang.template, query) : bang.home;
    if (staysOnSite(url, bang.template)) return { bang, query, url };
  }
  return null;
}

function wellFormed(text: string): string {
  return Array.from(text, (c) => (c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff ? "�" : c)).join("");
}

const PATH_UNSAFE = /[^\x21-\x7e]+|["#%:<>?[\\\]^`{|}]/g;

export function escapeSearchTerms(terms: string, inQuery: boolean): string {
  const text = wellFormed(terms);
  return inQuery ? encodeURIComponent(text).replace(/%20/g, "+") : text.replace(PATH_UNSAFE, (m) => encodeURIComponent(m));
}

export function fillBangTemplate(template: string, terms: string): string {
  const at = template.indexOf(BANG_PLACEHOLDER);
  if (at < 0) return template;
  const question = template.indexOf("?");
  const escaped = escapeSearchTerms(terms, question >= 0 && at > question);
  return template.split(BANG_PLACEHOLDER).join(escaped);
}
