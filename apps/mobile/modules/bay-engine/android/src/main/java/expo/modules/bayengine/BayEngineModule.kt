package expo.modules.bayengine

import android.content.Context
import android.content.Intent
import android.net.Uri
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class BayEngineModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BayEngine")

    Events("onDownload", "onMediaControl")

    OnActivityResult { _, payload ->
      if (!BayEngineBackend.deliverActivityResult(payload)) BayVoice.deliver(payload)
    }

    OnCreate {
      BayDownloads.emit = { body -> sendEvent("onDownload", body) }
      BayMedia.emit = { action -> sendEvent("onMediaControl", mapOf("action" to action)) }
    }

    // A link shared into Bay (B14) comes as a SEND intent on a running app. Bay's share links travel as a page in
    // `bay://share?url=…`, which JS answers through the same incoming-link rule (B9).
    OnNewIntent { intent -> intent.sharedUrl()?.let { sendEvent("onShare", mapOf("url" to shareLink(it))) } }

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

    AsyncFunction("saveImage") { url: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) promise.reject("E_CONTEXT_LOST", "The browser context is unavailable.", null)
      else BayEngineBackend.saveImage(context, url, promise)
    }.runOnQueue(Queues.MAIN)

    // A share intent that launched Bay cold (B14) never fires OnNewIntent; JavaScript asks for it once on mount.
    AsyncFunction("takeShare") { promise: Promise ->
      val url = appContext.currentActivity?.intent?.sharedUrl()
      promise.resolve(url?.let { shareLink(it) })
    }.runOnQueue(Queues.MAIN)

    // Voice search (B16): one system recognition, resolved with the transcript or null.
    AsyncFunction("startListening") { promise: Promise ->
      BayVoice.listen(appContext.currentActivity, promise)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setPrivateSessionActive") { active: Boolean ->
      BayEngineBackend.setPrivateSessionActive(active)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("clearData") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("E_CONTEXT_LOST", "The browser context is unavailable.", null)
        return@AsyncFunction
      }
      try {
        BayEngineBackend.clearWebsiteData(context) { error ->
          if (error != null) {
            promise.reject(error.code, error.message, error.cause)
            return@clearWebsiteData
          }
          try {
            BayEngineSnapshots.clear(context)
            BayEngineTabStates.clear(context)
            promise.resolve(null)
          } catch (failure: Exception) {
            promise.reject("E_CLEAR_DATA", "Couldn't clear website data.", failure)
          }
        }
      } catch (error: Exception) {
        promise.reject("E_CLEAR_DATA", "Couldn't clear website data.", error)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("pruneSnapshots") { keep: List<String> -> appContext.reactContext?.let { pruneSnapshots(it, keep) } }

    AsyncFunction("pruneTabStates") { keep: List<String> -> appContext.reactContext?.let { BayEngineTabStates.prune(it, keep) } }

    Constant("privateBrowsingSupported") { BayEngineBackend.privateBrowsingSupported }
    // Bay's own Chromium, or the system WebView in a build without it (BayEngineBackend).
    Constant("engineInfo") { BayEngineBackend.engineInfo(appContext.reactContext) }

    AsyncFunction("setContentBlocking") { files: List<String>?, version: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("E_CONTEXT_LOST", "The browser context is unavailable.", null)
        return@AsyncFunction
      }
      BayEngineBackend.setContentBlocking(files, version, context) { result ->
        result.fold({ promise.resolve(null) }, { promise.reject("E_CONTENT_BLOCKING", "Couldn't prepare the content blocker.", it) })
      }
    }.runOnQueue(Queues.MAIN)

    Function("setBlockingPausedHosts") { hosts: List<String> -> BayEngineBackend.setBlockingPausedHosts(hosts) }

    Function("setTrackingParameters") { json: String -> BayEngineBackend.setTrackingParameters(json) }

    View(BayEngineView::class) {
      Events("onNavigationStateChange", "onNavigationError", "onScroll", "onLinkPress", "onPageMessage", "onFullscreenChange", "onPageRequest", "onNewWindow")
      Prop("pullToRefreshEnabled") { view: BayEngineView, enabled: Boolean -> view.pullToRefreshEnabled = enabled }
      Prop("private") { view: BayEngineView, isPrivate: Boolean -> view.isPrivate = isPrivate }
      Prop("active") { view: BayEngineView, active: Boolean -> view.isActive = active }
      Prop("suspended") { view: BayEngineView, suspended: Boolean -> view.isSuspended = suspended }
      Prop("desktopMode") { view: BayEngineView, desktop: Boolean -> view.desktopMode = desktop }
      Prop("stateKey") { view: BayEngineView, key: String? -> view.stateKey = key }
      Prop("initialUrl") { view: BayEngineView, url: String? -> view.loadInitial(url) }
      AsyncFunction("load") { view: BayEngineView, url: String -> view.load(url) }
      AsyncFunction("goBack") { view: BayEngineView -> view.goBack() }.runOnQueue(Queues.MAIN)
      AsyncFunction("goForward") { view: BayEngineView -> view.goForward() }.runOnQueue(Queues.MAIN)
      AsyncFunction("reload") { view: BayEngineView -> view.reload() }
      AsyncFunction("stop") { view: BayEngineView -> view.stop() }
      AsyncFunction("snapshot") { view: BayEngineView, promise: Promise -> view.snapshot(promise) }.runOnQueue(Queues.MAIN)
      AsyncFunction("saveState") { view: BayEngineView -> view.saveState() }.runOnQueue(Queues.MAIN)
      AsyncFunction("evaluate") { view: BayEngineView, script: String, promise: Promise -> view.evaluate(script, promise) }.runOnQueue(Queues.MAIN)
      AsyncFunction("answerPageRequest") { view: BayEngineView, id: String, accepted: Boolean, value: String?, username: String?, password: String? -> view.answerPageRequest(id, accepted, value, username, password) }.runOnQueue(Queues.MAIN)
      OnViewDestroys { view: BayEngineView -> view.dispose() }
    }
  }
}

/**
 * Share intents (B14): a SEND action whose text holds a web address; apps share pages as a title around their link.
 * Bay's own share links travel as `bay://share?url=…`, answered by JavaScript's incoming-link rule (B9).
 */
private val sharedPattern = Regex("https?://[^\\s\"<>()\\[\\]]+")

private fun Intent.sharedUrl(): String? {
  if (action != Intent.ACTION_SEND) return null

  return sharedPattern.find(getStringExtra(Intent.EXTRA_TEXT) ?: return null)?.value?.trimEnd(')', '.', ',', ';', '"', '\'')
}

private fun shareLink(url: String): String = "bay://share?url=" + Uri.encode(url, "")

/** Deletes snapshots that aren't in `keep` (file URIs). Recent files stay: their tab may not have been told yet. */
private fun pruneSnapshots(context: Context, keep: List<String>) {
  val names = keep.mapNotNullTo(HashSet()) { Uri.parse(it).lastPathSegment }
  val cutoff = System.currentTimeMillis() - 30_000
  BayEngineSnapshots.directory(context).listFiles()?.forEach { file ->
    if (file.name !in names && file.lastModified() < cutoff) file.delete()
  }
}
