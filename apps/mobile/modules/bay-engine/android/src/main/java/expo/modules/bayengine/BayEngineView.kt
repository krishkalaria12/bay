package expo.modules.bayengine

import android.Manifest
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Parcel
import android.os.SystemClock
import android.util.Log
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.view.animation.LinearInterpolator
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.HttpAuthHandler
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.net.http.SslError
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.ProfileStore
import androidx.webkit.ScriptHandler
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

@SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
class BayEngineView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  val onNavigationStateChange by EventDispatcher()
  val onNavigationError by EventDispatcher()
  val onScroll by EventDispatcher()
  val onLinkPress by EventDispatcher()
  val onPageMessage by EventDispatcher()
  val onPageRequest by EventDispatcher()
  val onFullscreenChange by EventDispatcher()
  // The system WebView has no isolated worlds: page scripts run in the main world and answer through this bridge,
  // which ignores anything without this view's token. The token rotates on every main-frame navigation, so a
  // previous page's scripts can't answer for the next one. A page can still see `__bayPage` and the Symbol.for
  // state keys; the token is never exposed to it, and JavaScript validates every message it forwards. True
  // isolation waits for our Chromium (phase 7, A5).
  @Volatile private var pageToken = UUID.randomUUID().toString()
  private val scriptHandler = Handler(Looper.getMainLooper())
  private val pendingScripts = ConcurrentHashMap<String, Promise>()
  private var loading = false
  private var recoveryURL: String? = null
  private var disposed = false
  private var startedLoading = false
  /** The tab's saved state (B6): its tab id, or null for private tabs. */
  var stateKey: String? = null
    set(value) {
      if (field == value) return
      field = value
      if (!startedLoading) restoreState()
    }
  /** A saved page came back, so `initialUrl` must not load over it. */
  private var restoredState = false
  /** Automatic reloads after the system kills a page's renderer (one, then the error screen). */
  private var rendererReloads = 0
  private var navigationGeneration = 0
  private var lastTouchX = 0f
  private var lastTouchY = 0f
  private var lastScrollOffset = 0.0
  private var lastScrollEmission = 0L
  private val scrollHandler = Handler(Looper.getMainLooper())
  private var scrollPending = false
  private val emitPendingScroll = Runnable { scrollPending = false; if (!disposed) emitScroll() }
  private var snapshotFile: File? = null
  private val density = resources.displayMetrics.density
  private var pullStartX = 0f
  private var pullStartY = 0f
  private var pulling = false
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
  private val pullThreshold = 64 * density
  private val pullPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    // Mid grey reads on light and dark pages alike; the gap behind it is the page's own top colour (TabPage).
    color = Color.rgb(142, 142, 147)
    strokeWidth = 2.5f * density
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
  }
  /** Past the trigger point in the current pull (one haptic tick when it's crossed). */
  private var pullArmed = false
  /** Released past the trigger: the page stays down with a spinning arc until the reload has started and finished. */
  private var refreshing = false
  private var refreshStartedAt = 0L
  private var refreshSawLoading = false
  /** Edge swipe back/forward (A4): where the finger went down, which edge, and whether it is being dragged. */
  private var edgeStartX = 0f
  private var edgeStartY = 0f
  /** -1: left edge, swipe right to go back; 1: right edge, swipe left to go forward; 0: neither. */
  private var edgeDirection = 0
  private var edgeSwiping = false
  /** Past the trigger point in the current edge swipe (one haptic tick when it's crossed). */
  private var edgeArmed = false
  /** Video fullscreen (A2): the custom view and its hidden callback, plus the orientation to restore. */
  private var customView: View? = null
  private var customViewCallback: WebChromeClient.CustomViewCallback? = null
  private var originalOrientation: Int? = null
  private var backCallback: OnBackPressedCallback? = null
  /** Page requests (I3): results held until the shared sheet answers; one per dialog. */
  private val pendingPageRequests = ConcurrentHashMap<String, android.webkit.JsResult>()
  /** HTTP sign-in challenges (B3), held until the shared sheet answers; one per challenge. */
  private val pendingAuthRequests = ConcurrentHashMap<String, HttpAuthHandler>()
  /** Links to other apps (B5), held until the shared sheet answers; one per link. */
  private val pendingExternalRequests = ConcurrentHashMap<String, String>()
  /** Camera and microphone requests (B7), held until the shared sheet answers and the system grants them. */
  private val pendingMediaRequests = ConcurrentHashMap<String, PendingMedia>()
  /** Location requests (B7), held until the shared sheet answers and the system grants it. */
  private val pendingLocationRequests = ConcurrentHashMap<String, PendingLocation>()
  private val spinner = ValueAnimator.ofFloat(0f, 360f).apply {
    duration = 750
    repeatCount = ValueAnimator.INFINITE
    interpolator = LinearInterpolator()
    addUpdateListener { onSpin() }
  }
  var pullToRefreshEnabled = true
  /** The page this view shows, read on WebView's network threads to judge subresources. */
  @Volatile private var pageUrl: String? = null
  /** Hosts this view moved from HTTP to HTTPS, with when; an HTTPS page that sends it straight back keeps HTTP. */
  private val upgradedHosts = mutableMapOf<String, Long>()
  private var usesPrivateProfile = false
  private var scriptlets: ScriptHandler? = null

  /** Private pages use a separate WebView profile, deleted when the last private page closes. Set before the first load. */
  var isPrivate = false
    set(value) {
      if (field == value) return
      field = value
      if (!startedLoading) replaceWebView()
    }

  /** Hidden tabs stay mounted; keep them out of TalkBack. */
  var isActive = true
    set(value) {
      field = value
      webView.importantForAccessibility = if (value) IMPORTANT_FOR_ACCESSIBILITY_AUTO else IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
      // Leaving the screen is a good moment to save (B6): the tab may be the next one unmounted for memory.
      if (!value) saveState()
    }
  /**
   * Hidden tabs that aren't playing media pause: Chromium then reports the page hidden and stops its animation frames
   * and compositing. Applied to every WebView this view creates.
   */
  var isSuspended = false
    set(value) {
      if (field == value) return
      field = value
      if (value) {
        webView.onPause()
        webView.visibility = INVISIBLE
      } else {
        webView.visibility = VISIBLE
        webView.onResume()
      }
    }
  override val shouldUseAndroidLayout = true
  var webView = createWebView()
    private set

  private fun createWebView(): WebView = WebView(context).apply {
    // A profile must be set before anything else touches the WebView.
    usesPrivateProfile = isPrivate && privateBrowsingSupported
    if (usesPrivateProfile) {
      ProfileStore.getInstance().getOrCreateProfile(PRIVATE_PROFILE)
      WebViewCompat.setProfile(this, PRIVATE_PROFILE)
      privateViews += 1
    }
    layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    importantForAccessibility = if (isActive) IMPORTANT_FOR_ACCESSIBILITY_AUTO else IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    if (isSuspended) {
      onPause()
      visibility = INVISIBLE
    }
    CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
    addJavascriptInterface(BayContentBlocker.Bridge(), "__bayCosmetic")
    addJavascriptInterface(PageBridge(), "__bayPage")
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      WebViewCompat.addDocumentStartJavaScript(this, BayContentBlocker.COSMETIC_SCRIPT, setOf("*"))
    }
    // Google won't sign anyone in from what it can tell is an app's embedded WebView ("This browser or app may not be
    // secure", OAuth's disallowed_useragent): it looks for the `; wv` and `Version/4.0` tokens in the user agent and
    // the X-Requested-With header naming the app. Bay is a browser, so it presents as Chrome does.
    settings.userAgentString = settings.userAgentString.replace("; wv)", ")").replace(Regex(" Version/[\\d.]+"), "")
    if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
      WebSettingsCompat.setRequestedWithHeaderOriginAllowList(settings, emptySet())
    }
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.allowFileAccess = false
    settings.allowContentAccess = false
    settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    // Camera, microphone and location (B7) are asked for through the shared sheet; the page gets access only when allowed.
    settings.setGeolocationEnabled(true)
    // Pinch to zoom, without the old on-screen +/- buttons. A site's viewport limits still apply.
    settings.builtInZoomControls = true
    settings.displayZoomControls = false
    overScrollMode = OVER_SCROLL_NEVER
    setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
      // A private page's cookies are in its own profile. Asked per address, so a redirect to another host gets its own.
      val cookieManager = if (usesPrivateProfile) ProfileStore.getInstance().getProfile(PRIVATE_PROFILE)?.cookieManager else CookieManager.getInstance()
      // File hosts often refuse a download that doesn't say which page it came from.
      BayDownloads.start(context, url, userAgent, contentDisposition, mimeType, { address -> cookieManager?.getCookie(address) }, this.url, usesPrivateProfile)
      // The navigation became a download and never finishes, so the page stops loading here, back on the page it
      // started from. A tab that had no page yet (a download link typed into a new tab) says so, so it goes back to
      // the start page instead of keeping the file's address and downloading it again when it's restored.
      loading = false
      val committed = copyBackForwardList().currentItem?.url
      if (committed == null) {
        onNavigationStateChange(mapOf("url" to "", "title" to "", "progress" to 0.0, "isLoading" to false,
          "canGoBack" to false, "canGoForward" to false, "blank" to true))
      } else {
        emitState(committed)
      }
    }
    setOnTouchListener { _, event ->
      if (event.actionMasked == MotionEvent.ACTION_DOWN) {
        lastTouchX = event.x
        lastTouchY = event.y
      }
      false
    }
    setOnLongClickListener {
      val hit = hitTestResult
      if (hit.type != WebView.HitTestResult.SRC_ANCHOR_TYPE && hit.type != WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE) {
        false
      } else {
        val generation = navigationGeneration
        val pointX = (lastTouchX / max(1, width)).coerceIn(0f, 1f)
        val pointY = (lastTouchY / max(1, height)).coerceIn(0f, 1f)
        val fallback = if (hit.type == WebView.HitTestResult.SRC_ANCHOR_TYPE) hit.extra else null
        val handler = Handler(Looper.getMainLooper()) { message ->
          val url = message.data.getString("url") ?: fallback
          if (!disposed && this === webView && generation == navigationGeneration && url != null && isWebURL(Uri.parse(url))) {
            val title = message.data.getString("title")?.takeIf { it.isNotBlank() } ?: url
            onLinkPress(mapOf("url" to url, "title" to title.take(240), "x" to pointX, "y" to pointY))
          }
          true
        }
        requestFocusNodeHref(handler.obtainMessage())
        true
      }
    }
    setOnScrollChangeListener { _, _, _, _, _ -> scheduleScroll() }
    webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val scheme = request.url.scheme?.lowercase()
        if (scheme == "blob" || scheme == "data") {
          // A main-frame jump to a page blob (window.location = "blob:…") would otherwise be dropped. The blob
          // belongs to the current page, so fetch it there and hand it to native as a download instead.
          if (request.isForMainFrame) downloadBlobOrData(view, request.url.toString())
          return true
        }
        if (!isWebURL(request.url)) {
          // A link to another app asks first (B5); the page stays where it is either way.
          if (request.isForMainFrame && isExternalURL(request.url)) requestExternal(request.url.toString())
          return true
        }
        if (!request.isForMainFrame || request.method != "GET") return false
        val replacement = replacementFor(request.url.toString())
        if (replacement == null) {
          prepareScriptlets(request.url.toString())
          return false
        }
        pageUrl = replacement
        prepareScriptlets(replacement)
        view.loadUrl(replacement)
        return true
      }

      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
        BayContentBlocker.intercept(request, pageUrl)

      override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        // Certificate errors are never bypassed; an upgraded page falls back to the HTTP address it came from.
        handler.cancel()
        if (fallBackToHttp(error.url)) return
        onNavigationError(mapOf("url" to error.url, "code" to "ssl-${error.primaryError}", "message" to "This site's security certificate isn't valid."))
      }

      // HTTP sign-in (B3): Basic, Digest and NTLM challenges wait for the shared sheet instead of failing the load.
      override fun onReceivedHttpAuthRequest(view: WebView?, handler: HttpAuthHandler?, host: String?, realm: String?) {
        if (handler == null) return
        val id = UUID.randomUUID().toString()
        pendingAuthRequests[id] = handler
        emitPageRequest(id, "auth", "", null, view?.url ?: pageUrl, realm)
      }

      override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        cancelScripts("The page navigated before the script finished.")
        // A new document gets a new bridge token (A5): a previous page's scripts can't answer for this one. The
        // interceptor and the media watcher are (re)installed below with this token; hash/history navigations
        // keep the document (and its watcher), so they don't rotate here.
        pageToken = UUID.randomUUID().toString()
        pageUrl = url
        navigationGeneration += 1
        hideFullscreen()
        loading = true
        emitState()
        installBlobInterceptor(view)
      }

      override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) = emitState()

      override fun onPageFinished(view: WebView, url: String?) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
          view.evaluateJavascript(BayContentBlocker.COSMETIC_SCRIPT, null)
        }
        loading = false
        rendererReloads = 0
        emitState()
        // A finished load is worth keeping, so a relaunch or a remounted tab gets its history back (B6).
        saveState()
        installBlobInterceptor(view)
      }

      override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (!request.isForMainFrame) return
        val insecure = error.errorCode in listOf(ERROR_CONNECT, ERROR_FAILED_SSL_HANDSHAKE, ERROR_TIMEOUT)
        if (insecure && fallBackToHttp(request.url.toString())) return
        loading = false
        emitState()
        onNavigationError(mapOf("url" to request.url.toString(), "code" to error.errorCode.toString(),
          "message" to error.description.toString()))
      }

      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        cancelScripts("The page renderer stopped.")
        val failedURL = view.url ?: pageUrl
        recoveryURL = failedURL
        navigationGeneration += 1
        removeView(view)
        view.destroy()
        scriptlets = null
        releasePrivateProfile()
        webView = createWebView()
        addView(webView)
        loading = false
        // The system killed the page to reclaim memory; reopen it once before showing the error screen (B6).
        if (rendererReloads < 1 && !failedURL.isNullOrEmpty()) {
          rendererReloads += 1
          load(failedURL)
          // `load` clears it, but a retry that fails still needs the address to reload.
          recoveryURL = failedURL
          return true
        }
        emitState()
        onNavigationError(mapOf("url" to (failedURL ?: ""), "code" to "renderer-terminated",
          "message" to "The page stopped responding. Reload to try again."))
        return true
      }
    }
    webChromeClient = object : WebChromeClient() {
      override fun onProgressChanged(view: WebView, newProgress: Int) = emitState()
      override fun onReceivedTitle(view: WebView, title: String?) = emitState()

      // File upload (A1): the system's picker for <input type="file">. WebKit opens it natively on iOS.
      override fun onShowFileChooser(
        webview: WebView?,
        filePathCallback: ValueCallback<Array<Uri>>,
        fileChooserParams: FileChooserParams?,
      ): Boolean {
        BayFileChooser.cancelPending()
        val activity = activityFor(context)
        if (activity == null) {
          filePathCallback.onReceiveValue(null)
          return false
        }
        BayFileChooser.setPending(filePathCallback)
        val intent = try {
          fileChooserParams?.createIntent()
        } catch (_: Exception) {
          null
        } ?: Intent(Intent.ACTION_GET_CONTENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          val types = fileChooserParams?.acceptTypes?.filter { it.isNotBlank() } ?: emptyList()
          when {
            types.isEmpty() -> type = "*/*"
            types.size == 1 -> type = types[0]
            else -> {
              type = "*/*"
              putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
            }
          }
          putExtra(Intent.EXTRA_ALLOW_MULTIPLE, fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
        }
        return try {
          activity.startActivityForResult(intent, BayFileChooser.REQUEST_CODE)
          true
        } catch (_: Exception) {
          BayFileChooser.setPending(null)
          filePathCallback.onReceiveValue(null)
          false
        }
      }

      // Video fullscreen (A2): a site's player view (and native <video> fullscreen) arrives here. iOS handles
      // this natively too, with isElementFullscreenEnabled on the WebKit side.
      override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
        if (view == null || callback == null) return
        showFullscreen(view, callback)
      }

      override fun onHideCustomView() = hideFullscreen()

      // Page requests (I3): alert/confirm/prompt are held for the shared sheet instead of the default Material dialogs.
      override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
        if (result == null) return false
        val id = UUID.randomUUID().toString()
        pendingPageRequests[id] = result
        emitPageRequest(id, "alert", message ?: "", null, url)
        return true
      }

      override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
        if (result == null) return false
        val id = UUID.randomUUID().toString()
        pendingPageRequests[id] = result
        emitPageRequest(id, "confirm", message ?: "", null, url)
        return true
      }

      override fun onJsPrompt(view: WebView?, url: String?, message: String?, defaultValue: String?, result: JsPromptResult?): Boolean {
        if (result == null) return false
        val id = UUID.randomUUID().toString()
        pendingPageRequests[id] = result
        emitPageRequest(id, "prompt", message ?: "", defaultValue, url)
        return true
      }

      // Camera and microphone (B7): the shared sheet asks, then the system runtime permission is requested before the
      // page gets access. A request with no camera or microphone resource is refused outright.
      override fun onPermissionRequest(request: PermissionRequest?) {
        if (request == null) return
        val resources = request.resources.orEmpty().filter {
          it == PermissionRequest.RESOURCE_VIDEO_CAPTURE || it == PermissionRequest.RESOURCE_AUDIO_CAPTURE
        }.toTypedArray()
        if (resources.isEmpty()) {
          runCatching { request.deny() }
          return
        }
        val video = resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
        val audio = resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
        val permission = when {
          video && audio -> "camera-microphone"
          video -> "camera"
          else -> "microphone"
        }
        val system = buildList {
          if (video) add(Manifest.permission.CAMERA)
          if (audio) add(Manifest.permission.RECORD_AUDIO)
        }.toTypedArray()
        val id = UUID.randomUUID().toString()
        pendingMediaRequests[id] = PendingMedia(request, resources, system)
        emitPageRequest(id, "permission", "", null, webView.url ?: pageUrl, permission = permission)
      }

      // Location (B7): the shared sheet asks, then the system location permission is requested.
      override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) {
        if (origin == null || callback == null) return
        val id = UUID.randomUUID().toString()
        pendingLocationRequests[id] = PendingLocation(origin, callback)
        emitPageRequest(id, "permission", "", null, webView.url ?: pageUrl, permission = "location")
      }
    }
  }

  init {
    addView(webView)
  }

  fun load(address: String) {
    check(!disposed) { "This page view has been disposed." }
    require(isWebURL(Uri.parse(address))) { "Only HTTP and HTTPS addresses can be opened." }
    cancelPageRequests()
    recoveryURL = null
    startedLoading = true
    val target = replacementFor(address) ?: address
    pageUrl = target
    prepareScriptlets(target)
    webView.loadUrl(target)
    // WebView reports a start only once the first response arrives, which on a slow network leaves the old page
    // looking settled for seconds. Report the load now, as WebKit does.
    loading = true
    emitState(pending = target)
  }

  /**
   * Registers the scriptlets for `url`'s page as a document-start script limited to its origin, before it loads, so
   * they run in the page's main world ahead of its own scripts. Each main-frame navigation replaces them.
   */
  private fun prepareScriptlets(url: String) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
    scriptlets?.remove()
    scriptlets = null
    val uri = Uri.parse(url)
    val host = uri.host ?: return
    val script = runCatching { BayContentBlocker.scriptlets(url) }.getOrDefault("")
    if (script.isEmpty()) return
    val origin = "${uri.scheme}://$host" + if (uri.port != -1) ":${uri.port}" else ""
    scriptlets = WebViewCompat.addDocumentStartJavaScript(webView, "try{$script}catch(e){}", setOf(origin))
    android.util.Log.d("BayAdblock", "scriptlets for $host: ${script.length} chars")
  }

  /** Rejects every script still waiting for the page. */
  private fun cancelScripts(message: String) {
    scriptHandler.removeCallbacksAndMessages(null)
    pendingScripts.keys.toList().forEach { id -> pendingScripts.remove(id)?.reject("E_PAGE_CLOSED", message, null) }
  }

  /** Runs a page script and resolves with its result as JSON text (see the TypeScript `Tab.evaluate`). */
  fun evaluate(script: String, promise: Promise) {
    if (disposed) {
      promise.reject("E_PAGE_CLOSED", "The page is closed.", null)
      return
    }
    val id = UUID.randomUUID().toString()
    pendingScripts[id] = promise
    scriptHandler.postAtTime({ pendingScripts.remove(id)?.reject("E_PAGE_SCRIPT", "The page didn't answer.", null) }, id, SystemClock.uptimeMillis() + 10_000)
    val token = JSONObject.quote(pageToken)
    webView.evaluateJavascript(
      """
      (() => {
        const post = (message) => __bayPage.post($token, JSON.stringify(message));
        (async () => {
        $script
        })().then(
          (value) => __bayPage.resolve($token, "$id", JSON.stringify(value === undefined ? null : value)),
        ).catch((error) => __bayPage.reject($token, "$id", String((error && error.message) || error)));
      })();
      """.trimIndent(),
      null,
    )
  }

  private inner class PageBridge {
    @JavascriptInterface
    fun resolve(token: String, id: String, json: String) {
      if (token == pageToken) { scriptHandler.removeCallbacksAndMessages(id); pendingScripts.remove(id)?.resolve(json) }
    }

    @JavascriptInterface
    fun reject(token: String, id: String, message: String) {
      if (token == pageToken) { scriptHandler.removeCallbacksAndMessages(id); pendingScripts.remove(id)?.reject("E_PAGE_SCRIPT", message, null) }
    }

    @JavascriptInterface
    fun post(token: String, json: String) {
      if (token == pageToken) post { if (!disposed) onPageMessage(mapOf("message" to json)) }
    }

    /** A blob: or data: download fetched by the page (A3), handed over as base64 for Bay to save. */
    @JavascriptInterface
    fun blobDownload(token: String, filename: String?, mime: String?, base64: String?) {
      if (token != pageToken || base64 == null) return
      // The whole file crosses the bridge at once; refuse pathological sizes rather than OOM the app.
      if (base64.length > MAX_BLOB_BASE64) return
      val bytes = try {
        android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
      } catch (_: Exception) {
        return
      }
      val appContext = context.applicationContext ?: context
      BayDownloads.saveBlob(appContext, filename ?: "download", mime, bytes, this@BayEngineView.pageUrl ?: "", this@BayEngineView.usesPrivateProfile)
    }
  }

  /** Unwraps the activity behind a view's context, or null outside one. */
  private fun activityFor(ctx: Context): Activity? {
    var current: Context? = ctx
    while (current is ContextWrapper) {
      if (current is Activity) return current
      current = current.baseContext
    }
    return null
  }

  // MARK: Page requests (I3)

  private fun emitPageRequest(id: String, kind: String, message: String, defaultValue: String?, url: String?, realm: String? = null, externalUrl: String? = null, permission: String? = null) {
    val body = mutableMapOf<String, Any>("id" to id, "kind" to kind, "message" to message.take(2000), "url" to (url ?: pageUrl ?: ""))
    if (defaultValue != null) body["defaultValue"] = defaultValue.take(2000)
    if (!realm.isNullOrEmpty()) body["realm"] = realm.take(200)
    if (externalUrl != null) body["externalUrl"] = externalUrl.take(2048)
    if (permission != null) body["permission"] = permission
    onPageRequest(body)
  }

  fun answerPageRequest(id: String, accepted: Boolean, value: String?, username: String?, password: String?) {
    val external = pendingExternalRequests.remove(id)
    if (external != null) {
      if (accepted) openExternal(external)
      return
    }
    val media = pendingMediaRequests[id]
    if (media != null) {
      if (!accepted) {
        pendingMediaRequests.remove(id)
        runCatching { media.request.deny() }
        return
      }
      requestSystemPermissions(media.permissions) { granted ->
        val pending = pendingMediaRequests.remove(id)
        if (pending != null) runCatching { if (granted) pending.request.grant(pending.resources) else pending.request.deny() }
      }
      return
    }
    val location = pendingLocationRequests[id]
    if (location != null) {
      if (!accepted) {
        pendingLocationRequests.remove(id)
        runCatching { location.callback.invoke(location.origin, false, false) }
        return
      }
      requestSystemPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), requireAll = false) { granted ->
        val pending = pendingLocationRequests.remove(id)
        if (pending != null) runCatching { pending.callback.invoke(pending.origin, granted, false) }
      }
      return
    }
    val auth = pendingAuthRequests.remove(id)
    if (auth != null) {
      try {
        if (accepted) auth.proceed(username ?: "", password ?: "") else auth.cancel()
      } catch (_: Exception) {
      }
      return
    }
    val result = pendingPageRequests.remove(id) ?: return
    try {
      if (result is JsPromptResult) {
        if (accepted) result.confirm(value ?: "") else result.cancel()
      } else {
        if (accepted) result.confirm() else result.cancel()
      }
    } catch (_: Exception) {
    }
  }

  private fun cancelPageRequests() {
    val pending = pendingPageRequests.values.toList()
    pendingPageRequests.clear()
    for (result in pending) try { result.cancel() } catch (_: Exception) {}
    val pendingAuth = pendingAuthRequests.values.toList()
    pendingAuthRequests.clear()
    for (handler in pendingAuth) try { handler.cancel() } catch (_: Exception) {}
    pendingExternalRequests.clear()
    val pendingMedia = pendingMediaRequests.values.toList()
    pendingMediaRequests.clear()
    for (media in pendingMedia) runCatching { media.request.deny() }
    val pendingLocation = pendingLocationRequests.values.toList()
    pendingLocationRequests.clear()
    for (location in pendingLocation) runCatching { location.callback.invoke(location.origin, false, false) }
  }

  /** Asks the system for runtime permissions (B7); `done` receives whether they were granted (`requireAll` or any). */
  private fun requestSystemPermissions(permissions: Array<String>, requireAll: Boolean = true, done: (Boolean) -> Unit) {
    val manager = appContext.permissions
    if (manager == null) {
      done(false)
      return
    }
    val granted = {
      if (requireAll) permissions.all { manager.hasGrantedPermissions(it) }
      else permissions.any { manager.hasGrantedPermissions(it) }
    }
    if (granted()) {
      done(true)
      return
    }
    Permissions.askForPermissionsWithPermissionsManager(manager, object : Promise {
      // The aggregate result doesn't distinguish an approximate location from a refusal, so ask the manager again.
      override fun resolve(value: Any?) {
        done(granted())
      }

      override fun reject(code: String?, message: String?, cause: Throwable?) {
        done(false)
      }
    }, *permissions)
  }

  // MARK: Video fullscreen (A2)

  private fun showFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
    if (disposed || customView != null) {
      callback.onCustomViewHidden()
      return
    }
    val activity = activityFor(context) ?: run {
      callback.onCustomViewHidden()
      return
    }
    customView = view
    customViewCallback = callback
    view.keepScreenOn = true
    val decor = activity.window.decorView as ViewGroup
    decor.addView(view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    originalOrientation = activity.requestedOrientation
    // Landscape for the video; the app follows the system orientation (B10), so this turns the whole activity
    // sideways for the player and restores whatever was current when the player's view hides.
    activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
    hideSystemUI(activity)
    registerFullscreenBack(activity)
    onFullscreenChange(mapOf("fullscreen" to true))
  }

  private fun hideFullscreen() {
    val view = customView ?: return
    customView = null
    val callback = customViewCallback
    customViewCallback = null
    backCallback?.remove()
    backCallback = null
    val activity = activityFor(context)
    if (activity != null) {
      (view.parent as? ViewGroup)?.removeView(view)
      if (originalOrientation != null) {
        activity.requestedOrientation = originalOrientation!!
        originalOrientation = null
      }
      showSystemUI(activity)
    }
    callback?.onCustomViewHidden()
    if (!disposed) onFullscreenChange(mapOf("fullscreen" to false))
  }

  private fun registerFullscreenBack(activity: Activity) {
    val callback = backCallback
    if (callback != null) return
    val appCompat = activity as? AppCompatActivity
    val back = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (customView != null) {
          hideFullscreen()
        } else {
          isEnabled = false
          appCompat?.onBackPressedDispatcher?.onBackPressed()
          isEnabled = true
        }
      }
    }
    // AppCompatActivity exposes the dispatcher; without it fullscreen still exits via the site's own control.
    appCompat?.onBackPressedDispatcher?.addCallback(activity, back)
    backCallback = back
  }

  private fun hideSystemUI(activity: Activity) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val controller = activity.window.insetsController
      controller?.hide(WindowInsets.Type.systemBars())
      controller?.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    } else {
      @Suppress("DEPRECATION")
      activity.window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or
        View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
        View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    }
  }

  private fun showSystemUI(activity: Activity) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      activity.window.insetsController?.show(WindowInsets.Type.systemBars())
    } else {
      @Suppress("DEPRECATION")
      activity.window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
        View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
    }
  }

  // MARK: blob: and data: downloads (A3)

  /**
   * Intercepts `<a download href="blob:…">` and `data:` clicks that the system WebView never reports to the
   * download listener, fetches the bytes in the page, and hands them to [PageBridge.blobDownload] as base64.
   * The token lives in the Symbol state (not a closure) so re-installing after a token rotation updates it
   * without re-binding listeners.
   */
  private fun installBlobInterceptor(view: WebView) {
    if (disposed) return
    val token = JSONObject.quote(pageToken)
    view.evaluateJavascript(
      """
      (() => {
        const state = (window[Symbol.for("bay.blob")] ??= { installed: false, token: null });
        state.token = $token;
        if (state.installed) return true;
        state.installed = true;
        document.addEventListener("click", async (event) => {
          const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
          if (!anchor) return;
          const href = anchor.href || "";
          if (!href.startsWith("blob:") && !href.startsWith("data:")) return;
          if (!anchor.hasAttribute("download") && !href.startsWith("blob:")) return;
          event.preventDefault();
          event.stopPropagation();
          try {
            const response = await fetch(href);
            const blob = await response.blob();
            const filename = anchor.getAttribute("download") || anchor.download || "download";
            const mime = blob.type || anchor.type || "application/octet-stream";
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let binary = "";
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
            }
            __bayPage.blobDownload(state.token, filename.slice(0, 500), mime.slice(0, 200), btoa(binary));
          } catch (error) {}
        }, true);
        return true;
      })();
      """.trimIndent(),
      null,
    )
  }

  /** A main-frame jump to a blob: (window.location), fetched from the page that created it. */
  private fun downloadBlobOrData(view: WebView, href: String) {
    val token = JSONObject.quote(pageToken)
    val quoted = JSONObject.quote(href)
    view.evaluateJavascript(
      """
      (async () => {
        try {
          const response = await fetch($quoted);
          const blob = await response.blob();
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
          }
          __bayPage.blobDownload($token, "download", blob.type || "application/octet-stream", btoa(binary));
        } catch (error) {}
      })();
      """.trimIndent(),
      null,
    )
  }

  /** The address without tracking parameters, or upgraded to HTTPS; null when it should load as it is. */
  private fun replacementFor(address: String): String? = BayAdblock.nativeCleanUrl(address) ?: httpsUpgrade(address)

  private fun httpsUpgrade(address: String): String? {
    val uri = Uri.parse(address)
    val host = uri.host?.lowercase() ?: return null
    if (uri.scheme?.lowercase() != "http" || BayHttps.isLocal(host) || host in BayHttps.httpOnlyHosts) return null
    val upgraded = upgradedHosts[host]
    if (upgraded != null && SystemClock.uptimeMillis() - upgraded < 5_000) {
      // The HTTPS page redirected back to HTTP: the site doesn't serve HTTPS properly, so keep HTTP.
      BayHttps.httpOnlyHosts += host
      return null
    }
    upgradedHosts[host] = SystemClock.uptimeMillis()
    val authority = if (uri.port == 80) uri.host else uri.encodedAuthority
    return uri.buildUpon().scheme("https").encodedAuthority(authority).build().toString()
  }

  /** After an upgraded HTTPS load fails to connect, loads its HTTP address instead; returns true when it did. */
  private fun fallBackToHttp(address: String): Boolean {
    val uri = Uri.parse(address)
    val host = uri.host?.lowercase() ?: return false
    if (uri.scheme != "https" || host !in upgradedHosts) return false
    BayHttps.httpOnlyHosts += host
    val insecure = uri.buildUpon().scheme("http").build().toString()
    pageUrl = insecure
    webView.loadUrl(insecure)
    return true
  }

  private fun replaceWebView() {
    scriptlets = null
    val previous = webView
    removeView(previous)
    previous.destroy()
    releasePrivateProfile()
    webView = createWebView()
    addView(webView)
  }

  private fun releasePrivateProfile() {
    if (!usesPrivateProfile) return
    usesPrivateProfile = false
    privateViews -= 1
    // The profile's cookies and storage go with it once no private page is left.
    if (privateViews == 0) runCatching { ProfileStore.getInstance().deleteProfile(PRIVATE_PROFILE) }
  }

  /** Loads once, when the view is created, unless a navigation already started. Invalid addresses are ignored. */
  fun loadInitial(address: String?) {
    if (startedLoading || disposed || address.isNullOrEmpty() || !isWebURL(Uri.parse(address))) return
    // Wait a turn so the other initial props (`private` in particular) apply first.
    post {
      if (startedLoading || disposed) return@post
      // A restored page supplies its own address and history; only fall back if WebView drops it.
      if (restoredState) {
        val saved = address
        postDelayed({
          if (!startedLoading && !disposed && webView.url == null && webView.copyBackForwardList().currentItem == null) load(saved)
        }, 1_000)
        return@post
      }
      load(address)
    }
  }

  /** Restores the tab's back/forward history from its state file (B6), before its first load. */
  private fun restoreState() {
    if (isPrivate) return
    val key = stateKey ?: return
    val bundle = BayEngineTabStates.load(context, key) ?: return
    val restored = runCatching { webView.restoreState(bundle) }.getOrNull()
    if (restored == null || (restored.size == 0 && webView.url == null)) return
    startedLoading = true
    loading = false
    restoredState = true
    emitState()
  }

  /** Saves the page state for `stateKey` now (B6); private tabs leave nothing behind. */
  fun saveState() {
    if (disposed || isPrivate) return
    val key = stateKey ?: return
    val bundle = Bundle()
    webView.saveState(bundle)
    BayEngineTabStates.save(context, key, bundle)
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

  /** Draws the page on the main thread, then encodes and writes the JPEG on [snapshotWriter]. A suspended page resolves null: it may not have drawn. */
  fun snapshot(promise: Promise) {
    if (disposed || isSuspended || webView.width <= 0 || webView.height <= 0 || webView.url == null) {
      promise.resolve(null)
      return
    }
    val ratio = min(1.0, 640.0 / webView.width)
    val bitmap = Bitmap.createBitmap(max(1, (webView.width * ratio).toInt()), max(1, (webView.height * ratio).toInt()), Bitmap.Config.ARGB_8888)
    try {
      val canvas = Canvas(bitmap)
      canvas.scale(ratio.toFloat(), ratio.toFloat())
      webView.draw(canvas)
    } catch (error: Exception) {
      bitmap.recycle()
      promise.reject("E_SNAPSHOT", "Couldn't draw the page snapshot.", error)
      return
    }
    val directory = BayEngineSnapshots.directory(context)
    snapshotWriter.execute {
      val file = File(directory, "${UUID.randomUUID()}.jpg")
      try {
        check(directory.isDirectory || directory.mkdirs()) { "Couldn't create the snapshot cache." }
        file.outputStream().use { if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 75, it)) throw IOException("Couldn't encode the page snapshot.") }
        // Only this single thread touches snapshotFile, so swaps can't race.
        val previous = snapshotFile
        snapshotFile = file
        previous?.delete()
        promise.resolve(Uri.fromFile(file).toString())
      } catch (error: Exception) {
        file.delete()
        promise.reject("E_SNAPSHOT", "Couldn't save the page snapshot.", error)
      } finally {
        bitmap.recycle()
      }
    }
  }

  private fun scheduleScroll() {
    if (disposed) return
    val elapsed = SystemClock.uptimeMillis() - lastScrollEmission
    if (elapsed >= 50) {
      scrollHandler.removeCallbacks(emitPendingScroll)
      scrollPending = false
      emitScroll()
    } else if (!scrollPending) {
      scrollPending = true
      scrollHandler.postDelayed(emitPendingScroll, 50 - elapsed)
    }
  }

  private fun emitScroll() {
    val offset = max(0.0, webView.scrollY / density.toDouble())
    val delta = offset - lastScrollOffset
    lastScrollOffset = offset
    lastScrollEmission = SystemClock.uptimeMillis()
    onScroll(mapOf("offsetY" to offset, "deltaY" to delta))
  }

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
    if (disposed || webView.url == null) return super.onInterceptTouchEvent(event)
    // A second finger is a pinch, never a pull or an edge swipe.
    if (event.pointerCount > 1) {
      if (edgeSwiping) {
        edgeSwiping = false
        edgeArmed = false
        settleEdge()
      }
      return super.onInterceptTouchEvent(event)
    }
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        pullStartX = event.x
        pullStartY = event.y
        pulling = false
        pullArmed = false
        edgeStartX = event.x
        edgeStartY = event.y
        edgeSwiping = false
        edgeArmed = false
        // Edge swipe (A4): the first 24dp at each side, matching iOS's allowsBackForwardNavigationGestures.
        // A direction is only armed when there's history that way, so a swipe without history stays the page's.
        val edgeWidth = 24 * density
        edgeDirection = when {
          event.x < edgeWidth && webView.canGoBack() -> -1
          event.x > width - edgeWidth && webView.canGoForward() -> 1
          else -> 0
        }
      }
      MotionEvent.ACTION_MOVE -> {
        // Pull to refresh keeps its rules; edge swipe runs alongside it. Both steal the gesture once the
        // movement is clearly theirs, and both need the other not to have started first.
        if (!pulling && !edgeSwiping && pullToRefreshEnabled && !loading && !refreshing) {
          val distance = event.y - pullStartY
          if (!webView.canScrollVertically(-1) && distance > touchSlop * 2 && distance > abs(event.x - pullStartX) * 1.5) {
            pulling = true
            parent?.requestDisallowInterceptTouchEvent(true)
            return true
          }
        }
        if (!edgeSwiping && !pulling && edgeDirection != 0) {
          val dx = event.x - edgeStartX
          val dy = event.y - edgeStartY
          val towardHistory = if (edgeDirection == -1) dx > 0 else dx < 0
          if (towardHistory && abs(dx) > touchSlop * 2 && abs(dx) > abs(dy) * 1.5) {
            edgeSwiping = true
            parent?.requestDisallowInterceptTouchEvent(true)
            return true
          }
        }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (pulling || edgeSwiping) return true
      }
    }
    return super.onInterceptTouchEvent(event)
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (edgeSwiping) {
      when (event.actionMasked) {
        MotionEvent.ACTION_MOVE -> {
          val dx = event.x - edgeStartX
          // The page follows the finger a little, like WebKit's edge preview. Cap it so the edge stays put.
          val follow = (dx * 0.4f).coerceIn(-56 * density, 56 * density)
          val distance = if (edgeDirection == -1) dx else -dx
          webView.translationX = follow
          webView.translationY = 0f
          val armed = distance >= pullThreshold
          if (armed && !edgeArmed) performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
          edgeArmed = armed
          invalidate()
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          val dx = event.x - edgeStartX
          val distance = if (edgeDirection == -1) dx else -dx
          val navigate = event.actionMasked == MotionEvent.ACTION_UP && distance >= pullThreshold
          val direction = edgeDirection
          edgeSwiping = false
          edgeArmed = false
          parent?.requestDisallowInterceptTouchEvent(false)
          if (navigate) {
            if (direction == -1) webView.goBack() else webView.goForward()
          }
          settleEdge()
        }
      }
      return true
    }
    if (!pulling) return super.onTouchEvent(event)
    when (event.actionMasked) {
      MotionEvent.ACTION_MOVE -> {
        webView.translationY = ((event.y - pullStartY) * 0.5f).coerceIn(0f, pullThreshold * 1.5f)
        val armed = webView.translationY >= pullThreshold
        if (armed && !pullArmed) performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        pullArmed = armed
        invalidate()
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val shouldReload = event.actionMasked == MotionEvent.ACTION_UP && webView.translationY >= pullThreshold
        pulling = false
        pullArmed = false
        parent?.requestDisallowInterceptTouchEvent(false)
        if (shouldReload) {
          // Hold the page just below the spinner while it reloads, as iOS does.
          refreshing = true
          refreshSawLoading = false
          refreshStartedAt = SystemClock.uptimeMillis()
          webView.animate().translationY(pullThreshold).setDuration(180).setInterpolator(DecelerateInterpolator()).start()
          spinner.start()
          reload()
        } else {
          settlePage()
        }
      }
    }
    return true
  }

  private fun settlePage() {
    webView.animate().translationY(0f).setDuration(240).setInterpolator(DecelerateInterpolator()).withEndAction { invalidate() }.start()
  }

  private fun settleEdge() {
    webView.animate().translationX(0f).setDuration(240).setInterpolator(DecelerateInterpolator()).withEndAction { invalidate() }.start()
  }

  /** Each spinner frame: ends the refresh once the reload has run (shown at least briefly), or gives up on one that never starts. */
  private fun onSpin() {
    if (!refreshing) return
    if (loading) refreshSawLoading = true
    val shown = SystemClock.uptimeMillis() - refreshStartedAt
    if ((refreshSawLoading && !loading && shown >= 450) || (!refreshSawLoading && shown >= 4_000) || shown >= 20_000) endRefresh()
    invalidate()
  }

  private fun endRefresh() {
    refreshing = false
    spinner.cancel()
    settlePage()
  }

  override fun dispatchDraw(canvas: Canvas) {
    super.dispatchDraw(canvas)
    val offset = webView.translationY
    if (offset <= 0f) return
    val radius = 10 * density
    val x = width * 0.5f
    val y = offset * 0.5f
    val progress = min(1f, offset / pullThreshold)
    if (refreshing) {
      pullPaint.alpha = 255
      canvas.drawArc(x - radius, y - radius, x + radius, y + radius, spinner.animatedValue as Float - 90f, 270f, false, pullPaint)
    } else {
      // Fades in and draws itself as the page comes down, turning a little so it feels alive.
      pullPaint.alpha = (255 * progress).toInt()
      canvas.drawArc(x - radius, y - radius, x + radius, y + radius, -90f + 120f * progress, 300f * progress, false, pullPaint)
    }
  }

  private fun isWebURL(url: Uri): Boolean = url.scheme?.lowercase() in listOf("http", "https") && !url.host.isNullOrEmpty()

  /** A scheme that belongs to another app (B5): tel:, mailto:, maps, an app's own scheme. Web and page data stay here. */
  private fun isExternalURL(url: Uri): Boolean {
    val scheme = url.scheme?.lowercase() ?: return false
    val inPage = setOf("http", "https", "about", "javascript", "data", "blob", "file", "ws", "wss", "chrome", "chrome-extension")
    return scheme !in inPage && Regex("^[a-z][a-z0-9+.-]*$").matches(scheme)
  }

  /** Asks whether to hand a link to another app; the page's navigation is cancelled either way. */
  private fun requestExternal(url: String) {
    val id = UUID.randomUUID().toString()
    pendingExternalRequests[id] = url
    emitPageRequest(id, "external", "", null, webView.url ?: pageUrl, externalUrl = url)
  }

  private fun openExternal(url: String) {
    val activity = activityFor(context) ?: return
    val parsed = if (url.startsWith("intent:", ignoreCase = true)) {
      try {
        Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
      } catch (_: Exception) {
        null
      }
    } else {
      null
    }
    val intent = parsed ?: Intent(Intent.ACTION_VIEW, Uri.parse(url))
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      activity.startActivity(intent)
    } catch (_: Exception) {
      // No app handles the link; the page stays open.
    }
  }

  /** `pending` is the address of a load that hasn't committed yet; the current page's URL and title don't apply. */
  private fun emitState(pending: String? = null) {
    if (disposed) return
    onNavigationStateChange(mapOf(
      "url" to (pending ?: webView.url ?: ""), "title" to (if (pending != null) "" else webView.title ?: ""),
      "progress" to (if (pending != null) 0.0 else webView.progress / 100.0),
      "isLoading" to loading, "canGoBack" to webView.canGoBack(), "canGoForward" to webView.canGoForward()
    ))
  }

  fun dispose() {
    disposed = true
    cancelPageRequests()
    cancelScripts("The page closed before the script finished.")
    scrollHandler.removeCallbacksAndMessages(null)
    refreshing = false
    spinner.cancel()
    hideFullscreen()
    BayFileChooser.cancelPending()
    edgeSwiping = false
    pulling = false
    webView.animate().cancel()
    webView.stopLoading()
    webView.setOnLongClickListener(null)
    webView.setOnTouchListener(null)
    webView.setOnScrollChangeListener(null)
    webView.webChromeClient = null
    webView.webViewClient = WebViewClient()
    removeView(webView)
    webView.destroy()
    releasePrivateProfile()
  }

  private class PendingMedia(
    val request: PermissionRequest,
    val resources: Array<String>,
    val permissions: Array<String>,
  )

  private class PendingLocation(
    val origin: String,
    val callback: GeolocationPermissions.Callback,
  )

  companion object {
    private const val PRIVATE_PROFILE = "bay-private"
    private var privateViews = 0
    /** Encodes and writes snapshots off the main thread, one at a time. */
    private val snapshotWriter = Executors.newSingleThreadExecutor()
    /** Base64 cap for a blob download crossing the bridge (~50 MB of file bytes). */
    private const val MAX_BLOB_BASE64 = 70_000_000
    val privateBrowsingSupported: Boolean
      get() = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
  }
}

