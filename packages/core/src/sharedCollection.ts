import LZString from "lz-string";
import { punycodeDecode } from "./idn.ts";

export type SharedLink = { kind: "link"; title: string; url: string };
export type SharedFolder = { kind: "folder"; title: string; children: SharedItem[] };
export type SharedItem = SharedLink | SharedFolder;
export type SharedCollection = { version: 1; kind: "folder" | "split" | "selection"; title: string; children: SharedItem[] };

const MAX_TOKEN_LENGTH = 16_000;
const MAX_RAW_LENGTH = 128_000;
const MAX_LINKS = 500;
const MAX_ITEMS = 1_000;
// The collection is depth 0; its descendants may reach depth 12.
const MAX_DEPTH = 12;
const MAX_TITLE_LENGTH = 1_024;
const MAX_URL_LENGTH = 8_192;
const WEBSITE_ORIGIN = "https://bay.krishkalaria.in";
const URI_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-";

function invalid(message: string): never {
  throw new Error(`Invalid shared collection: ${message}`);
}

function validateToken(token: string): void {
  if (typeof token !== "string" || !token.length) invalid("share token is empty or is not a string");
  if (token.length > MAX_TOKEN_LENGTH) invalid(`share token exceeds ${MAX_TOKEN_LENGTH} characters`);
  if (/[^A-Za-z0-9+-]/.test(token)) invalid("share token contains invalid characters");
}

