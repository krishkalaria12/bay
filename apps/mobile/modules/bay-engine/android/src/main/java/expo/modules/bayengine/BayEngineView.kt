package expo.modules.bayengine

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File
import java.io.IOException
import java.util.UUID
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

@SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
class BayEngineView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  val onNavigationStateChange by EventDispatcher()
  val onNavigationError by EventDispatcher()
  val onScroll by EventDispatcher()
  val onLinkPress by EventDispatcher()
  private var loading = false
  private var recoveryURL: String? = null
  private var disposed = false
  private var startedLoading = false
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
  private val pullThreshold = 56 * density
  private val pullPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.GRAY
    strokeWidth = 3 * density
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
  }
  var pullToRefreshEnabled = true
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
    overScrollMode = OVER_SCROLL_NEVER
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
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = !isWebURL(request.url)

      override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        navigationGeneration += 1
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
        navigationGeneration += 1
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
    check(!disposed) { "This page view has been disposed." }
    require(isWebURL(Uri.parse(address))) { "Only HTTP and HTTPS addresses can be opened." }
    recoveryURL = null
    startedLoading = true
    webView.loadUrl(address)
  }

  /** Loads once, when the view is created, unless a navigation already started. Invalid addresses are ignored. */
  fun loadInitial(address: String?) {
    if (startedLoading || disposed || address.isNullOrEmpty() || !isWebURL(Uri.parse(address))) return
    load(address)
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

  fun snapshot(): String? {
    if (disposed || webView.width <= 0 || webView.height <= 0 || webView.url == null) return null
    val ratio = min(1.0, 640.0 / webView.width)
    val bitmap = Bitmap.createBitmap(max(1, (webView.width * ratio).toInt()), max(1, (webView.height * ratio).toInt()), Bitmap.Config.ARGB_8888)
    try {
      val canvas = Canvas(bitmap)
      canvas.scale(ratio.toFloat(), ratio.toFloat())
      webView.draw(canvas)
      val directory = BayEngineSnapshots.directory(context)
      check(directory.isDirectory || directory.mkdirs()) { "Couldn't create the snapshot cache." }
      val file = File(directory, "${UUID.randomUUID()}.jpg")
      try {
        file.outputStream().use { if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 75, it)) throw IOException("Couldn't encode the page snapshot.") }
      } catch (error: Exception) {
        file.delete()
        throw error
      }
      snapshotFile?.delete()
      snapshotFile = file
      return Uri.fromFile(file).toString()
    } finally {
      bitmap.recycle()
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
    if (!pullToRefreshEnabled || disposed || webView.url == null || loading) return super.onInterceptTouchEvent(event)
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        pullStartX = event.x
        pullStartY = event.y
        pulling = false
      }
      MotionEvent.ACTION_MOVE -> {
        val distance = event.y - pullStartY
        if (!webView.canScrollVertically(-1) && distance > touchSlop * 2 && distance > abs(event.x - pullStartX) * 1.5) {
          pulling = true
          parent?.requestDisallowInterceptTouchEvent(true)
          return true
        }
      }
    }
    return super.onInterceptTouchEvent(event)
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (!pulling) return super.onTouchEvent(event)
    when (event.actionMasked) {
      MotionEvent.ACTION_MOVE -> {
        webView.translationY = ((event.y - pullStartY) * 0.5f).coerceIn(0f, pullThreshold * 1.5f)
        invalidate()
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val shouldReload = event.actionMasked == MotionEvent.ACTION_UP && webView.translationY >= pullThreshold
        pulling = false
        parent?.requestDisallowInterceptTouchEvent(false)
        webView.animate().translationY(0f).setDuration(160).withEndAction { invalidate() }.start()
        if (shouldReload) reload()
      }
    }
    return true
  }

  override fun dispatchDraw(canvas: Canvas) {
    super.dispatchDraw(canvas)
    if (webView.translationY > 0f) {
      val radius = 8 * density
      val x = width * 0.5f
      val y = webView.translationY * 0.5f
      val sweep = 300 * min(1f, webView.translationY / pullThreshold)
      canvas.drawArc(x - radius, y - radius, x + radius, y + radius, -90f, sweep, false, pullPaint)
    }
  }

  private fun isWebURL(url: Uri): Boolean = url.scheme?.lowercase() in listOf("http", "https") && !url.host.isNullOrEmpty()

  private fun emitState() {
    if (disposed) return
    onNavigationStateChange(mapOf(
      "url" to (webView.url ?: ""), "title" to (webView.title ?: ""), "progress" to webView.progress / 100.0,
      "isLoading" to loading, "canGoBack" to webView.canGoBack(), "canGoForward" to webView.canGoForward()
    ))
  }

  fun dispose() {
    disposed = true
    scrollHandler.removeCallbacksAndMessages(null)
    webView.animate().cancel()
    webView.stopLoading()
    webView.setOnLongClickListener(null)
    webView.setOnTouchListener(null)
    webView.setOnScrollChangeListener(null)
    webView.webChromeClient = null
    webView.webViewClient = WebViewClient()
    removeView(webView)
    webView.destroy()
  }
}

internal object BayEngineSnapshots {
  fun directory(context: Context) = File(context.cacheDir, "bay-engine-snapshots")
  fun clear(context: Context) {
    val directory = directory(context)
    if (directory.exists() && !directory.deleteRecursively()) throw IOException("Couldn't clear the snapshot cache.")
  }
}
