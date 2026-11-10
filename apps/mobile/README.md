# Bay mobile

Bay for iPhone and Android, built with Expo, Expo Router, HeroUI Native and Expo UI. The local `@bay/engine` module wraps WKWebView on iOS and the system WebView on Android. Bay's own Android Chromium embedder is planned for phase 7. See [AGENTS.md](AGENTS.md) for building, running and driving both apps, and [docs/mobile-plan.html](../../docs/mobile-plan.html) for the roadmap.

Phase 1 adds address entry, native title/URL/loading events, back and forward, reload, stop, and navigation errors. The engine stays mounted while the start page and address editor appear above it. Search suggestions, tabs and the Lens browsing layout follow in phase 2.

```sh
pnpm install
pnpm start    # Metro
pnpm native   # build and install the dev clients on the iOS simulator and Android emulator
pnpm e2e      # Argent e2e tests on both
pnpm test     # address validation
pnpm typecheck
```
