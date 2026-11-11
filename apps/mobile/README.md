# Bay mobile

Bay for iPhone and Android, built with Expo, Expo Router, HeroUI Native and Expo UI. The local `@bay/engine` module wraps WKWebView on iOS and the system WebView on Android. Bay's own Android Chromium embedder is planned for phase 7. See [AGENTS.md](AGENTS.md) for building, running and driving both apps, and [docs/mobile-plan.html](../../docs/mobile-plan.html) for the roadmap.

The app is a full browser on both platforms: a start page with search suggestions, tabs with a stacked switcher, history and archives, a reader, downloads, a mini player, find on page, per-site settings, ad and tracker blocking with Bay's own Rust blocker, private tabs with a Face ID lock, and the platform pieces (widgets, quick actions, share target, voice search, picture in picture, a default-browser offer).

```sh
pnpm install
pnpm start    # Metro
pnpm native   # build and install the dev clients on the iOS simulator and Android emulator
pnpm e2e      # Argent e2e tests on both
pnpm test     # the unit tests
pnpm typecheck
```

The store builds are EAS ones; see [docs/mobile-releasing.md](../../docs/mobile-releasing.md).
