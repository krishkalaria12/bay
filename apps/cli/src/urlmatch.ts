// Chrome match patterns and URL globs, matching the rules Chrome's content scripts use: `*` in a pattern's path is
// any run of characters, `?` is literal (before unescaping), hosts compare IDNA-canonicalised, and `%XX` is compared
// both as written and as decoded UTF-8 where Chrome would decode it.
import { domainToASCII } from "node:url";

const SENTINEL = -1;
const STAR = 42;
const QUESTION = 63;
const BACKSLASH = 92;
const SCRIPT_SCHEMES = ["http", "https", "file", "ftp"];
const WILDCARD_SCHEMES = ["http", "https"];
const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443", ftp: "21" };
const UNESCAPED_ASCII = new Set<number>(Array.from('"-<>_~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (char) => char.charCodeAt(0)));
const BANNED_RANGES: Array<[number, number]> = [
  [0x0085, 0x0085],
  [0x00a0, 0x00a0],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x0600, 0x0605],
  [0x061c, 0x061c],
  [0x06dd, 0x06dd],
  [0x070f, 0x070f],
  [0x08e2, 0x08e2],
  [0x115f, 0x1160],
  [0x1680, 0x1680],
  [0x17b4, 0x17b5],
  [0x180b, 0x180e],
  [0x2000, 0x200f],
  [0x2028, 0x202f],
  [0x205f, 0x206f],
  [0x2800, 0x2800],
  [0x3000, 0x3000],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0x110bd, 0x110bd],
  [0x110cd, 0x110cd],
  [0x13430, 0x13438],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0x1f50f, 0x1f510],
  [0x1f512, 0x1f513],
  [0xe0000, 0xe0fff],
];
const IDNA_DEVIATIONS = new Set(["\u00df", "\u03c2", "\u200c", "\u200d"]);
const LABEL = /^[a-z0-9_-]+$/;
const HEX = /^[0-9a-fA-F]+$/;

export class PatternError extends Error {
  override name = "PatternError";
}

export type MatchPattern = {
  all: boolean;
  schemes: string[];
  host: string;
  sub: boolean;
  port: string;
  file: boolean;
  raw: number[];
  utf8: number[];
  utf8Bytes: number[];
};

export type SplitUrl = { scheme: string; host: string; port: string; path: string };

const encoder = new TextEncoder();

function leadLength(byte: number): number {
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 0;
}

function firstChar(data: Uint8Array, offset = 0): { point: number; size: number } | null {
  if (offset >= data.length) return null;
  const first = data[offset]!;
  if (first < 0x80) return { point: first, size: 1 };
  const size = leadLength(first);
  if (!size || data.length - offset < size) return null;
  const text = new TextDecoder().decode(data.subarray(offset, offset + size));
  if (!text || [...text].length !== 1) return null;
  const point = text.codePointAt(0);
  return point === undefined ? null : { point, size };
}

export function decode(data: Uint8Array): number[] {
  const points: number[] = [];
  let index = 0;
  while (index < data.length) {
    const found = firstChar(data.subarray(index, index + 4));
    if (!found) {
      points.push(SENTINEL);
      index += 1;
    } else {
      points.push(found.point);
      index += found.size;
    }
  }
  return points;
}

function escapedByte(data: Uint8Array, index: number): number | null {
  if (index + 2 >= data.length || data[index] !== 0x25) return null;
  const digits = new TextDecoder().decode(data.subarray(index + 1, index + 3));
  if (!HEX.test(digits)) return null;
  return Number.parseInt(digits, 16);
}

function shouldUnescape(point: number): boolean {
  if (point < 0x80) return UNESCAPED_ASCII.has(point);
  return !BANNED_RANGES.some(([low, high]) => point >= low && point <= high);
}

export function unescape(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let index = 0;
  while (index < data.length) {
    const first = escapedByte(data, index);
    let found: { point: number; size: number } | null = null;
    if (first !== null) {
      const collected = [first];
      if (first >= 0xc2 && first <= 0xf4) {
        while (collected.length < 4) {
          const trail = escapedByte(data, index + collected.length * 3);
          if (trail === null || trail < 0x80 || trail > 0xbf) break;
          collected.push(trail);
        }
      }
      found = firstChar(Uint8Array.from(collected));
    }
    if (!found) {
      if (first !== null) {
        out.push(first);
        index += 3;
      } else {
        out.push(data[index]!);
        index += 1;
      }
      continue;
    }
    if (!shouldUnescape(found.point)) {
      for (let step = 0; step < 3 * found.size; step += 1) out.push(data[index + step]!);
    } else {
      for (const byte of encoder.encode(String.fromCodePoint(found.point))) out.push(byte);
    }
    index += 3 * found.size;
  }
  return Uint8Array.from(out);
}

