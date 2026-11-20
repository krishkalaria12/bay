package bay.engine

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.PixelFormat
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.webkit.MimeTypeMap
import android.widget.FrameLayout
import org.bay.engine.BayEngine
import org.bay.engine.BayTab
import org.bay.engine.BayTabClient
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.suspendCoroutine

/**
 * A page in Bay's own Chromium (org.bay.engine.BayTab), with the same props, events and functions as iOS's WebKit
 * view. Content blocking, cosmetic filtering and scriptlets run inside the engine for every request and frame; page
 * scripts run in an isolated world.
 */
@SuppressLint("ViewConstructor")
class BayEngineView(context: Context) : FrameLayout(context) {
  /** Everything the view reports, on the main thread. */
  var onEvent: ((EngineEvent) -> Unit)? = null

  private fun emit(event: EngineEvent) {
    onEvent?.invoke(event)
  }

  /** The page, once the engine has started and the first props have applied; null before and after. */
  private var tab: BayTab? = null
  private var tabIsPrivate = false
  private var disposed = false
  private var startedLoading = false
  /** A saved page came back, so `initialUrl` must not load over it. */
  private var restoredState = false
  /** What to open once the tab exists: an address `load` was given, or else the initial one. */
  private var pendingLoad: String? = null
  private var pendingInitial: String? = null
  private var wasLoading = false
  /** Automatic reloads after the system kills a page's renderer (one, then the error screen). */
  private var rendererReloads = 0
  private var nextRequest = 0
  private val pendingDialogs = mutableMapOf<String, Int>()
  private val pendingAuth = mutableMapOf<String, Int>()
  private val pendingPermissions = mutableMapOf<String, PendingPermission>()
  private val pendingExternal = mutableMapOf<String, String>()
  private val density = resources.displayMetrics.density
  private var scrollOffset = 0.0
  private val snapshots = BaySnapshotWriter(context)
  private val fullscreen = BayFullscreen(context)
  private val gestures = BayPageGestures(this, object : BayPageGestures.Page {
    override val view: View get() = tab?.view ?: this@BayEngineView
    override val hasPage: Boolean get() = !disposed && !tab?.url.isNullOrEmpty()
    override val isLoading: Boolean get() = tab?.isLoading == true
    override val pullToRefreshEnabled: Boolean get() = this@BayEngineView.pullToRefreshEnabled
    override val isAtTop: Boolean get() = scrollOffset <= 0.0
    override fun canGoBack() = tab?.canGoBack() == true
    override fun canGoForward() = tab?.canGoForward() == true
    override fun goBack() = this@BayEngineView.goBack()
    override fun goForward() = this@BayEngineView.goForward()
    override fun reload() = this@BayEngineView.reload()
    override val swipeMode: String get() = this@BayEngineView.swipeMode
    override fun pastHistory(back: Boolean) {
      emit(EngineEvent.SwipedPast(back))
    }
  })

  var pullToRefreshEnabled = true

  /** Swipe to navigate (C5): "anywhere" on the page, "edges", or "off". */
  var swipeMode = "edges"

  /**
   * Open app links in (C12, C19): "app" hands a link tapped in the page to another site to the app that claims it
   * (Android's verified app links, never another browser); "browser" keeps every web link in Bay.
   */
  var appLinks = "app"

  /** Private pages use the private session's profile (BayEngineBackend), which ends with the session. Set at creation. */
  var isPrivate = false
    set(value) {
      if (field == value) return
      field = value
      // A tab that hasn't loaded anything yet moves to the right profile; one that has keeps its own.
      if (tab != null && !startedLoading) {
        destroyTab()
        createTab()
      }
    }

  /**
   * The space whose profile (cookies, storage, cache) the page uses, as each desktop space has its own. A page that
   * has loaded moves to the new space's profile and opens its address again there.
   */
  var profile = BayEngineBackend.PERSONAL_PROFILE
    set(value) {
      if (field == value) return
      field = value
      val current = tab ?: return
      if (tabIsPrivate) return
      val address = current.url?.takeIf { startedLoading && it.isNotEmpty() }
      destroyTab()
      createTab()
      if (address != null) load(address)
    }

