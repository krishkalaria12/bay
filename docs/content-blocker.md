# The content blocker

Desktop blocks ads and trackers with Bay's own blocker, `packages/adblock` (Brave's adblock-rust behind a C ABI), the
same crate the mobile app uses. It replaced uBlock Origin, which ran as a hidden component extension driven through
its own messaging.

## Where it hooks in

Every request a web page makes is put to the blocker before it starts, in the engine's browser process:

- **Subresources** (a document's, a dedicated or shared worker's, a service worker's, worker scripts): NNCore's
  `ContentBrowserClient::WillCreateURLLoaderFactory` puts an interceptor in front of each `URLLoaderFactory` it makes
  for them (`engine/nncore/src/bay/core/nn_request_filter.cc`), the way Chrome's webRequest proxies requests. The
  interceptor runs on one background sequence; a blocked request is answered at once with `ERR_BLOCKED_BY_CLIENT`,
  any other is handed to the next factory untouched (its loader and client pass straight through, so a request costs
  one check). It goes in before Chrome's own interceptors, so extensions never see what was blocked.
- **Subframe navigations** (iframes, frames, fenced frames) go through a `NavigationThrottle` on start and on each
  redirect, which blocks and collapses the frame. Main-frame navigations are never blocked.

The engine only asks; the host decides. `+[NNCoreEngine setRequestFilter:]` takes a C function
(`NNCoreRequestFilter`: url, source, top, type → block), which the app's native core
(`packages/nncore/ios/NNCoreContentBlocker.mm`) implements over the Rust engine. Blocked requests are counted by the
engine's existing `ERR_BLOCKED_BY_CLIENT` accounting (`tab:didBlockRequests:lastURL:`).

Why there: a CEF resource request handler doesn't exist in this engine (NNCore replaced CEF's browser-side client),
and the app only reaches the engine through `NNCore.h`. Renderer-side throttles would need the engine in every
renderer process. The factory interceptor sees every subresource from one place, with the initiator's origin and the
top frame's, and costs nothing for requests it lets through. It is NNCore code (`//bay/core`), not a Chromium patch,
but it is compiled into Chrome's framework, so it needs an engine build.

**Cosmetic filtering**: the page script (`page_script.js`) says hello from every frame at document start; the host
answers with the site's hiding rules as a user-origin style sheet for that frame
(`-[NNCoreTab insertUserStyle:frame:origin:]`, `mojom::NNPage::InsertUserStyle`; the renderer inserts it only if the
frame still shows a document of that origin), runs any scriptlets in its main world, and turns on the page script's
survey of classes and ids, whose reports get the generic rules that hide them.

## Lists, settings and the engine cache

- The catalogue is uBO's (`packages/nncore/ios/filter_lists.json`, generated from uBO 1.75's `assets.json`): the same
  list ids, titles, categories and defaults, with Bay's cookie-notice lists on, and regional lists on for the user's
  languages.
- The default lists are bundled (`packages/nncore/scripts/filter-lists.sh` → `Resources/FilterLists`) so a new
  install blocks offline from its first page. Lists download into `<app support>/Content Blocker/lists` and update
  when their `! Expires:` header says (checked a minute after launch, then every 3 hours).
- uBO's `!#if` preprocessor blocks are resolved as uBO resolves them on Chromium (`packages/adblock/src/preprocess.rs`).
- The compiled engine is cached (`engine.dat`, about 25 MB for the defaults) and loads in about 15 ms at launch; it is
  rebuilt (about 0.4 s for the defaults) when a list or the selection changes.
- `settings.json` holds on/off, the selected lists and the hosts it's paused on; they apply to every profile, private
  ones included. A pause covers the host's subdomains.

The JS API (`packages/nncore/src/contentBlocker.ts`) is unchanged.

## Not yet

- Scriptlets and redirect resources: `bay_blocker_use_resources` takes adblock-rust's resource JSON, but the app loads
  none yet, so `##+js()` rules and `$redirect` stand-ins don't apply (redirected requests are blocked instead).
- Procedural cosmetic filters (`:has-text()`, `:style()`, `:remove()`) aren't applied.
- WebSocket connections aren't filtered, and a subresource's redirects aren't checked again.
- uBO's settings (paused sites, list choices) aren't carried over: the new blocker starts from the defaults.
