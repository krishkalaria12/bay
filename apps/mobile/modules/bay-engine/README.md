# Bay engine

Local Expo module imported as `@bay/engine`. The Swift implementation uses `WKWebView`; the Kotlin implementation uses `android.webkit.WebView`. Both export `BayEngine` to Expo and the same TypeScript `EngineView`, `Tab`, navigation state and error types.

Keep `EngineView` mounted and use its ref to request navigation. `load(url)`, `goBack()`, `goForward()`, `reload()` and `stop()` resolve when the native command is dispatched. Observe `onNavigationStateChange` for URL, title, estimated progress, loading and history availability. Main-frame failures are delivered through `onNavigationError`. Page code has no JavaScript bridge to the app.

The app accepts HTTP and HTTPS addresses. `app.plugin.js` enables HTTP for WebKit page loads and Android release builds. Native certificate validation stays enabled. Android disables file/content access and mixed content.

Run `pnpm native` in `apps/mobile` after native changes. Native build folders are generated; edit this module and its config plugin rather than generated projects. The local package is included in the mobile pnpm workspace and discovered by Expo autolinking.
