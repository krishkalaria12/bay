package expo.modules.bayengine

import android.webkit.CookieManager
import android.webkit.WebStorage
import androidx.webkit.WebStorageCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class BayEngineModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BayEngine")

    Events("onDownload", "onMediaControl")

    OnCreate {
      BayDownloads.emit = { body -> sendEvent("onDownload", body) }
      BayMedia.emit = { action -> sendEvent("onMediaControl", mapOf("action" to action)) }
    }

    OnDestroy { BayMedia.clear() }

    AsyncFunction("setMediaSession") { title: String?, site: String, playing: Boolean ->
      val context = appContext.reactContext ?: return@AsyncFunction
      if (title == null) BayMedia.clear() else BayMedia.update(context, title, site, playing)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("openDownload") { id: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) promise.reject("E_CONTEXT_LOST", "The browser context is unavailable.", null)
      else BayDownloads.open(context, id, promise)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("cancelDownload") { id: String -> appContext.reactContext?.let { BayDownloads.cancel(it, id) } }

    AsyncFunction("clearData") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("E_CONTEXT_LOST", "The browser context is unavailable.", null)
      } else if (!WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) {
        // The legacy API has no completion callback and does not promise all modern storage types.
        promise.reject("E_WEBVIEW_UPDATE_REQUIRED", "Update Android System WebView to clear all website data.", null)
      } else {
        try {
          WebStorageCompat.deleteBrowsingData(WebStorage.getInstance()) {
            try {
              CookieManager.getInstance().flush()
              BayEngineSnapshots.clear(context)
              promise.resolve(null)
            } catch (error: Exception) {
              promise.reject("E_CLEAR_DATA", "Couldn't clear website data.", error)
            }
          }
        } catch (error: Exception) {
          promise.reject("E_CLEAR_DATA", "Couldn't clear website data.", error)
        }
      }
    }.runOnQueue(Queues.MAIN)

    Constant("privateBrowsingSupported") { BayEngineView.privateBrowsingSupported }

    AsyncFunction("setContentBlocking") { files: List<String>?, version: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("E_CONTEXT_LOST", "The browser context is unavailable.", null)
        return@AsyncFunction
      }
      BayContentBlocker.apply(files, version, context) { result ->
        result.fold({ promise.resolve(null) }, { promise.reject("E_CONTENT_BLOCKING", "Couldn't prepare the content blocker.", it) })
      }
    }.runOnQueue(Queues.MAIN)

    Function("setBlockingPausedHosts") { hosts: List<String> -> BayContentBlocker.setPausedHosts(hosts) }

    Function("setTrackingParameters") { json: String -> BayAdblock.nativeSetTracking(json) }

    View(BayEngineView::class) {
      Events("onNavigationStateChange", "onNavigationError", "onScroll", "onLinkPress", "onPageMessage")
      Prop("pullToRefreshEnabled") { view: BayEngineView, enabled: Boolean -> view.pullToRefreshEnabled = enabled }
      Prop("private") { view: BayEngineView, isPrivate: Boolean -> view.isPrivate = isPrivate }
      Prop("active") { view: BayEngineView, active: Boolean -> view.isActive = active }
      Prop("initialUrl") { view: BayEngineView, url: String? -> view.loadInitial(url) }
      AsyncFunction("load") { view: BayEngineView, url: String -> view.load(url) }
      AsyncFunction("goBack") { view: BayEngineView -> view.webView.goBack() }
      AsyncFunction("goForward") { view: BayEngineView -> view.webView.goForward() }
      AsyncFunction("reload") { view: BayEngineView -> view.reload() }
      AsyncFunction("stop") { view: BayEngineView -> view.stop() }
      AsyncFunction("snapshot") { view: BayEngineView -> view.snapshot() }
      AsyncFunction("evaluate") { view: BayEngineView, script: String, promise: Promise -> view.evaluate(script, promise) }.runOnQueue(Queues.MAIN)
      OnViewDestroys { view: BayEngineView -> view.dispose() }
    }
  }
}