  /** Hidden tabs stay mounted; keep them out of TalkBack. */
  var isActive = true
    set(value) {
      val was = field
      field = value
      tab?.view?.importantForAccessibility = accessibility()
      if (value) lastActive = this
      // The tab on screen draws: it takes the window's one compositor from the tab that had it.
      if (value && !was) takeSurface()
      // Leaving the screen is a good moment to save (B6): the tab may be the next one unmounted for memory.
      if (!value) saveState()
    }

  /**
   * Puts the page on the window's compositor. A page that has finished loading sends no new frame of its own, so the
   * new surface would stay blank until it next changed: hiding and showing it again makes its renderer draw one, as a
   * tab switch does in Chrome.
   */
  private fun takeSurface() {
    val current = tab ?: return
    current.showPage()
    if (isSuspended) return
    current.setVisible(false)
    current.setVisible(true)
  }

  /** Hidden tabs that aren't playing media stop drawing, and their timers slow. */
  var isSuspended = false
    set(value) {
      if (field == value) return
      field = value
      tab?.setVisible(!value)
    }

  /** Desktop site (B12): the site is asked again as a desktop browser; changing it reloads the page. */
  var desktopMode = false
    set(value) {
      if (field == value) return
      field = value
      tab?.setDesktopMode(value)
    }

  /**
   * How much of the page's bottom the app's bar covers, in pixels; 0 for none (a fullscreen site). The page keeps its
   * size: Chromium treats the bar as its bottom toolbar, lifting what the page pins to its bottom above it while it
   * shows, sliding it away with the page as it scrolls down and back as it scrolls up (EngineEvent.BarMoved).
   */
  var barHeight = 0
    set(value) {
      if (field == value) return
      field = value
      tab?.setBottomControlsHeight(value)
    }

  /** Brings the bar back with the page's room for it, as a new page does. */
  fun showBar() {
    tab?.showBrowserControls(true)
  }

  /** Blink's own forced dark mode for this tab: pages without a dark look of their own are drawn dark. */
  var forceDark = false
    set(value) {
      if (field == value) return
      field = value
      tab?.setForceDark(value)
    }

  /** The tab's saved state (B6): its tab id, or null for private tabs. */
  var stateKey: String? = null
    set(value) {
      if (field == value) return
      field = value
      if (tab != null && !startedLoading) restoreState()
    }

  init {
    live.add(this)
    // A turn later, so the first props (`private` in particular) have applied.
    post {
      if (disposed) return@post
      BayEngineBackend.whenStarted(context, ready = { if (!disposed && tab == null) createTab() }, failed = {
        if (!disposed) emit(EngineEvent.Failure(pendingLoad ?: pendingInitial ?: "", "engine-failed", "Bay's engine didn't start."))
      })
    }
  }

  // MARK: The tab