function search(pattern: number[], p: number, string: number[], s: number, distance: number): { ok: boolean; p: number; s: number } {
  const pStart = p;
  let sStart = s;
  let escape = false;
  while (true) {
    let mismatch = false;
    if (p === pattern.length) {
      if (s === string.length) return { ok: true, p, s };
      mismatch = true;
    } else {
      const char = pattern[p]!;
      if (!escape && (char === STAR || char === QUESTION)) return { ok: true, p, s };
      if (!escape && char === BACKSLASH) {
        escape = true;
        p += 1;
        continue;
      }
      escape = false;
      if (s === string.length) return { ok: false, p, s };
      if (char === string[s] && char !== SENTINEL) {
        p += 1;
        s += 1;
        continue;
      }
      mismatch = true;
    }
    if (mismatch) {
      if (distance === 0) return { ok: false, p, s };
      distance -= 1;
      p = pStart;
      sStart += 1;
      s = sStart;
    }
  }
}

export function matchPattern(string: number[], pattern: number[]): boolean {
  let p = 0;
  let s = 0;
  while (true) {
    let stars = false;
    let questions = 0;
    while (p < pattern.length && (pattern[p] === STAR || pattern[p] === QUESTION)) {
      stars = stars || pattern[p] === STAR;
      questions += pattern[p] === QUESTION ? 1 : 0;
      p += 1;
    }
    const found = search(pattern, p, string, s, stars ? -1 : questions);
    if (!found.ok) return false;
    p = found.p;
    s = found.s;
    if (p === pattern.length) return true;
  }
}

function ipv4Part(text: string): number | null {
  let digits = text;
  let base = 10;
  if (text.slice(0, 2) === "0x" || text.slice(0, 2) === "0X") {
    digits = text.slice(2);
    base = 16;
  } else if (text.length > 1 && text.startsWith("0")) {
    digits = text.slice(1);
    base = 8;
  }
  if (digits === "") return base !== 10 ? 0 : null;
  if (!(base === 16 ? /^[0-9a-fA-F]+$/ : base === 8 ? /^[0-7]+$/ : /^[0-9]+$/).test(digits)) return null;
  const value = Number.parseInt(digits, base);
  return Number.isNaN(value) ? null : value;
}

