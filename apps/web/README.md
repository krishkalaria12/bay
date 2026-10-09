# Bay website

The landing page at https://bay.krishkalaria.in: Astro, React islands and Tailwind CSS 4.

It is its own pnpm workspace (excluded from the repo root's, which hoists for React Native), so install
and run it from this folder:

```bash
pnpm install
pnpm dev          # http://localhost:4321
pnpm build        # static site in dist/
pnpm typecheck
```

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