// lz-string has no decompressed-size limit. Read its LZ codes using only dictionary
// entry lengths, rejecting oversized output before the library allocates strings.
function checkDecompressedLength(token: string): void {
  let offset = 0;
  const read = (width: number): number => {
    if (offset + width > token.length * 6) invalid("compressed share token is truncated");
    let value = 0;
    for (let bit = 0; bit < width; bit++, offset++) {
      const sextet = URI_ALPHABET.indexOf(token.charAt(Math.floor(offset / 6)));
      value += ((sextet >> (5 - (offset % 6))) & 1) * 2 ** bit;
    }
    return value;
  };

  const first = read(2);
  if (first === 2) return;
  if (first !== 0 && first !== 1) invalid("compressed share token is malformed");
  read(first === 0 ? 8 : 16);
  const lengths = [0, 0, 0, 1];
  let previous = 1;
  let total = 1;
  let width = 3;
  let remaining = 4;
  for (;;) {
    let code = read(width);
    if (code === 2) return;
    if (code === 0 || code === 1) {
      read(code === 0 ? 8 : 16);
      code = lengths.length;
      lengths.push(1);
      remaining--;
    }
    if (remaining === 0) {
      remaining = 2 ** width;
      width++;
    }
    const length = code === lengths.length ? previous + 1 : lengths[code];
    if (!length) invalid("compressed share token is malformed");
    total += length;
    if (total > MAX_RAW_LENGTH) invalid(`decompressed data exceeds ${MAX_RAW_LENGTH} characters`);
    lengths.push(previous + 1);
    previous = length;
    remaining--;
    if (remaining === 0) {
      remaining = 2 ** width;
      width++;
    }
  }
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b, c] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && ((b === 0 && c === 0) || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

// Match the browser's numeric IPv4 forms without relying on RN's URL shim.
// See https://url.spec.whatwg.org/#concept-ipv4-parser.
function ipv4(host: string, path: string): number[] | null {
  const parts = host.split(".");
  if (!/^(?:[0-9]+|0x[0-9a-f]*)$/i.test(parts[parts.length - 1]!)) return null;
  if (parts.length > 4) invalid(`${path} has an invalid HTTP(S) IPv4 address`);
  const numbers = parts.map((part) => {
    if (/^0x[0-9a-f]*$/i.test(part)) return parseInt(part.slice(2) || "0", 16);
    if (/^0[0-7]*$/.test(part)) return parseInt(part, 8);
    if (/^(?:0|[1-9][0-9]*)$/.test(part)) return Number(part);
    return invalid(`${path} has an invalid HTTP(S) IPv4 address`);
  });
  const last = numbers.pop()!;
  if (numbers.some((part) => part > 255) || last >= 256 ** (4 - numbers.length)) invalid(`${path} has an invalid HTTP(S) IPv4 address`);
  const address = numbers.reduce((total, part, index) => total + part * 256 ** (3 - index), last);
  return [address >>> 24, (address >>> 16) & 255, (address >>> 8) & 255, address & 255];
}

function ipv6(host: string, path: string): number[] {
  let address = host.slice(1, -1);
  if (address.includes(".")) {
    const colon = address.lastIndexOf(":");
    const dotted = address.slice(colon + 1);
    const parts = dotted.split(".");
    if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) {
      invalid(`${path} has an invalid HTTP(S) IPv6 address`);
    }
    const [a, b, c, d] = parts.map(Number) as [number, number, number, number];
    address = `${address.slice(0, colon + 1)}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
  }
  const halves = address.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  if (
    halves.length > 2 ||
    [...head, ...tail].some((part) => !/^[0-9a-f]{1,4}$/i.test(part)) ||
    (halves.length === 1 ? head.length !== 8 : head.length + tail.length >= 8)
  )
    invalid(`${path} has an invalid HTTP(S) IPv6 address`);
  const words = [...head.map((part) => parseInt(part, 16)), ...Array<number>(8 - head.length - tail.length).fill(0), ...tail.map((part) => parseInt(part, 16))];
  return words;
}

function isPrivateHost(hostname: string, path: string): boolean {
  if (hostname.startsWith("[")) {
    const words = ipv6(hostname, path);
    if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
      return isPrivateIpv4([words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255]);
    }
    // Allow native global unicast only. Exclude transition ranges that can embed
    // local IPv4 addresses, along with special-use 2001::/23 addresses.
    return (words[0]! & 0xe000) !== 0x2000 || words[0] === 0x2002 || (words[0] === 0x2001 && words[1]! < 0x0200);
  }
  let host: string;
  try {
    host = decodeURIComponent(hostname);
  } catch {
    invalid(`${path} has an invalid HTTP(S) hostname escape`);
  }
  // Use conservative IDN validation rather than a platform-dependent UTS 46
  // implementation. Compatibility letters/dots are normalized before checking
  // local names. Reject ignored characters that browsers could silently remove.
  const normalize = (label: string) =>
    label
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\u3002\uff0e\uff61]/g, ".");
  host = normalize(host);
  if (host.length > 254 || host.split(".").some((label) => label.length > 63)) invalid(`${path} has an invalid HTTP(S) hostname`);
  host = host
    .split(".")
    .map((label) => {
      if (!label.startsWith("xn--")) return label;
      const decoded = punycodeDecode(label.slice(4));
      if (!decoded) invalid(`${path} has an invalid HTTP(S) IDN hostname`);
      return normalize(decoded);
    })
    .join(".")
    .replace(/\.$/, "");
  if (
    host.length > 253 ||
    /[^\p{L}\p{M}\p{N}_.-]|\p{Default_Ignorable_Code_Point}/u.test(host) ||
    host.split(".").some((label) => !label.length || label.length > 63)
  )
    invalid(`${path} has an invalid HTTP(S) hostname`);
  const octets = ipv4(host, path);
  if (octets) return isPrivateIpv4(octets);
  return !host.includes(".") || /(?:^|\.)(?:localhost|localdomain|local|lan|internal|intranet|corp|home|home\.arpa)$/.test(host);
}

function validateUrl(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.length) invalid(`${path} must be a nonempty HTTP(S) URL`);
  if (value.length > MAX_URL_LENGTH) invalid(`${path} exceeds ${MAX_URL_LENGTH} characters`);
  if (!/^https?:\/\//i.test(value) || /[\s\\]/u.test(value) || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    invalid(`${path} must be an absolute HTTP(S) URL`);
  }
  const authority = value.slice(value.indexOf("://") + 3).split(/[/?#]/, 1)[0]!;
  if (authority.includes("@")) invalid(`${path} must not contain credentials`);
  const parts = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+))?$/.exec(authority);
  if (!parts || (parts[2] !== undefined && Number(parts[2]) > 65535)) invalid(`${path} must be a valid absolute HTTP(S) URL`);
  if (isPrivateHost(parts[1]!, path)) invalid(`${path} must not target localhost, a private network, or a local hostname`);
  return value;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function title(value: unknown, path: string): string {
  if (typeof value !== "string") invalid(`${path} must be a string`);
  if (value.length > MAX_TITLE_LENGTH) invalid(`${path} exceeds ${MAX_TITLE_LENGTH} characters`);
  return value;
}

// Rebuild the entire payload so storage IDs, icons, histories, and other metadata
// never enter a generated token or a decoded collection.
function validateCollection(value: unknown): SharedCollection {
  const root = object(value, "collection");
  if (root.version !== 1) invalid("unsupported version; expected version 1");
  if (root.kind !== "folder" && root.kind !== "split" && root.kind !== "selection") invalid("collection.kind must be folder, split, or selection");
  let items = 0;
  let links = 0;
  const children = (value: unknown, depth: number, path: string): SharedItem[] => {
    if (!Array.isArray(value)) invalid(`${path} must be an array`);
    if (items + value.length > MAX_ITEMS) invalid(`collection exceeds ${MAX_ITEMS} items`);
    return Array.from(value, (value, index): SharedItem => {
      if (depth > MAX_DEPTH) invalid(`collection exceeds depth ${MAX_DEPTH}`);
      if (++items > MAX_ITEMS) invalid(`collection exceeds ${MAX_ITEMS} items`);
      const itemPath = `${path}[${index}]`;
      const item = object(value, itemPath);
      const itemTitle = title(item.title, `${itemPath}.title`);
      if (item.kind === "link") {
        if (++links > MAX_LINKS) invalid(`collection exceeds ${MAX_LINKS} links`);
        return { kind: "link", title: itemTitle, url: validateUrl(item.url, `${itemPath}.url`) };
      }
      if (item.kind !== "folder") invalid(`${itemPath}.kind must be link or folder`);
      return { kind: "folder", title: itemTitle, children: children(item.children, depth + 1, `${itemPath}.children`) };
    });
  };
  return { version: 1, kind: root.kind, title: title(root.title, "collection.title"), children: children(root.children, 1, "collection.children") };
}

export function encodeSharedCollection(collection: SharedCollection): string {
  const raw = JSON.stringify(validateCollection(collection));
  if (raw.length > MAX_RAW_LENGTH) invalid(`serialized data exceeds ${MAX_RAW_LENGTH} characters`);
  const token = LZString.compressToEncodedURIComponent(raw);
  if (token.length > MAX_TOKEN_LENGTH) invalid(`share token exceeds ${MAX_TOKEN_LENGTH} characters; share fewer links`);
  return token;
}

export function decodeSharedCollection(token: string): SharedCollection {
  validateToken(token);
  checkDecompressedLength(token);
  const raw = LZString.decompressFromEncodedURIComponent(token);
  if (!raw || LZString.compressToEncodedURIComponent(raw) !== token) invalid("compressed share token is malformed or noncanonical");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalid("decompressed data is not valid JSON");
  }
  return validateCollection(value);
}

export function sharedCollectionUrl(collection: SharedCollection): string {
  return `${WEBSITE_ORIGIN}/share/#${encodeSharedCollection(collection)}`;
}

export function sharedCollectionAppUrl(token: string): string {
  decodeSharedCollection(token);
  return `bay://share/#${token}`;
}

// Extract only canonical fragment syntax; callers must decode to validate data.
// Scheme and hostname are case-insensitive; paths and token bytes are exact.
export function sharedCollectionToken(url: string): string | null {
  if (typeof url !== "string" || url.length > WEBSITE_ORIGIN.length + 8 + MAX_TOKEN_LENGTH) return null;
  const hash = url.indexOf("#");
  if (hash === -1) return null;
  const base = url.slice(0, hash);
  const path = base.slice(WEBSITE_ORIGIN.length);
  const website = base.slice(0, WEBSITE_ORIGIN.length).toLowerCase() === WEBSITE_ORIGIN && (path === "/share" || path === "/share/");
  if (!website && base.toLowerCase() !== "bay://share/") return null;
  const token = url.slice(hash + 1);
  return token.length > 0 && token.length <= MAX_TOKEN_LENGTH && !/[^A-Za-z0-9+-]/.test(token) ? token : null;
}

export function sharedLinkCount(collection: SharedCollection): number {
  const count = (items: SharedItem[]): number => items.reduce((total, item) => total + (item.kind === "link" ? 1 : count(item.children)), 0);
  return count(validateCollection(collection).children);
}