function ipv4(host: string): string | null {
  let parts = host.split(".");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts = parts.slice(0, -1);
  const last = parts[parts.length - 1];
  if (last === undefined) return null;
  if (!/^[0-9]+$/.test(last) && !(last.slice(0, 2).toLowerCase() === "0x" && HEX.test(last.slice(2)))) return null;
  if (parts.length > 4) throw new PatternError("not a valid IPv4 address");
  const numbers = parts.map(ipv4Part);
  if (numbers.some((number) => number === null) || numbers.slice(0, -1).some((number) => number! > 255)) throw new PatternError("not a valid IPv4 address");
  const tail = numbers[numbers.length - 1]!;
  if (tail >= 256 ** (5 - numbers.length)) throw new PatternError("not a valid IPv4 address");
  let value = tail;
  numbers.slice(0, -1).forEach((number, index) => {
    value += number! * 256 ** (3 - index);
  });
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function idna(host: string): string {
  const labels: string[] = [];
  for (const label of host.split(".")) {
    if (/^[\x00-\x7f]*$/.test(label)) {
      labels.push(label.toLowerCase());
      continue;
    }
    if ([...label].some((char) => IDNA_DEVIATIONS.has(char))) {
      throw new PatternError("the host has ß, ς or a joiner, which browsers convert differently; write it in punycode");
    }
    const ascii = domainToASCII(label);
    if (!ascii) throw new PatternError("the host isn't a valid internationalized name");
    labels.push(ascii.toLowerCase());
  }
  return labels.join(".");
}

export function canonicalHost(host: string): string {
  if (host.includes("%")) throw new PatternError("hosts can't have % (no IPv6 scope ids or escapes)");
  if (host.startsWith("[")) {
    if (!host.endsWith("]") || host.split("[").length !== 2 || host.split("]").length !== 2) throw new PatternError("invalid IPv6 host");
    try {
      const parsed = new URL(`http://${host}/`);
      if (!parsed.hostname.startsWith("[") || !parsed.hostname.endsWith("]")) throw new Error("not IPv6");
      return parsed.hostname.toLowerCase();
    } catch {
      throw new PatternError("invalid IPv6 address");
    }
  }
  const address = ipv4(host);
  if (address !== null) return address;
  const lowered = idna(host);
  const labels = lowered.replace(/\.+$/, "").split(".");
  if (!labels.length || labels.some((label) => !LABEL.test(label))) throw new PatternError("the host has characters a hostname can't have");
  return lowered;
}

function pathFields(path: string): Pick<MatchPattern, "raw" | "utf8" | "utf8Bytes"> {
  const raw = path.replace(/\\/g, "\\\\").replace(/\?/g, "\\?");
  const rawBytes = encoder.encode(raw);
  const utf8 = unescape(rawBytes);
  return { raw: decode(rawBytes), utf8: decode(utf8), utf8Bytes: [...utf8] };
}

export function parse(pattern: string): MatchPattern {
  if (pattern === "<all_urls>") {
    return { all: true, schemes: [...SCRIPT_SCHEMES], host: "", sub: true, port: "*", file: false, ...pathFields("/*") };
  }
  if (pattern.includes("\0")) throw new PatternError("contains a null character");
  const separator = pattern.indexOf("://");
  if (separator < 0) throw new PatternError("a match pattern is <all_urls> or scheme://host/path");
  const scheme = pattern.slice(0, separator);
  const rest = pattern.slice(separator + 3);
  if (scheme !== "*" && !SCRIPT_SCHEMES.includes(scheme)) {
    throw new PatternError(`content scripts only match ${["*", ...SCRIPT_SCHEMES].join(", ")} URLs`);
  }
  const schemes = scheme === "*" ? [...WILDCARD_SCHEMES] : [scheme];
  if (!rest) throw new PatternError("the host is empty");
  if (scheme === "file") {
    const slash = rest.indexOf("/");
    if (slash < 0) throw new PatternError("add a path, like file:///*");
    const host = rest.slice(0, slash);
    const path = rest.slice(slash);
    if (host && host !== "localhost") throw new PatternError("file patterns have no host (file:///path)");
    return { all: false, schemes, host: "", sub: false, port: "*", file: true, ...pathFields(path) };
  }
  const end = rest.indexOf("/");
  if (end === 0) throw new PatternError("the host is empty");
  if (end < 0) throw new PatternError("add a path, like /*");
  const hostAndPort = rest.slice(0, end);
  const path = rest.slice(end);
  let host: string;
  let port = "*";
  if (hostAndPort.startsWith("[")) {
    const close = hostAndPort.indexOf("]");
    if (close < 0) throw new PatternError("invalid IPv6 host");
    if (close === 1) throw new PatternError("the host is empty");
    host = hostAndPort.slice(0, close + 1);
    const tail = hostAndPort.slice(close + 1);
    if (tail) {
      if (!tail.startsWith(":")) throw new PatternError("invalid IPv6 host");
      port = tail.slice(1);
      checkPort(scheme, port);
    }
  } else {
    const colon = hostAndPort.indexOf(":");
    host = colon < 0 ? hostAndPort : hostAndPort.slice(0, colon);
    if (colon >= 0) {
      port = hostAndPort.slice(colon + 1);
      checkPort(scheme, port);
    }
  }
  if (!host) throw new PatternError("the host is empty");
  let sub = false;
  if (host === "*") {
    sub = true;
    host = "";
  } else if (host.startsWith("*.")) {
    if (host.length === 2) throw new PatternError("the host is empty");
    sub = true;
    host = host.slice(2);
  }
  if (host.includes("*")) throw new PatternError("* only works as the whole host or a *. prefix");
  if (host) host = canonicalHost(host);
  return { all: false, schemes, host, sub, port, file: false, ...pathFields(path) };
}

function checkPort(scheme: string, port: string): void {
  if (port === "*") return;
  if (scheme === "*") throw new PatternError("a pattern with scheme * can't name a port");
  if (!/^[0-9]+$/.test(port)) throw new PatternError("the port is a number or *");
  if (port.length > 1 && port.startsWith("0")) throw new PatternError("write the port without leading zeros");
  if (Number.parseInt(port, 10) > 65535) throw new PatternError("the port must be 0 to 65535");
}

export function globPoints(glob: string): number[] {
  return decode(encoder.encode(glob));
}

function matchesPath(spec: MatchPattern, test: string): boolean {
  const testBytes = encoder.encode(test);
  const unescaped = unescape(testBytes);
  if (spec.utf8Bytes.length === unescaped.length + 2 && spec.utf8Bytes[spec.utf8Bytes.length - 2] === 47 && spec.utf8Bytes[spec.utf8Bytes.length - 1] === 42) {
    if (unescaped.every((byte, index) => byte === spec.utf8Bytes[index])) return true;
  }
  return matchPattern(decode(unescaped), spec.utf8) || matchPattern(decode(testBytes), spec.raw);
}

function isIp(host: string): boolean {
  return host.startsWith("[") || /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(host);
}

function matchesHost(spec: MatchPattern, host: string): boolean {
  const test = host.replace(/\.+$/, "");
  const pattern = spec.host.replace(/\.+$/, "");
  if (test === pattern) return true;
  if (spec.sub && !pattern) return true;
  if (!spec.sub || isIp(test)) return false;
  return test.length > pattern.length + 1 && test.endsWith(pattern) && test[test.length - pattern.length - 1] === ".";
}

export function split(url: string): SplitUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const beforeFragment = url.split("#", 1)[0] ?? url;
  const path = (parsed.pathname || "/") + (beforeFragment.includes("?") ? beforeFragment.slice(beforeFragment.indexOf("?")) : "");
  const effective = parsed.port || DEFAULT_PORTS[scheme] || "-1";
  return { scheme, host, port: effective, path };
}