  private fun createTab() {
    val activity = activityFor(context) ?: Engine.host?.currentActivity
    if (activity == null) {
      Log.e("BayEngine", "A page view without an activity can't show a page.")
      return
    }
    // The page draws on a SurfaceView under the window, seen through the hole it punches. The engine's tab view keeps
    // the SurfaceView from asking for a transparent region (a stale one left a strip over Bay's sheets), and that ask
    // is also what makes an opaque window translucent: without it the window covers the page in black.
    activity.window.setFormat(PixelFormat.TRANSLUCENT)
    tabIsPrivate = isPrivate
    val session = if (tabIsPrivate) BayEngineBackend.acquirePrivateProfile() else BayEngineBackend.profileFor(profile)
    val created = BayTab(activity, session, client)
    tab = created
    created.view.importantForAccessibility = accessibility()
    created.setDesktopMode(desktopMode)
    created.setForceDark(forceDark)
    created.setVisible(!isSuspended)
    created.setBottomControlsHeight(barHeight)
    addView(created.view, 0, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    if (isActive) {
      lastActive = this
      created.showPage()
    }
    restoreState()
    val address = pendingLoad ?: pendingInitial?.takeUnless { restoredState }
    pendingLoad = null
    pendingInitial = null
    if (address != null) load(address)
  }

  private fun destroyTab() {
    val closing = tab ?: return
    tab = null
    gestures.cancel()
    removeView(closing.view)
    closing.destroy()
    if (tabIsPrivate) BayEngineBackend.releasePrivateProfile()
  }

  private fun accessibility() = if (isActive) IMPORTANT_FOR_ACCESSIBILITY_AUTO else IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS

  // MARK: Navigation

  fun load(address: String) {
    check(!disposed) { "This page view has been disposed." }
    require(isWebUrl(Uri.parse(address))) { "Only HTTP and HTTPS addresses can be opened." }
    startedLoading = true
    val current = tab
    if (current == null) {
      // Opens once the engine has started (createTab).
      pendingLoad = address
      emitState(pending = address)
      return
    }
    cancelPageRequests()
    val target = replacementFor(address)
    current.loadUrl(target)
    // The engine reports a start once the request goes out; report the load now, as WebKit does.
    emitState(pending = target)
  }

  /** The address without tracking parameters. The engine moves it to HTTPS when it can (BayHttpsUpgradeThrottle). */
  private fun replacementFor(address: String): String = BayEngine.cleanUrl(address) ?: address

  /** Loads once, when the view is created, unless a navigation already started. Invalid addresses are ignored. */
  fun loadInitial(address: String?) {
    if (startedLoading || disposed || address.isNullOrEmpty() || !isWebUrl(Uri.parse(address))) return
    if (tab == null) {
      pendingInitial = address
      return
    }
    post {
      if (startedLoading || disposed) return@post
      // A restored page supplies its own address and history; only fall back if the engine drops it.
      if (restoredState) {
        postDelayed({ if (!startedLoading && !disposed && tab?.url.isNullOrEmpty()) load(address) }, 1_000)
        return@post
      }
      load(address)
    }
  }

  fun goBack() {
    tab?.goBack()
  }

  fun goForward() {
    tab?.goForward()
  }

  fun reload() {
    tab?.reload()
  }

  fun stop() {
    tab?.stop()
    emitState()
  }

  /** Downloads `url` as this page would load it, with its cookies; false without a page to do it. */
  fun download(url: String): Boolean {
    val current = tab ?: return false
    current.download(url)
    return true
  }

  // MARK: State (B6) and snapshots

  /** Restores the tab's back/forward history from its state file, before its first load. */
  private fun restoreState() {
    if (isPrivate) return
    val key = stateKey ?: return
    val current = tab ?: return
    val bytes = BayEngineTabStates.load(context, key) ?: return
    if (!current.restoreState(String(bytes, Charsets.UTF_8))) return
    startedLoading = true
    restoredState = true
    emitState()
  }

  /** Saves the page state for `stateKey` now; private tabs leave nothing behind. */
  fun saveState() {
    if (disposed || isPrivate) return
    val key = stateKey ?: return
    val state = tab?.saveState() ?: return
    BayEngineTabStates.save(context, key, state.toByteArray(Charsets.UTF_8))
  }

  /** The page as it is on screen, as a JPEG file URI; null for a suspended page or one with nothing to show. */
  /** A JPEG of the page in the app cache, as a file URI, or null before the page has drawn. */
  suspend fun snapshot(): String? = suspendCoroutine { snapshot(it.asPromise()) }

  /** Runs a page script (the body of an async function) in Bay's isolated world; answers with its result as JSON. */
  suspend fun evaluate(script: String): String = suspendCoroutine { evaluate(script, it.asPromise()) }

  fun snapshot(promise: Promise) {
    val current = tab
    if (disposed || isSuspended || current == null || current.url.isEmpty()) {
      promise.resolve(null)
      return
    }
    current.captureSnapshot(BaySnapshotWriter.MAX_WIDTH) { bitmap ->
      if (bitmap == null) promise.resolve(null) else snapshots.write(bitmap, promise)
    }
  }

  // MARK: Page scripts

  /** Runs a page script in Bay's isolated world and resolves with its result as JSON text (see `Tab.evaluate`). */
  fun evaluate(script: String, promise: Promise) {
    val current = tab
    if (disposed || current == null) {
      promise.reject("E_PAGE_CLOSED", "The page is closed.", null)
      return
    }
    current.evaluate(script, object : BayTab.EvaluationCallback {
      override fun onResult(json: String) = promise.resolve(json)

      override fun onError(message: String) = promise.reject("E_PAGE_SCRIPT", message, null)
    })
  }

  // MARK: Page requests (I3)

  private fun newRequestId(kind: String) = "$kind-${++nextRequest}"

  private fun emitPageRequest(id: String, kind: String, message: String = "", defaultValue: String? = null, url: String? = null, realm: String? = null, externalUrl: String? = null, permission: String? = null) {
    emit(EngineEvent.Request(PageRequest(
      id = id, kind = kind, message = message.take(2000), url = url ?: tab?.url ?: "", defaultValue = defaultValue?.take(2000),
      realm = realm?.takeIf { it.isNotEmpty() }?.take(200), externalUrl = externalUrl?.take(2048), permission = permission,
    )))
  }

  fun answerPageRequest(id: String, accepted: Boolean, value: String?, username: String?, password: String?) {
    val current = tab
    pendingExternal.remove(id)?.let { url ->
      if (accepted) openExternalUrl(context, url)
      return
    }
    pendingDialogs.remove(id)?.let { request ->
      current?.answerDialog(request, accepted, value ?: "")
      return
    }
    pendingAuth.remove(id)?.let { request ->
      current?.answerHttpAuth(request, accepted, username ?: "", password ?: "")
      return
    }
    val permission = pendingPermissions.remove(id) ?: return
    if (!accepted) {
      current?.answerPermission(permission.request, false)
      return
    }
    // The page gets the device only once Android has granted it to Bay too.
    requestSystemPermissions(Engine.host, permission.system, requireAll = permission.requireAll) { granted ->
      if (tab === current) current?.answerPermission(permission.request, granted)
    }
  }

  /** Declines every question the page is waiting on (the person is leaving the page). */
  private fun cancelPageRequests() {
    val current = tab
    pendingDialogs.values.forEach { current?.answerDialog(it, false, "") }
    pendingAuth.values.forEach { current?.answerHttpAuth(it, false, "", "") }
    pendingPermissions.values.forEach { current?.answerPermission(it.request, false) }
    forgetPageRequests()
  }

  private fun forgetPageRequests() {
    pendingDialogs.clear()
    pendingAuth.clear()
    pendingPermissions.clear()
    pendingExternal.clear()
  }

  /** File upload (A1): the system's picker; the chosen files go to the page by their content URIs. */
  private fun showFileChooser(request: Int, acceptTypes: String, multiple: Boolean) {
    BayFileChooser.cancelPending()
    val current = tab ?: return
    val activity = activityFor(context) ?: Engine.host?.currentActivity
    if (activity == null) {
      current.answerFileChooser(request, "[]")
      return
    }
    BayFileChooser.setPending { uris ->
      if (tab === current) current.answerFileChooser(request, filesJson(uris.orEmpty()))
    }
    val types = acceptTypes.split(',').map { it.trim().lowercase() }.mapNotNull { accept ->
      when {
        accept.isEmpty() -> null
        accept.contains('/') -> accept
        else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(accept.removePrefix("."))
      }
    }.distinct()
    val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      if (types.size == 1) {
        type = types[0]
      } else {
        type = "*/*"
        if (types.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
      }
      putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
    }
    try {
      activity.startActivityForResult(intent, BayFileChooser.REQUEST_CODE)
    } catch (_: Exception) {
      BayFileChooser.cancelPending()
    }
  }

  /** `[{"uri": "content://…", "name": "photo.jpg"}, …]`, as BayTab.answerFileChooser takes them. */
  private fun filesJson(uris: Array<out Uri>): String {
    val files = JSONArray()
    for (uri in uris) {
      val name = runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
          if (cursor.moveToFirst()) cursor.getString(0) else null
        }
      }.getOrNull() ?: uri.lastPathSegment ?: "file"
      files.put(JSONObject().put("uri", uri.toString()).put("name", name))
    }
    return files.toString()
  }

  // MARK: Fullscreen (A2)

  private fun showFullscreen() {
    val current = tab ?: return
    val page = current.view
    removeView(page)
    if (fullscreen.enter(page) { current.exitFullscreen() }) {
      emit(EngineEvent.Fullscreen(true))
    } else {
      addView(page, 0)
      current.exitFullscreen()
    }
  }

  private fun hideFullscreen() {
    val page = fullscreen.exit() ?: return
    page.translationX = 0f
    page.translationY = 0f
    if (!disposed && tab?.view === page) addView(page, 0)
    if (!disposed) emit(EngineEvent.Fullscreen(false))
  }

  // MARK: Events

  private val client = object : BayTabClient {
    override fun onNavigationStateChanged() {
      val loading = tab?.isLoading == true
      if (wasLoading && !loading) {
        rendererReloads = 0
        // A finished load is worth keeping, so a relaunch or a remounted tab gets its history back (B6).
        saveState()
      }
      wasLoading = loading
      emitState()
    }

    override fun onMainFrameError(url: String, code: String, description: String) {
      emitState()
      emit(EngineEvent.Failure(url, code, description.ifEmpty { "The page couldn't be loaded." }))
    }

    override fun onDownloadStarted(url: String, blank: Boolean) {
      // The navigation became a download (BayDownloader shows it). A tab that had no page yet goes back to the
      // start page instead of keeping the file's address and downloading it again when it's restored.
      if (blank) {
        emit(EngineEvent.Navigation(NavigationState.EMPTY.copy(blank = true)))
      } else {
        emitState()
      }
    }

    override fun onPageMessage(json: String) {
      if (!disposed) emit(EngineEvent.PageMessage(json))
    }

    override fun onNewWindow(url: String, userGesture: Boolean) {
      emit(EngineEvent.NewWindow(url, tabIsPrivate))
    }

    override fun onJavaScriptDialog(requestId: Int, type: Int, message: String, defaultText: String, url: String) {
      val kind = when (type) {
        BayTab.DIALOG_CONFIRM -> "confirm"
        BayTab.DIALOG_PROMPT -> "prompt"
        else -> "alert"
      }
      val id = newRequestId("dialog")
      pendingDialogs[id] = requestId
      emitPageRequest(id, kind, message, if (type == BayTab.DIALOG_PROMPT) defaultText else null, url)
    }

    override fun onHttpAuth(requestId: Int, host: String, realm: String) {
      val id = newRequestId("auth")
      pendingAuth[id] = requestId
      emitPageRequest(id, "auth", realm = realm)
    }

    override fun onPermissionRequest(requestId: Int, kind: Int, origin: String) {
      val permission = when (kind) {
        BayTab.PERMISSION_LOCATION -> PendingPermission(requestId, "location", arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), requireAll = false)
        BayTab.PERMISSION_CAMERA -> PendingPermission(requestId, "camera", arrayOf(Manifest.permission.CAMERA))
        BayTab.PERMISSION_MICROPHONE -> PendingPermission(requestId, "microphone", arrayOf(Manifest.permission.RECORD_AUDIO))
        else -> PendingPermission(requestId, "camera-microphone", arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO))
      }
      val id = newRequestId("permission")
      pendingPermissions[id] = permission
      emitPageRequest(id, "permission", permission = permission.name)
    }

    override fun onFileChooser(requestId: Int, acceptTypes: String, multiple: Boolean, capture: Boolean) =
      showFileChooser(requestId, acceptTypes, multiple)

    override fun onContextMenu(linkUrl: String, linkText: String, imageUrl: String, x: Float, y: Float) {
      // An image's own address (B13) offers image actions; an image inside a link stays a link menu.
      val url = linkUrl.ifEmpty { imageUrl }
      if (url.isEmpty() || !isWebUrl(Uri.parse(url))) return
      val title = linkText.trim().ifEmpty { url }
      emit(EngineEvent.LinkPress(url, title.take(240), x.toDouble(), y.toDouble(), image = linkUrl.isEmpty()))
    }

    override fun onExternalUrl(url: String, userGesture: Boolean) {
      // A link to another app asks first (B5); the page stays where it is either way.
      val id = newRequestId("external")
      pendingExternal[id] = url
      emitPageRequest(id, "external", externalUrl = url)
    }

    override fun onAppLink(url: String): Boolean {
      // A non-browser app only (Android 11 and later can say so); on Android 10 every web link stays in Bay.
      if (appLinks != "app" || disposed || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
      val activity = activityFor(context) ?: Engine.host?.currentActivity ?: return false
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        .addCategory(Intent.CATEGORY_BROWSABLE)
        .addFlags(Intent.FLAG_ACTIVITY_REQUIRE_NON_BROWSER)
      return try {
        activity.startActivity(intent)
        true
      } catch (_: ActivityNotFoundException) {
        false
      }
    }

    override fun onBlockedCount(count: Int) {
      if (!disposed) emit(EngineEvent.BlockedCount(count))
    }

    override fun onRequestsCancelled() = forgetPageRequests()

    override fun onFullscreenChanged(fullscreen: Boolean) {
      if (fullscreen) showFullscreen() else hideFullscreen()
    }

    override fun onRendererGone(crashed: Boolean) {
      val url = tab?.url.orEmpty()
      // The system killed the page to reclaim memory; reopen it once before showing the error screen (B6).
      if (!crashed && rendererReloads < 1 && url.isNotEmpty()) {
        rendererReloads += 1
        tab?.reload()
        return
      }
      emitState()
      emit(EngineEvent.Failure(url, "renderer-terminated", "The page stopped responding. Reload to try again."))
    }

    override fun onScroll(offsetY: Float, deltaY: Float) {
      scrollOffset = offsetY.toDouble()
    }

    override fun onBottomControlsChanged(offset: Int) {
      if (disposed || barHeight <= 0) return
      emit(EngineEvent.BarMoved((offset.toFloat() / barHeight).coerceIn(0f, 1f)))
    }
  }

  /** `pending` is the address of a load that hasn't committed yet; the current page's URL and title don't apply. */
  private fun emitState(pending: String? = null) {
    if (disposed) return
    val current = tab
    emit(EngineEvent.Navigation(NavigationState(
      url = pending ?: current?.url ?: "", title = if (pending != null) "" else current?.title ?: "",
      progress = if (pending != null) 0.0 else current?.progress?.toDouble() ?: 0.0,
      isLoading = pending != null || current?.isLoading == true,
      canGoBack = current?.canGoBack() == true, canGoForward = current?.canGoForward() == true,
    )))
  }

  // MARK: Touch

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean =
    gestures.onInterceptTouchEvent(event) ?: super.onInterceptTouchEvent(event)

  override fun onTouchEvent(event: MotionEvent): Boolean = gestures.onTouchEvent(event) ?: super.onTouchEvent(event)

  override fun dispatchDraw(canvas: Canvas) {
    super.dispatchDraw(canvas)
    gestures.draw(canvas)
  }

  fun dispose() {
    if (disposed) return
    cancelPageRequests()
    disposed = true
    hideFullscreen()
    BayFileChooser.cancelPending()
    destroyTab()
    live.remove(this)
    // A page shown over the tab (a link's preview) gives the window's compositor back to the tab on screen.
    val onScreen = live.lastOrNull { it.isActive && it.tab != null }
    if (lastActive === this) lastActive = onScreen
    onScreen?.takeSurface()
  }

  private class PendingPermission(val request: Int, val name: String, val system: Array<String>, val requireAll: Boolean = true)

  companion object {
    /** The page on screen, which saves images from its menu with its own cookies (BayEngineBackend.saveImage). */
    internal var lastActive: BayEngineView? = null

    /** The page views not yet disposed, oldest first. */
    private val live = LinkedHashSet<BayEngineView>()
  }
}
