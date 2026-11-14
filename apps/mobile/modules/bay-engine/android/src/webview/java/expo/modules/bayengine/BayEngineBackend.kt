package expo.modules.bayengine

import android.content.Context
import android.webkit.CookieManager
import android.webkit.WebStorage
import androidx.webkit.WebStorageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.Promise

/**
 * The engine-specific half of BayEngineModule, for the system WebView: what renders pages in a build without Bay's own
 * Chromium (a development build before the engine is fetched). src/chromium has the same object for Bay's engine.
 */
internal object BayEngineBackend {
  /** Which tab-state directory this engine reads and writes (BayEngineTabStates). */
  const val TAB_STATE_FAMILY = "webview"

  val privateBrowsingSupported: Boolean
    get() = BayEngineView.privateBrowsingSupported

  fun engineInfo(context: Context?): Map<String, String> {
    val webView = context?.let { WebViewCompat.getCurrentWebViewPackage(it) }
    return mapOf("family" to "webview", "name" to "System WebView", "version" to (webView?.versionName ?: ""))
  }

  fun setPrivateSessionActive(active: Boolean) = BayEngineView.setPrivateSessionActive(active)

  /** Clears cookies, site storage and the network cache; `done` gets null on success or the error to reject with. */
  fun clearWebsiteData(context: Context, done: (BayEngineError?) -> Unit) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) {
      // The legacy API has no completion callback and does not promise all modern storage types.
      done(BayEngineError("E_WEBVIEW_UPDATE_REQUIRED", "Update Android System WebView to clear all website data."))
      return
    }
    WebStorageCompat.deleteBrowsingData(WebStorage.getInstance()) {
      CookieManager.getInstance().flush()
      done(null)
    }
  }

  fun setContentBlocking(files: List<String>?, version: String, context: Context, onDone: (Result<Unit>) -> Unit) =
    BayContentBlocker.apply(files, version, context, onDone)

  fun setBlockingPausedHosts(hosts: List<String>) = BayContentBlocker.setPausedHosts(hosts)

  fun setTrackingParameters(json: String): Boolean = BayAdblock.nativeSetTracking(json)

  /** A web image saved through Bay's downloader, with the normal session's cookies. */
  fun saveImage(context: Context, url: String, promise: Promise) =
    BayDownloads.saveImage(context, url, { CookieManager.getInstance().getCookie(it) }, promise)

  /** An activity result for a file picker this engine opened; false if it wasn't one. */
  fun deliverActivityResult(payload: expo.modules.kotlin.events.OnActivityResultPayload): Boolean =
    BayFileChooser.deliver(payload)
}
