import { MAX_BANG_LIST_CHARS } from "@bay/core";

// Metro's dev split-bundle URLs cannot resolve this module outside the app root.
// Keep it in the main bundle, but defer evaluating the catalog until it is needed.
export const loadBundledBangs = (): Promise<typeof import("@bay/core/src/bangList.ts")> => Promise.resolve().then(() => require("@bay/core/src/bangList.ts"));

export async function fetchBangList(etag: string | null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch("https://services.helium.imput.net/bangs.json", {
      headers: { Accept: "application/json", ...(etag ? { "If-None-Match": etag } : {}) },
      credentials: "omit",
      signal: controller.signal,
    });
    if (Number(response.headers.get("content-length")) > MAX_BANG_LIST_CHARS) throw new Error("Bang list is too large");
    const body = response.status === 200 ? await response.text() : null;
    if (body && body.length > MAX_BANG_LIST_CHARS) throw new Error("Bang list is too large");
    return { status: response.status, body, contentType: response.headers.get("content-type"), etag: response.headers.get("etag") };
  } finally {
    clearTimeout(timer);
  }
}
