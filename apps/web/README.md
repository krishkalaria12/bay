# Bay website

The landing page at https://bay.krishkalaria.in: Astro, React islands and Tailwind CSS 4.

It is its own pnpm workspace (excluded from the repo root's, which hoists for React Native), so install
and run it from this folder:

```bash
pnpm install
pnpm dev          # http://localhost:4321
pnpm build        # static site in dist/
pnpm typecheck
pnpm preview:cf   # the built site on Cloudflare's runtime, http://localhost:8787
pnpm run deploy   # build and deploy to Cloudflare (run `pnpm exec wrangler login` once first)
```

It deploys as a static Cloudflare Worker (`wrangler.jsonc`, no script) on the custom domain bay.krishkalaria.in.
`public/_headers` caches Astro's fingerprinted `/_astro/*` files for a year.

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

The links currently point to `/download` in `src/site.ts`; this checkout does not define that route.
Configure a working download URL or redirect separately so those clicks lead to the browser release.

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