internal object BayEngineSnapshots {
  fun directory(context: Context) = File(context.cacheDir, "bay-engine-snapshots")
  fun clear(context: Context) {
    val directory = directory(context)
    if (directory.exists() && !directory.deleteRecursively()) throw IOException("Couldn't clear the snapshot cache.")
  }
}

/**
 * Tab state files (B6): `WebView.saveState` bundles per tab id, so a relaunch or a remounted tab gets its back/forward
 * history back. Private tabs never write one.
 */
internal object BayEngineTabStates {
  fun directory(context: Context) = File(context.filesDir, "bay-engine-tab-states")

  /** Tab ids are the key; anything else is refused, so a key can never name a file outside the directory. */
  private fun isSafeKey(key: String): Boolean =
    key.isNotEmpty() && key.length <= 120 && Regex("^[A-Za-z0-9._-]+$").matches(key)

  private fun file(context: Context, key: String): File? =
    if (isSafeKey(key)) File(directory(context), "$key.state") else null

  fun save(context: Context, key: String, bundle: Bundle) {
    val target = file(context, key) ?: return
    try {
      val directory = directory(context)
      if (!directory.isDirectory && !directory.mkdirs()) return
      val parcel = Parcel.obtain()
      try {
        parcel.writeBundle(bundle)
        target.writeBytes(parcel.marshall())
      } finally {
        parcel.recycle()
      }
    } catch (error: Exception) {
      Log.w("BayEngine", "Couldn't save tab state for $key", error)
    }
  }

  fun load(context: Context, key: String): Bundle? {
    val source = file(context, key) ?: return null
    if (!source.isFile) return null
    return try {
      val bytes = source.readBytes()
      val parcel = Parcel.obtain()
      try {
        parcel.unmarshall(bytes, 0, bytes.size)
        parcel.setDataPosition(0)
        parcel.readBundle(BayEngineView::class.java.classLoader)
      } finally {
        parcel.recycle()
      }
    } catch (error: Exception) {
      null
    }
  }

  /** Deletes states whose tab ids aren't in `keep`. Recent files stay: their tab may not have been told yet. */
  fun prune(context: Context, keep: List<String>) {
    val names = keep.filter(::isSafeKey).toHashSet()
    val cutoff = System.currentTimeMillis() - 30_000
    directory(context).listFiles()?.forEach { file ->
      if (file.nameWithoutExtension !in names && file.lastModified() < cutoff) file.delete()
    }
  }

  fun clear(context: Context) {
    val directory = directory(context)
    if (directory.exists() && !directory.deleteRecursively()) throw IOException("Couldn't clear saved tab states.")
  }
}
