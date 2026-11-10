// The link preview: what a hovered link says about the page it points at.
//
// A summary is a job: the page is fetched without the user's cookies, with a timeout, and the answer belongs to
// the request that asked for it. The parsing stays plain: it is the same HTML the browser would show.
import { lookup } from "@bay/core";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Http } from "../../effect/ports/http";

// Links to files, which a preview would download whole.
const FILE_LINK = /\.(?:zip|dmg|pkg|exe|msi|iso|img|tar|gz|tgz|bz2|xz|7z|rar|pdf|mp4|mov|mkv|webm|avi|mp3|m4a|wav|flac|apk|ipa)$/i;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } satisfies Record<string, string>;

const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);

      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }

    return lookup(ENTITIES, code.toLowerCase()) ?? match;
  });

// How long a preview waits for the page.
const PREVIEW_TIMEOUT_MS = 8_000;

/** The summary of a page: its title, its description and its first paragraph. */
const summarise = (html: string): string => {
  const title = html
    .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<[^>]+>/g, "")
    .trim();

  const descMatch =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i) ||
    html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["']/i);

  const desc = descMatch?.[1]?.trim();
  const pMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const p = pMatch?.[1]?.replace(/<[^>]+>/g, "").trim();
  // SAFETY: string[] assertion matches the runtime value validated at this call site.
  const parts = [title, desc, p].filter(Boolean) as string[];
  const text = decodeEntities(parts.join(" — ")).replace(/\s+/g, " ").trim();

  return text ? text.slice(0, 500) : "No summary available.";
};

export class PreviewService extends Context.Service<
  PreviewService,
  {
    /** What the page at the link says about itself. */
    readonly summary: (url: string) => Effect.Effect<string>;
  }
>()("bay/PreviewService") {
  static readonly layer = Layer.effect(
    PreviewService,
    Effect.gen(function* () {
      const http = yield* Http;

      const summary = (url: string): Effect.Effect<string> =>
        Effect.gen(function* () {
          try {
            if (FILE_LINK.test(new URL(url).pathname)) return yield* Effect.succeed("No summary available.");
          } catch {
            return yield* Effect.succeed("Couldn't load a preview for this link.");
          }

          // No cookies: the app's own network stack isn't the page's profile, and a private window's hover shouldn't
          // leave any.
          const response = yield* http
            .send({ url, credentials: "omit", headers: { Accept: "text/html" } })
            .pipe(Effect.timeout(Duration.millis(PREVIEW_TIMEOUT_MS)));

          if (!/html/i.test(response.headers.get("content-type") ?? "")) return yield* Effect.succeed("No summary available.");

          return yield* Effect.succeed(summarise(response.body));
        }).pipe(Effect.catch(() => Effect.succeed("Couldn't load a preview for this link.")));

      return PreviewService.of({ summary });
    }),
  );
}