export function matches(spec: MatchPattern, url: SplitUrl | null): boolean {
  if (!url || !spec.schemes.includes(url.scheme)) return false;
  if (spec.all) return true;
  if (!spec.file && !matchesHost(spec, url.host)) return false;
  if (spec.port !== "*" && spec.port !== url.port) return false;
  return matchesPath(spec, url.path);
}

export function globMatches(points: number[], url: string): boolean {
  return matchPattern(decode(encoder.encode(url)), points);
}

/** The same matcher as a function Chrome can run in a page's own world, for `bay scripts test`. */
export const MATCHER_JS = String.raw`(rules, href) => {
const SENTINEL = -1;
const defaultPorts = { "http:": "80", "https:": "443", "ftp:": "21" };
const unescapedAscii = new Set(Array.from('"-<>_~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (c) => c.charCodeAt(0)));
const banned = ${JSON.stringify(BANNED_RANGES)};
const leadLength = (b) => (b >= 0xC2 && b <= 0xDF ? 2 : b >= 0xE0 && b <= 0xEF ? 3 : b >= 0xF0 && b <= 0xF4 ? 4 : 0);
const firstChar = (bytes, start, end) => {
  if (start >= end) return null;
  const b0 = bytes[start];
  if (b0 < 0x80) return [b0, 1];
  const size = leadLength(b0);
  if (!size || end - start < size) return null;
  let point = b0 & (size === 2 ? 0x1F : size === 3 ? 0x0F : 0x07);
  for (let i = 1; i < size; i++) {
    const b = bytes[start + i];
    if (b < 0x80 || b > 0xBF) return null;
    point = (point << 6) | (b & 0x3F);
  }
  const min = size === 2 ? 0x80 : size === 3 ? 0x800 : 0x10000;
  if (point < min || point > 0x10FFFF || (point >= 0xD800 && point <= 0xDFFF)) return null;
  return [point, size];
};
const decode = (bytes) => {
  const points = [];
  for (let i = 0; i < bytes.length; ) {
    const found = firstChar(bytes, i, Math.min(bytes.length, i + 4));
    if (!found) { points.push(SENTINEL); i += 1; } else { points.push(found[0]); i += found[1]; }
  }
  return points;
};
const hex = (b) => (b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102);
const escapedByte = (bytes, i) => (i + 2 >= bytes.length || bytes[i] !== 37 || !hex(bytes[i + 1]) || !hex(bytes[i + 2]) ? null : parseInt(String.fromCharCode(bytes[i + 1], bytes[i + 2]), 16));
const shouldUnescape = (p) => (p < 0x80 ? unescapedAscii.has(p) : !banned.some(([low, high]) => p >= low && p <= high));
const encoder = new TextEncoder();
const unescape = (bytes) => {
  const out = [];
  for (let i = 0; i < bytes.length; ) {
    const first = escapedByte(bytes, i);
    let found = null;
    if (first !== null) {
      const collected = [first];
      if (first >= 0xC2 && first <= 0xF4) {
        while (collected.length < 4) {
          const trail = escapedByte(bytes, i + collected.length * 3);
          if (trail === null || trail < 0x80 || trail > 0xBF) break;
          collected.push(trail);
        }
      }
      found = firstChar(collected, 0, collected.length);
    }
    if (!found) {
      if (first !== null) { out.push(first); i += 3; } else { out.push(bytes[i]); i += 1; }
      continue;
    }
    const [point, size] = found;
    if (!shouldUnescape(point)) for (let j = 0; j < 3 * size; j++) out.push(bytes[i + j]);
    else for (const b of encoder.encode(String.fromCodePoint(point))) out.push(b);
    i += 3 * size;
  }
  return out;
};
const search = (pattern, p, string, s, distance) => {
  let pStart = p, sStart = s, escape = false;
  while (true) {
    let mismatch = false;
    if (p === pattern.length) {
      if (s === string.length) return [true, p, s];
      mismatch = true;
    } else {
      const c = pattern[p];
      if (!escape && (c === 42 || c === 63)) return [true, p, s];
      if (!escape && c === 92) { escape = true; p += 1; continue; }
      escape = false;
      if (s === string.length) return [false, p, s];
      if (c === string[s] && c !== SENTINEL) { p += 1; s += 1; continue; }
      mismatch = true;
    }
    if (mismatch) {
      if (distance === 0) return [false, p, s];
      distance -= 1;
      p = pStart;
      sStart += 1;
      s = sStart;
    }
  }
};
const matchPattern = (string, pattern) => {
  let p = 0, s = 0;
  while (true) {
    let stars = false, questions = 0;
    while (p < pattern.length && (pattern[p] === 42 || pattern[p] === 63)) { stars = stars || pattern[p] === 42; questions += pattern[p] === 63 ? 1 : 0; p += 1; }
    const [ok, np, ns] = search(pattern, p, string, s, stars ? -1 : questions);
    if (!ok) return false;
    p = np; s = ns;
    if (p === pattern.length) return true;
  }
};
let url = null;
try { url = new URL(href); } catch {}
const scheme = url ? url.protocol.slice(0, -1) : "";
const beforeFragment = href.split("#")[0];
const testPath = url ? (url.pathname || "/") + (beforeFragment.includes("?") ? "?" + beforeFragment.slice(beforeFragment.indexOf("?") + 1) : "") : "";
const testHost = url ? url.hostname.toLowerCase().replace(/\.+$/, "") : "";
const testPort = url ? url.port || defaultPorts[url.protocol] || "-1" : "";
const isIp = testHost.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(testHost);
const pathBytes = Array.from(encoder.encode(testPath));
const unescapedPath = unescape(pathBytes);
const hostMatches = (p) => {
  const pattern = p.host.replace(/\.+$/, "");
  if (testHost === pattern) return true;
  if (p.sub && !pattern) return true;
  if (!p.sub || isIp) return false;
  return testHost.length > pattern.length + 1 && testHost.endsWith(pattern) && testHost[testHost.length - pattern.length - 1] === ".";
};
const pathMatches = (p) => {
  const wanted = p.utf8Bytes;
  if (wanted.length === unescapedPath.length + 2 && wanted[wanted.length - 2] === 47 && wanted[wanted.length - 1] === 42 && unescapedPath.every((b, i) => b === wanted[i])) return true;
  return matchPattern(decode(unescapedPath), p.utf8) || matchPattern(decode(pathBytes), p.raw);
};
const matches = (p) => {
  if (!url || !p.schemes.includes(scheme)) return false;
  if (p.all) return true;
  if (!p.file && !hostMatches(p)) return false;
  if (p.port !== "*" && p.port !== testPort) return false;
  return pathMatches(p);
};
const hrefPoints = decode(Array.from(encoder.encode(href)));
const globbed = (list) => list.some((points) => matchPattern(hrefPoints, points));
const included = rules.match.some(matches) || ((scheme === "http" || scheme === "https") && globbed(rules.include));
if (!included) return "no rule matches";
return rules.excludeMatch.some(matches) || globbed(rules.exclude) ? "excluded" : "run";
}`;

export const JS = MATCHER_JS;
