# Bay website

The landing page at https://bay.krishkalaria.in: Astro, React islands and Tailwind CSS 4.

It is its own pnpm workspace (excluded from the repo root's, which hoists for React Native), so install
and run it from this folder:

```bash
pnpm install
pnpm dev          # http://localhost:4321
pnpm build        # static site in dist/
pnpm typecheck
pnpm test         # Worker contract, validation, auth and concurrent R2 mutation tests
pnpm preview:cf   # the built site on Cloudflare's runtime, http://localhost:8787
pnpm run deploy   # build and deploy to Cloudflare (run `pnpm exec wrangler login` once first)
```

It deploys as a Cloudflare Worker on the custom domain bay.krishkalaria.in. Astro still builds static
assets into `dist/`. Only `/easel/*` and `/api/easels/*` run `worker/index.ts` first; other requests use
the existing asset handling, redirects and 404 page. The Worker also falls back to the `ASSETS` binding.
`public/_headers` caches Astro's fingerprinted `/_astro/*` files for a year.

## Shared Easels

Implemented but disabled by default until R2 is provisioned. `BAY_EASEL_WEB_SHARING` must be the exact
string `true` to enable it. Unset, `false`, and all other values keep it off. The default website
deployment has `BAY_EASEL_WEB_SHARING=false`, no R2 binding, and returns 404 for all Easel routes.
The app reads the same launch environment variable in both Debug and Release builds; when it is off,
the Share Easel button is hidden and publishing makes no requests or credentials. Existing shared
Easels retain their management records; enable sharing before revoking or deleting one.

To opt in locally after the server is ready, launch the app with `BAY_EASEL_WEB_SHARING=true`, for example
`open -n --env BAY_EASEL_WEB_SHARING=true --env BAY_DATA_DIR="$HOME/Library/Application Support/Bay Dev" /path/to/Bay.app`.
Building with this environment variable does not enable an app launched without it.

The native app renders an Easel to a flattened PNG, then publishes a read-only snapshot with its
clickable source list. The Worker does not render native documents or accept local paths, item IDs,
profile data, auth metadata or arbitrary extra fields. Shared pages have no scripts or analytics,
use `no-store`, `noindex, nofollow` and a restrictive CSP, and do not send referrers to sources.
The snapshot title, image, background and source links are public to anyone holding its URL.
Stopping sharing removes the stored content and makes the public URL return 404.

### Provision and deploy

Run these commands from `apps/web` after installing this folder's existing dependencies. They change
your Cloudflare account; local development and tests below do not require provisioning a bucket.

```bash
pnpm exec wrangler login
pnpm exec wrangler r2 bucket create bay-easels
pnpm exec wrangler r2 bucket dev-url disable bay-easels
pnpm test
pnpm exec tsc -p worker/tsconfig.json
pnpm typecheck
pnpm build
pnpm exec wrangler deploy --env easels
```

The opt-in `easels` environment in `wrangler.jsonc` sets `BAY_EASEL_WEB_SHARING=true` and binds that
bucket as `EASELS`. It updates the same `bay-web` Worker and inherits the static assets and domain.
Plain `pnpm run deploy` keeps sharing disabled and does not require R2. Keep the bucket private:
do not enable its public `r2.dev` URL or attach an R2 custom domain. The Worker is the only public
reader, and never exposes R2 metadata. Ownership is a SHA-256 hash of the private bearer key in
R2 custom metadata. There is no shared server secret to configure. Keep tombstone objects permanently;
do not configure lifecycle expiration for `easels/` or manually delete revoked objects, since their
continued presence prevents an old or in-flight publication from restoring a stopped share.

The `EASEL_MUTATIONS` rate limit binding is configured for 10 PUT/DELETE requests per 60 seconds per
`CF-Connecting-IP`. Namespace `1001` must be reserved for this limiter within the Cloudflare account;
choose another positive integer in `wrangler.jsonc` if it is already used. Cloudflare's binding is
approximate and per-location, rather than a strict global quota. No extra rate-limit provisioning
command is required. Missing client IPs share the `local` key during local development.

### Local runtime and checks

```bash
pnpm test
pnpm exec tsc -p worker/tsconfig.json
pnpm build
pnpm exec wrangler dev --env easels --local --port 8787
```

Wrangler serves the Worker and static assets at `http://localhost:8787` and emulates a private local R2
bucket, persisting under `.wrangler/state/`. Do not use `--remote` or add `remote: true` to the binding
when testing locally. `pnpm preview:cf` uses the default disabled environment without R2.
`pnpm dev` runs Astro alone and does not serve the Easel API. Tests use Node's
native test runner and TypeScript stripping with a fake R2 that checks conditional writes atomically.
They exercise concurrent initial publication/update/revoke and are not a deployed Cloudflare test.
To bundle without publishing, run `pnpm exec wrangler deploy --env '' --dry-run` for the default disabled site
or `pnpm exec wrangler deploy --env easels --dry-run` for the opt-in sharing configuration after `pnpm build`.

### Native publishing contract

The native client generates the public ID from 16 cryptographically random bytes as 32 lowercase hex
characters and a separate private key from 32 cryptographically random bytes as 64 lowercase hex
characters. Keep the key locally. The public ID alone never authorizes an update or revoke.

`PUT /api/easels/<id>` uses `Authorization: Bearer <key>` and `Content-Type: application/json`:

```json
{
  "version": 1,
  "revision": 1,
  "title": "Weekend ideas",
  "background": "#f1e5cc",
  "image": { "data": "data:image/png;base64,...", "width": 1200, "height": 800 },
  "links": [{ "title": "A source", "url": "https://example.com/article" }]
}
```

`revision` is a positive safe integer reserved durably on the client before each upload, increasing
even when an upload fails or times out. The client adds it to the native renderer's payload. The
Worker rejects older revisions and different content at the same revision with 409; an identical
retry of the current revision succeeds without rewriting. This prevents delayed uploads overwriting
newer snapshots. The management key stays in macOS Keychain; the local registry contains only the
public ID, revision, and last successful publish time. Registry read errors block mutations.

`image` may be `null`; `links` may be empty. Width and height must be positive integers matching
the PNG's IHDR dimensions, at most 16,384 per side and 33,000,000 total pixels. The Worker verifies
PNG framing and base64, but does not decode pixels.
Sources must be absolute HTTP(S) URLs without embedded credentials, whitespace or backslashes.
Every object accepts only its documented fields. The UTF-8 JSON body limit is 16 MiB including base64;
the Worker counts streamed bytes even without a truthful `Content-Length`. Publication returns 200
only after R2 confirms persistence. The native client derives the URL as
`https://bay.krishkalaria.in/easel/<id>/`; the server does not return credentials or a public object URL.

`GET` and `HEAD /easel/<id>/` return the shared snapshot, or 404 for a missing/revoked share.
`DELETE /api/easels/<id>` with the same bearer key atomically replaces the content with a permanent
owner-bound tombstone and returns 204. Repeating DELETE with that key returns 204, including when
the ID had never been published. A revoked ID cannot be published again and returns 410 to its owner.
After successful DELETE, the native client clears those share credentials; its next share uses a new
ID/key pair. Mutations from a different owner return 403 without writing, including on tombstones.
R2 conditional creates/updates ensure competing requests cannot claim another owner's ID or resurrect
a revoked snapshot. Repeated contention may return 409; rate limits return 429 with `Retry-After: 60`.
Storage or binding failures return a safe 503. All errors are plain text. Cross-origin browser mutation
Origins are rejected; native requests omit Origin, and no wildcard CORS is enabled.

References: [R2 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations),
[Workers rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

## Visitor and download analytics

Copy `.env.example` to `.env` and set `PUBLIC_POSTHOG_TOKEN` to your PostHog public project token.
Set `PUBLIC_POSTHOG_HOST` to your project's ingestion host. These values are public and embedded at
build time, so set them in the build environment before `pnpm build` or `pnpm run deploy`. Changing
Cloudflare runtime variables alone will not update this static site.

`src/components/PostHog.astro` sends one `$pageview` per page visit to PostHog's capture API, with
the page URL, path, host, title and referrer. URLs exclude query strings and fragments so the same
page stays grouped together. Visits and download clicks share the existing anonymous visitor ID.
Sessions use UUIDv7 IDs shared across pages and tabs, renewing after 30 minutes without a tracked
event or after 24 hours. Browser back/forward cache restores count as new pageviews.

Pageview delivery waits until page assets load, then uses an idle callback with a one-second timeout
or a timer fallback. If someone leaves, hides the page or clicks Download first, the pending pageview
is sent immediately. There is no PostHog SDK or added dependency. Each visit adds one small background
request, sent with `sendBeacon` and a `fetch`/`keepalive` fallback, without waiting for a response.
Tracking is disabled in `pnpm dev` and when the token is missing. No recordings or autocapture are used.

In PostHog, open **Web Analytics** to see visitors, pageviews and the pages people visit. Alternatively,
create a Trends insight for `$pageview`, choose **Unique users** for estimated visitors or **Total count**
for pageviews, and break down by `$pathname` to compare pages. Session duration is based on the tracked
events; this minimal integration does not measure time spent reading with heartbeats or pageleave events.

Every download link also sends `browser_download_clicked`, with `button_location`, `page_path`,
`download_url` and `platform`.

In PostHog, create a Trends insight for `browser_download_clicked`. Use **Total count** for clicks
or **Unique users** for estimated unique visitors, and break down by `button_location` or `page_path`
to compare buttons. Anonymous browser IDs cannot count the same person across devices or after they
clear browser storage. A click does not confirm a completed download or installation.

The links point to `/download` in `src/site.ts`, which `public/_redirects` sends to the latest GitHub
release's `Bay.dmg` (every release carries a copy of its DMG under that name).

References: [PostHog's Astro guide](https://posthog.com/docs/libraries/astro),
[capture API and anonymous events](https://posthog.com/docs/api/capture),
[PostHog session IDs](https://posthog.com/docs/data/sessions),
[Astro client scripts](https://docs.astro.build/en/guides/client-side-scripts/).

## Site files

- `src/site.ts` holds the name, URL, description, download link and FAQ. The origin is repeated in
  `astro.config.mjs` and `public/robots.txt`.
- `src/components/live/` is one working Bay window, drawn in HTML and run by `state.ts` (`useBay`): tabs,
  favorites, folders, spaces (tray or two-finger swipe), back and forward, the command bar, Peek (into a tab
  or Split View), the site panel's blocker switch, and tabs put away over time. Each section starts it from a
  preset in `PRESETS`; the first click makes it the visitor's, and "start over" resets it. `LiveFigure` adds
  the pen note and its arrow, which follows the part of the window it points at (`data-spot`). Sizes are in
  em, so a window scales with its container like a picture, and narrows on a phone.
- `src/assets/shots/` holds real screenshots, served through `astro:assets` as responsive WebP.
- SEO: `src/site.ts` also holds the JSON-LD graph every page shares (Organization, WebSite, SoftwareApplication,
  linked by `@id`); pages add their own nodes through `Layout`'s `schema` prop. `public/llms.txt` summarises the site
  for AI tools; update it with new pages. Pages are folders, so every internal link ends in a slash
  (`/switch-from-arc/`). The drawn windows carry `data-nosnippet`, so their placeholder words stay out of snippets.
- `public/og.png` is the social card: open `/og` at 1200×630 and screenshot it after changing the page.
