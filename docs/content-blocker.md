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
  redirect, which blocks and collapses the frame.
- **Tracking parameters and URL rewrites** (`$removeparam`, `$urlskip`, `$uritransform`): navigations, main frames
  included, pass through the same interceptor, which only rewrites. A request the lists rewrite gets a redirect to the
  cleaned or extracted URL (an internal 307, or the server's own redirect pointed there) and starts again there, as
  Chrome's webRequest answers an extension's redirect. Subresources are rewritten the same way. `$removeparam` strips
  a name, a `~`-negated name, a `|prefix`, a `/regex/`, or every parameter, and its exceptions cancel the directive
  they name (or all of them), as in uBO. `$urlskip` follows a redirect tracker's own URL out of the request, for the
  resource types uBO can skip (documents, frames, images, media, objects and other), and may cross origins;
  `$uritransform` rewrites the URI first. A paused site keeps its URL.
- **Popups** (`$popup`): the first navigation of a tab or window a page opens goes through a `NavigationThrottle`, as
  does each of its redirects. If the blocker refuses it, the navigation stops before reaching the network and the new
  tab closes. A rule that blocks the page as a document (`$doc`, `$all`) refuses it too, and a `$popup` exception decides
  first. The opener is the context, so a paused opener's popups open.
- **Page visits** (`$doc`, `$all`, a rule that's only a hostname, a hosts-file entry): a main-frame navigation and each of
  its redirects go through the same `NavigationThrottle`. A blocked one stops at Chromium's error page, so the entry
  stays for Back and Reload, and the app covers it with its own page (`BlockedPage`): Go Back, Visit Anyway (until the app
  quits) and Always Allow (saved, listed in Privacy, and never offered in a private window). Those lift only the visit:
  the site's requests are still filtered. A paused site isn't blocked at all. adblock-rust doesn't apply `||host^` to the
  page itself, so `from_lists` marks those rules `$all` (`adapt.rs`), as uBO's strict blocking treats them. As in uBO, a
  link through a listed ad or tracking host stops here too.
- **Document policies** (`$csp`): a navigation's response gets the rules' `Content-Security-Policy` as one more header,
  in the same interceptor, and its parsed headers are cleared so Chrome parses them again and enforces it.
- **Response rules** (`$header`, `$ipaddress`, `$permissions`, `##^responseheader`): the interceptor inspects each
  response, and each redirect's response, before it reaches the renderer. `$header` and `$ipaddress` can refuse it
  (`ERR_BLOCKED_BY_CLIENT`), `$permissions` appends a `Permissions-Policy`, and `##^responseheader` removes `location`,
  `refresh`, `report-to` or `set-cookie`. The response's parsed headers are cleared so Chrome reads the edited ones
  again. The response filter is only installed while the live engine has such rules.
- **WebSockets** go through the browser client's handshake hook before the network connection starts. A paused site
  allows its handshakes too; worker handshakes use the available cookie-site origin when there is no frame.
  While a filter is set, handshakes no extension intercepts are opened by Bay; DevTools' extra request headers are
  applied to them here as well.

The engine only asks; the host decides. `+[NNCoreEngine setRequestFilter:]` takes a C function
(`NNCoreRequestFilter`: url, source, top, type, method → block, plus a data-URL stand-in for a blocked request or a
URL to load instead with whether it may cross origins), which the app's native core
(`packages/chromium/ios/NNCoreContentBlocker.mm`) implements over the Rust engine. `+[NNCoreEngine setResponseFilter:]`
takes a second (`NNCoreResponseFilter`: the request, its remote address and its response headers → block, headers to
add, headers to remove), registered only when the engine has response rules. Blocked requests are counted by the
engine's existing `ERR_BLOCKED_BY_CLIENT` accounting (`tab:didBlockRequests:lastURL:`).

Why there: a CEF resource request handler doesn't exist in this engine (NNCore replaced CEF's browser-side client),
and the app only reaches the engine through `NNCore.h`. Renderer-side throttles would need the engine in every
renderer process. The factory interceptor sees every subresource from one place, with the initiator's origin and the
top frame's, and costs nothing for requests it lets through. It is NNCore code (`//bay/core`), not a Chromium patch,
but it is compiled into Chrome's framework, so it needs an engine build.

**Cosmetic filtering**: the page script (`page_script.js`) says hello from every frame at document start; the host
answers with the site's hiding rules as a user-origin style sheet for that frame
(`-[NNCoreTab insertUserStyle:frame:origin:]`, `mojom::NNPage::InsertUserStyle`; the renderer inserts it only if the
frame still shows a document of that origin), and turns on the page script's survey of classes and ids, whose bounded
reports get the generic rules that hide them. Procedural rules use adblock-rust's selector/action AST in the page
script, including text/style matching, ancestor/XPath selection, removal, attribute/class removal, and style actions.
DOM mutations schedule batched re-evaluation. A blank, `srcdoc` or sandboxed frame has no URL or origin of its own:
the page script and the renderer use the base URL it inherits, so a page can't get a hidden frame past the filters.

**Scriptlets** must run before the page's own scripts (a `set-constant` or `json-prune` that comes later is too late),
so they don't wait for hello. As a document's main world starts, its renderer asks the browser synchronously
(`mojom::NNScriptlets`, answered on a background sequence by `+[NNCoreEngine setScriptletSource:]`'s C function) and
runs the answer before anything else, as Brave does and as an extension's `document_start` script would run. A blank,
`srcdoc` or sandboxed frame asks with the base URL it inherits: pages use such frames to get a window the blocker's
scriptlets haven't touched.

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

adblock-rust's parser drops a whole rule for an option it doesn't know. `packages/adblock/src/modifiers.rs` lifts the
modifier options it can apply out of the list before the engine is built, and applies them itself with uBO's
semantics: `$urlskip`, `$uritransform`, `$removeparam` with its exceptions, `$header`, `$ipaddress`, `$permissions`,
`$strict1p`/`$strict3p`, `##^responseheader`, and generic cosmetic exceptions. `$urlskip` and `$uritransform` are
trusted-only, as in uBO: only the `ublock-*` lists may use them.

The filter syntax is interpreted by adblock-rust, rather than uBO's JavaScript filtering engine. Procedural execution
covers the AST operators and actions that the pinned crate exposes; this is not a claim of identical handling of every
uBO syntax extension.

## Rules adblock-rust rejects

adblock-rust's parser drops a whole rule for one option it doesn't know, silently.
`packages/adblock/src/modifiers.rs` takes the modifier rules above out of the list first; `packages/adblock/src/adapt.rs`
rewrites the rest that can still work before the engines are built:

- `$popup` rules go to their own engine as `$document` rules (3,130 rules in the bundled lists).
- `$denyallow=a|b` becomes the rule plus an exception per host (252). An exception also lifts other rules for those
  hosts in the same context, a little more than uBO does.
- `$reason=` goes and `$doc` goes from a `$csp` rule (40).
- `$popunder` appears only on exceptions, and popunders aren't blocked, so those rules go (25).

## Remaining limits

Counts are for the 11 bundled lists, about 311,000 rules. Most are limits uBO on Chromium shares.

- `$replace` (about 90 rules) rewrites a response body, and HTML `##^` filtering (over 400) parses one; uBO applies both
  only in Firefox, where its API exposes the body. Chromium gives neither the body, so the rules are dropped rather
  than given a meaning uBO doesn't.
- `$requestheader` (1) needs the request's headers, which the filter doesn't carry. Dropped.
- `cname` exceptions (29) and the resolved address behind one need DNS answers Chromium doesn't expose here.
  `$ipaddress` uses the remote endpoint the connection actually used, so a rule against the CDN's address applies, but
  one against an origin behind a CNAME cannot. uBO on Chromium has the same limit.
- `##^responseheader(location)` can't stop a redirect the network stack has already decided; it only removes the header
  from the response the renderer sees. `set-cookie` removal happens after the network stack may have stored the cookie.
  Header rules on Chromium have the same timing.
- `$removeparam` regexes run on Rust's regex engine, with `fancy-regex` for lookaround and backreferences. A construct
  neither supports is skipped rather than applied differently.

## Existing settings

uBO's settings (paused sites, list choices, enabled state) are not carried over. The new blocker starts from its defaults.

## Verification

`cargo test --locked --manifest-path packages/adblock/Cargo.toml` checks rule matching, redirects, scriptlets,
permissions, procedural resources, every modifier rule (URL skips, URI transforms, query pruning, response headers and
addresses) and the serialized engine. `python3 packages/chromium/scripts/test-content-blocker.py` runs the actual
native implementation against the Rust library with temporary storage and controlled offline downloads. The browser's
JavaScript suite exercises cosmetic batching and procedural actions from the real page script, and the native test
covers the response filter and exceptions. CI runs all three.

After building the matching engine and the Debug app, start Metro and run the `content-blocker`,
`content-blocker-fails-closed`, `content-blocker-policies`, `content-blocker-page-block`, `content-blocker-blocks`, `content-blocker-profile`,
`content-blocker-private`, and `content-blocker-restored` acceptance checks. The blocked/allowed rounds also check redirect stand-ins, redirected
requests, WebSocket handshakes, a tracked link's cleaned navigation, and that a scriptlet runs before a page's first
inline script, against local fixtures.
