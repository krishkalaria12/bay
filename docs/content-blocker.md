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
  allowed requests continue through the next factory, with redirects checked again before they are followed. A blocked
  request with a redirect resource receives the bundled stand-in through a data pipe without contacting the ad host.
  It goes in before Chrome's own interceptors, so extensions never see what was blocked.
- **Subframe navigations** (iframes, frames, fenced frames) go through a `NavigationThrottle` on start and on each
  redirect, which blocks and collapses the frame. Main-frame navigations are never blocked.
- **Tracking parameters** (`$removeparam`): navigations, main frames included, pass through the same interceptor, which
  only rewrites. A request the lists rewrite gets a redirect to the cleaned URL (an internal 307, or the server's own
  redirect pointed there) and starts again there, as Chrome's webRequest answers an extension's redirect. Subresources
  are rewritten the same way. A paused site keeps its parameters.
- **WebSockets** go through the browser client's handshake hook before the network connection starts. A paused site
  allows its handshakes too; worker handshakes use the available cookie-site origin when there is no frame.
  While a filter is set, handshakes no extension intercepts are opened by Bay, so DevTools' extra request headers
  aren't added to them.

The engine only asks; the host decides. `+[NNCoreEngine setRequestFilter:]` takes a C function
(`NNCoreRequestFilter`: url, source, top, type, method → block, plus a data-URL stand-in for a blocked request or a
cleaned URL for an allowed one), which the app's native core
(`packages/chromium/ios/NNCoreContentBlocker.mm`) implements over the Rust engine. Blocked requests are counted by the
engine's existing `ERR_BLOCKED_BY_CLIENT` accounting (`tab:didBlockRequests:lastURL:`).

Why there: a CEF resource request handler doesn't exist in this engine (NNCore replaced CEF's browser-side client),
and the app only reaches the engine through `NNCore.h`. Renderer-side throttles would need the engine in every
renderer process. The factory interceptor sees every subresource from one place, with the initiator's origin and the
top frame's, and costs nothing for requests it lets through. It is NNCore code (`//bay/core`), not a Chromium patch,
but it is compiled into Chrome's framework, so it needs an engine build.

**Cosmetic filtering**: the page script (`page_script.js`) says hello from every frame at document start; the host
answers with the site's hiding rules as a user-origin style sheet for that frame
(`-[NNCoreTab insertUserStyle:frame:origin:]`, `mojom::NNPage::InsertUserStyle`; the renderer inserts it only if the
frame still shows a document of that origin), and turns on the page script's
survey of classes and ids, whose bounded reports get the generic rules that hide them. Procedural rules use
adblock-rust's selector/action AST in the page script, including text/style matching, ancestor/XPath selection,
removal, attribute/class removal, and style actions. DOM mutations schedule batched re-evaluation.

**Scriptlets** must run before the page's own scripts (a `set-constant` or `json-prune` that comes later is too late),
so they don't wait for hello. As a document's main world starts, its renderer asks the browser synchronously
(`mojom::NNScriptlets`, answered on a background sequence by `+[NNCoreEngine setScriptletSource:]`'s C function) and
runs the answer before anything else, as Brave does and as an extension's `document_start` script would run.

## Lists, settings and the engine cache

- The catalogue is uBO's (`packages/chromium/ios/filter_lists.json`, generated from uBO 1.75's `assets.json`): the same
  list ids, titles, categories and defaults, with Bay's cookie-notice lists on, and regional lists on for the user's
  languages.
- The default lists are bundled (`packages/chromium/scripts/filter-lists.sh` → `Resources/FilterLists`) so a new
  install blocks offline from its first page. Lists download into `<app support>/Content Blocker/lists` and update
  when their `! Expires:` header says (checked a minute after launch, then every 3 hours).
- uBO's `!#if` preprocessor blocks are resolved as uBO resolves them on Chromium (`packages/adblock/src/preprocess.rs`).
- The compiled engine is cached (`engine.dat`) and rebuilt when a list, the selection, or the engine format changes.
  Bundled and cached lists apply before optional missing lists download, so a slow regional download does not disable
  the available rules.
- `settings.json` holds on/off, the selected lists and the hosts it's paused on; they apply to every profile, private
  ones included. A pause covers the host's subdomains.

The JS API (`packages/chromium/src/contentBlocker.ts`) is unchanged.

## Scriptlets and redirect resources

`packages/chromium/scripts/blocker-resources.sh` verifies the pinned uBlock Origin release archive by SHA-256 and
converts its exported scriptlet/redirect registries into adblock-rust resources. The app bundles that JSON with its
license and provenance in `Resources/ContentBlocker`, and reloads it for cached engines as well as new ones.
Only uBO's own `ublock-*` lists may invoke trusted scriptlets; other catalogue lists receive no privileged permission.
Redirect rules return local stand-ins while allow/exception rules continue to take precedence.

adblock-rust drops `$removeparam` exceptions (`@@||web.archive.org/*/http$removeparam`), so its rewrites alone would
strip parameters uBO keeps (an archived URL's own query). `packages/adblock/src/removeparam.rs` collects them as plain
rules for a second engine, cached with the first; a request one matches isn't rewritten. An exception naming one
parameter keeps all of them, so Bay can keep more than uBO, never less.

The filter syntax is interpreted by adblock-rust, rather than uBO's JavaScript filtering engine. Procedural execution
covers the AST operators and actions that the pinned crate exposes; this is not a claim of identical handling of every
uBO syntax extension.

## Known gaps

- `$removeparam` with a regular expression, or with no value (remove every parameter), isn't supported by adblock-rust,
  so those rules do nothing. Named parameters (`fbclid`, `gclid`…) are removed.
- Scriptlets don't run in `about:blank` and `srcdoc` frames (uBO's `match_about_blank`).
- HTML filtering (`##^`) and `$csp`/`$permissions` response rules aren't applied; uBO on Chromium has no HTML filtering
  either.
- WebSocket handshakes that Bay opens itself don't get DevTools' extra request headers.

## Existing settings

uBO's settings (paused sites, list choices, enabled state) are not carried over. The new blocker starts from its defaults.

## Verification

`cargo test --locked --manifest-path packages/adblock/Cargo.toml` checks rule matching, redirects, scriptlets,
permissions and procedural resources. `python3 packages/chromium/scripts/test-content-blocker.py` runs the actual native
implementation against the Rust library with temporary storage and controlled offline downloads. The browser's JavaScript
suite exercises cosmetic batching and procedural actions from the real page script. CI runs all three.

After building the matching engine and the Debug app, start Metro and run the `content-blocker`,
`content-blocker-fails-closed`, `content-blocker-blocks`, `content-blocker-profile`, `content-blocker-private`, and
`content-blocker-restored` acceptance checks. The blocked/allowed rounds also check redirect stand-ins, redirected
requests, WebSocket handshakes, a tracked link's cleaned navigation, and that a scriptlet runs before a page's first
inline script, against local fixtures.
