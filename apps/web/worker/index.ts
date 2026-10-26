import { readSnapshot, RequestError, validateSnapshot } from "./payload.ts";
import { render } from "./render.ts";

// Only the R2 methods used here, so the Worker needs no runtime type dependency.
export interface StoredObject {
  etag: string;
  customMetadata?: Record<string, string>;
}
export interface PutOptions {
  onlyIf: { etagMatches: string } | { etagDoesNotMatch: string };
  customMetadata: Record<string, string>;
  httpMetadata: { contentType: string };
}
export interface Env {
  BAY_EASEL_WEB_SHARING?: string;
  EASELS?: {
    head(key: string): Promise<StoredObject | null>;
    get(key: string): Promise<(StoredObject & { text(): Promise<string> }) | null>;
    put(key: string, value: string, options: PutOptions): Promise<StoredObject | null>;
  };
  ASSETS: { fetch(request: Request): Promise<Response> };
  EASEL_MUTATIONS?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

function text(message: string | null, status: number, headers: Record<string, string> = {}): Response {
  return new Response(message, {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...headers },
  });
}

async function sha256(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function authorize(object: StoredObject | null, ownerHash: string): void {
  if (object && object.customMetadata?.ownerHash !== ownerHash) {
    throw new RequestError(403, "Not authorized.");
  }
}

async function mutate(request: Request, env: Env, id: string): Promise<Response> {
  if (!env.EASELS || !env.EASEL_MUTATIONS) return text("Sharing is temporarily unavailable. Try again.", 503);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    return text("Cross-origin mutations are not allowed.", 403);
  }
  const { success } = await env.EASEL_MUTATIONS.limit({ key: request.headers.get("CF-Connecting-IP") || "local" });
  if (!success) return text("Too many requests. Try again shortly.", 429, { "Retry-After": "60" });
  const credentials = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("authorization") || "");
  if (!credentials) return text("Bearer credentials required.", 401);
  const ownerHash = await sha256(credentials[1]!);
  const storageKey = `easels/${id}`;
  let object = await env.EASELS.head(storageKey);
  authorize(object, ownerHash);
  const revoke = request.method === "DELETE";
  if (!revoke && object?.customMetadata?.state === "revoked") return text("This share has been revoked.", 410);
  const snapshot = revoke ? null : await readSnapshot(request);
  const body = snapshot ? JSON.stringify(snapshot) : "";
  const snapshotHash = snapshot ? await sha256(body) : "";
  // The content and owner/state metadata change in one conditional R2 write.
  // Tombstones stay forever, including for DELETE that wins a race with initial PUT.
  for (let attempt = 0; attempt < 8; attempt++) {
    authorize(object, ownerHash);
    if (object?.customMetadata?.state === "revoked") {
      return revoke ? text(null, 204) : text("This share has been revoked.", 410);
    }
    const previousRevision = Number(object?.customMetadata?.revision ?? 0);
    if (snapshot && snapshot.revision <= previousRevision) {
      if (snapshot.revision === previousRevision && snapshotHash === object?.customMetadata?.snapshotHash) return text("Published.", 200);
      return text("A newer or different snapshot has already been published.", 409);
    }
    const saved = await env.EASELS.put(storageKey, body, {
      onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: "*" },
      customMetadata: { ownerHash, state: revoke ? "revoked" : "published", revision: String(snapshot?.revision ?? previousRevision), snapshotHash },
      httpMetadata: { contentType: "application/json" },
    });
    if (saved) return revoke ? text(null, 204) : text("Published.", 200);
    object = await env.EASELS.head(storageKey);
  }
  return text("Share changed concurrently. Try again.", 409);
}

async function handle(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if ((path.startsWith("/api/easels/") || path.startsWith("/easel/")) && env.BAY_EASEL_WEB_SHARING !== "true") return text("Not found.", 404);
  if (path.startsWith("/api/easels/")) {
    const match = /^\/api\/easels\/([0-9a-f]{32})$/.exec(path);
    if (!match) return text("Not found.", 404);
    if (request.method !== "PUT" && request.method !== "DELETE") {
      return text("Method not allowed.", 405, { Allow: "PUT, DELETE" });
    }
    return mutate(request, env, match[1]!);
  }
  if (path.startsWith("/easel/")) {
    if (!env.EASELS) return text("Sharing is temporarily unavailable. Try again.", 503);
    const match = /^\/easel\/([0-9a-f]{32})\/$/.exec(path);
    if (!match) return text("Not found.", 404);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return text("Method not allowed.", 405, { Allow: "GET, HEAD" });
    }
    const object = await env.EASELS.get(`easels/${match[1]}`);
    const snapshot = object?.customMetadata?.state === "published" ? validateSnapshot(JSON.parse(await object.text())) : null;
    return new Response(render(snapshot), {
      status: snapshot ? 200 : 404,
      headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      response = await handle(request, env);
    } catch (error) {
      response = error instanceof RequestError ? text(error.message, error.status) : text("Sharing is temporarily unavailable. Try again.", 503);
    }
    return request.method === "HEAD" ? new Response(null, response) : response;
  },
};
