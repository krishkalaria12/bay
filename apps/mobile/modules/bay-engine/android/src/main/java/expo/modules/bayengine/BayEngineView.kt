package expo.modules.bayengine

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

@SuppressLint("SetJavaScriptEnabled")
class BayEngineView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  val onNavigationStateChange by EventDispatcher()
  val onNavigationError by EventDispatcher()
  private var loading = false
  private var recoveryURL: String? = null
  override val shouldUseAndroidLayout = true
  var webView = createWebView()
    private set

  private fun createWebView(): WebView = WebView(context).apply {
    layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.allowFileAccess = false
    settings.allowContentAccess = false
    settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        !isWebURL(request.url)

      override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        loading = true
        emitState()
      }

      override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) = emitState()

      override fun onPageFinished(view: WebView, url: String?) {
        loading = false
        emitState()
      }

      override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (!request.isForMainFrame) return
        loading = false
        emitState()
        onNavigationError(mapOf("url" to request.url.toString(), "code" to error.errorCode.toString(),
          "message" to error.description.toString()))
      }

      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        recoveryURL = view.url
        removeView(view)
        view.destroy()
        webView = createWebView()
        addView(webView)
        loading = false
        emitState()
        onNavigationError(mapOf("url" to (recoveryURL ?: ""), "code" to "renderer-terminated",
          "message" to "The page stopped responding. Reload to try again."))
        return true
      }
    }
    webChromeClient = object : WebChromeClient() {
      override fun onProgressChanged(view: WebView, newProgress: Int) = emitState()
      override fun onReceivedTitle(view: WebView, title: String?) = emitState()
    }
  }

  init {
    addView(webView)
  }

  fun load(address: String) {
    require(isWebURL(Uri.parse(address))) { "Only HTTP and HTTPS addresses can be opened." }
    recoveryURL = null
    webView.loadUrl(address)
  }

  fun reload() {
    val address = recoveryURL
    if (address == null) webView.reload() else load(address)
  }

  fun stop() {
    webView.stopLoading()
    loading = false
    emitState()
  }

  private fun isWebURL(url: Uri): Boolean =
    url.scheme?.lowercase() in listOf("http", "https") && !url.host.isNullOrEmpty()

  private fun emitState() {
    onNavigationStateChange(mapOf(
      "url" to (webView.url ?: ""),
      "title" to (webView.title ?: ""),
      "progress" to webView.progress / 100.0,
      "isLoading" to loading,
      "canGoBack" to webView.canGoBack(),
      "canGoForward" to webView.canGoForward()
    ))
  }

  fun dispose() {
    webView.stopLoading()
    webView.webChromeClient = null
    webView.webViewClient = WebViewClient()
    removeView(webView)
    webView.destroy()
  }
}
