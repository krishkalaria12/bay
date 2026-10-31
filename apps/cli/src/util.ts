import { homedir } from "node:os";
import { resolve } from "node:path";

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function clip(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`;
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stopped);
      done();
    }, ms);
    const stopped = () => {
      clearTimeout(timer);
      fail(new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) return stopped();
    signal?.addEventListener("abort", stopped, { once: true });
  });
}

export function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** A `*`/`?` glob over a whole string, the form a wait can use for a URL (`**?q=*` means what it looks like). */
export function wildcardMatch(pattern: string, value: string): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < value.length) {
    if (p < pattern.length && (pattern[p] === value[s] || pattern[p] === "?")) {
      p += 1;
      s += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      mark = s;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      s = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

export function quoteToken(token: string): string {
  return encodeURIComponent(token).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function formatRelativeMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
