// The preview: what a hovered link says about the page it points at, and what a tab's own site says about itself.
//
// A summary is a job: the page is fetched without the user's cookies, with a timeout, and the answer belongs to
// the request that asked for it. The parsing stays plain: it is the same HTML the browser would show.
//
// A site's preview is the same job, but the fetch happens inside the tab: the page's own origin and its own
// cookies, which is why it stays in that page and never in the app's network stack.
import { lookup } from "@bay/core";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Operation } from "../../effect/errors";
import { Http } from "../../effect/ports/http";
import { useBrowser } from "../../store/browserStore";
import { webviews } from "../../lib/webviews";
import {
  fetchScript,
  githubPullsHeaders,
  githubPullsUrls,
  gmailAccount,
  gmailFeedUrl,
  parseGithubPulls,
  parseGmailFeed,
  signedOut,
  tabPlace,
  type Fetched,
  type GithubData,
  type GmailData,
  type PreviewSite,
} from "../previews/knownSites";

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

// How long a page has to answer a site's preview before it counts as one that didn't.
const ANSWER_MS = 8_000;

/** A preview could not be made. */
export class PreviewFailure extends TaggedError("PreviewFailure")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** The page, as the preview reaches it. */
export class PreviewEngine extends Context.Service<
  PreviewEngine,
  {
    /** Asks the page to fetch for itself, with the page's own origin and cookies. */
    readonly fetch: (tabId: string, script: string) => Effect.Effect<unknown, PreviewFailure>;
  }
>()("bay/PreviewEngine") {
  static readonly layer = Layer.succeed(PreviewEngine)({
    fetch: (tabId, script) =>
      Effect.suspend(() => {
        const handle = useBrowser.getState().tabs[tabId] ? webviews.get(tabId) : undefined;

        // The tab has no page: there is nothing to ask.
        if (!handle) return Effect.succeed(null);

        return Effect.tryPromise({
          try: () => handle.evaluate<unknown>(script),
          catch: (cause) => new PreviewFailure({ operation: { name: "preview.fetch", resource: tabId }, cause }),
        });
      }),
  });
}

/** What a site's preview came to. */
export type SitePreview =
  /** The site's own data. */
  | { readonly kind: "ready"; readonly data: GmailData | GithubData }
  /** The page is on the site's sign-in. */
  | { readonly kind: "signedOut" }
  /** The page has no view, or is somewhere else. */
  | { readonly kind: "unloaded" }
  /** The page did not answer. */
  | { readonly kind: "unreadable" }
  /** A newer preview for the same tab came in while this one was out. */
  | { readonly kind: "stale" };

export class PreviewService extends Context.Service<
  PreviewService,
  {
    /** What the page at the link says about itself. */
    readonly summary: (url: string) => Effect.Effect<string>;
    /** What the tab's own site says about itself. */
    readonly site: (tabId: string, site: PreviewSite) => Effect.Effect<SitePreview>;
  }
>()("bay/PreviewService") {
  static readonly layer = Layer.effect(
    PreviewService,
    Effect.gen(function* () {
      const http = yield* Http;
      const engine = yield* PreviewEngine;

      // The request each tab is on now: a newer one supersedes the older, and the older answer is dropped.
      const requests = new Map<string, number>();

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

      // What one site says, when the page is asked.
      const ask = (tabId: string, site: PreviewSite): Effect.Effect<SitePreview> =>
        Effect.gen(function* () {
          const tab = useBrowser.getState().tabs[tabId];

          if (!tab) return yield* Effect.succeed({ kind: "unloaded" } as const);

          const place = tabPlace(site, tab.url);

          if (place === "signIn") return yield* Effect.succeed({ kind: "signedOut" } as const);

          if (place === "elsewhere") return yield* Effect.succeed({ kind: "unloaded" } as const);

          const urls = site === "gmail" ? [gmailFeedUrl(gmailAccount(tab.url))] : githubPullsUrls;
          const headers = site === "github" ? githubPullsHeaders : {};

          // A page that never answers (its policy stopped the request) shows as one that didn't, not as loading
          // forever.
          const answer = yield* engine.fetch(tabId, fetchScript(urls, headers)).pipe(
            Effect.timeout(Duration.millis(ANSWER_MS)),
            Effect.catch(() => Effect.succeed(null)),
          );

          // SAFETY: the page answers with the fetched list the script asked for; the parse reads that shape.
          const all = answer as Fetched[] | null;

          if (!all?.length) return yield* Effect.succeed({ kind: "unreadable" } as const);

          if (all.some(signedOut)) return yield* Effect.succeed({ kind: "signedOut" } as const);

          if (site === "gmail") {
            const first = all[0]!;

            // A fetch the page couldn't make (the tab is on Google's sign-in, another origin) is a signed-out tab too.
            if ("error" in first) return yield* Effect.succeed({ kind: "signedOut" } as const);

            const data = parseGmailFeed(first.body);

            return yield* Effect.succeed(data ? ({ kind: "ready", data } as const) : ({ kind: "unreadable" } as const));
          }

          const [authored, requested] = all.map((f) => ("error" in f ? null : parseGithubPulls(f.body)));

          if (!authored || !requested) return yield* Effect.succeed({ kind: "unreadable" } as const);

          return yield* Effect.succeed({ kind: "ready", data: { authored, requested } } as const);
        });

      const site = (tabId: string, which: PreviewSite): Effect.Effect<SitePreview> =>
        Effect.gen(function* () {
          const generation = (requests.get(tabId) ?? 0) + 1;

          requests.set(tabId, generation);

          const answer = yield* ask(tabId, which);

          // A newer preview for the same tab came in while this one was out: its answer is the one that counts.
          if (requests.get(tabId) !== generation) return yield* Effect.succeed({ kind: "stale" } as const);

          return yield* Effect.succeed(answer);
        });

      return PreviewService.of({ summary, site });
    }),
  );
}

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
  const p = pMatch?.[1]?.replace(/<[^>]+>/g, "")?.trim();
  // SAFETY: string[] assertion matches the runtime value validated at this call site.
  const parts = [title, desc, p].filter(Boolean) as string[];
  const text = decodeEntities(parts.join(" — ")).replace(/\s+/g, " ").trim();

  return text ? text.slice(0, 500) : "No summary available.";
};
