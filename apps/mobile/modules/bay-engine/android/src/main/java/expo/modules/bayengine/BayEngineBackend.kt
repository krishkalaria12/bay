package expo.modules.bayengine

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.events.OnActivityResultPayload
import org.bay.engine.BayEngine
import org.bay.engine.BayProfile
import java.io.File
import java.util.concurrent.Executors
import org.bay.engine.BayDownloads as EngineDownloads

/** The engine's side of BayEngineModule: Bay's own Chromium (bay-engine.aar). Main thread, like the engine itself. */
internal object BayEngineBackend {
  private val main = Handler(Looper.getMainLooper())

  fun engineInfo(context: Context?): Map<String, String> =
    mapOf("family" to "chromium", "name" to "Chromium", "version" to BayEngine.getVersion())

  /** Starts the engine once and runs `ready` on the main thread when it's up; `failed` if it can't start. */
  fun whenStarted(context: Context, ready: () -> Unit, failed: () -> Unit = {}) {
    val run = Runnable {
      BayEngine.start(context.applicationContext, object : BayEngine.StartCallback {
        override fun onStarted() {
          onEngineStarted(context.applicationContext)
          ready()
        }

        override fun onFailed() {
          Log.e("BayEngine", "Bay's engine didn't start.")
          failed()
        }
      })
    }
    if (Looper.myLooper() == Looper.getMainLooper()) run.run() else main.post(run)
  }

  // Private sessions -------------------------------------------------------------------------------------------

  private var privateProfile: BayProfile? = null
  private var privateViews = 0
  /** The app has private tabs, mounted or not (`setPrivateSessionActive`). */
  private var privateSessionActive = false

  /** The private session's profile, shared by its pages; a new session gets a new one. */
  fun acquirePrivateProfile(): BayProfile {
    privateViews += 1
    return privateProfile?.takeUnless { it.isDestroyed } ?: BayProfile.createPrivate().also { privateProfile = it }
  }

  fun releasePrivateProfile() {
    privateViews -= 1
    endUnusedPrivateSession()
  }

  fun setPrivateSessionActive(active: Boolean) {
    privateSessionActive = active
    endUnusedPrivateSession()
  }

  /** Once no private tab or page is left, the session ends: its cookies, storage and cache were only in memory. */
  private fun endUnusedPrivateSession() {
    if (privateViews > 0 || privateSessionActive) return
    privateProfile?.destroy()
    privateProfile = null
  }

  // Website data -----------------------------------------------------------------------------------------------

  /** Clears cookies, site storage and the network cache; `done` gets null on success or the error to reject with. */
  fun clearWebsiteData(context: Context, done: (BayEngineError?) -> Unit) {
    whenStarted(context, ready = {
      BayProfile.normal().clearData { complete ->
        done(if (complete) null else BayEngineError("E_CLEAR_DATA", "Some website data couldn't be cleared."))
      }
    }, failed = { done(BayEngineError("E_ENGINE", "Bay's engine didn't start.")) })
  }

  // Content blocking -------------------------------------------------------------------------------------------

  /**
   * Blocks with these filter list files (`file://` URIs; null or empty stops blocking). The engine compiles them off
   * the main thread and caches the result per `version`, so later launches load it at once.
   */
  fun setContentBlocking(files: List<String>?, version: String, context: Context, onDone: (Result<Unit>) -> Unit) {
    val paths = files.orEmpty().mapNotNull { Uri.parse(it).path }.toTypedArray()
    val directory = File(context.cacheDir, "bay-engine-blocker")
    // The resources file is copied out of the app's assets once per install, off the main thread.
    resourcesCopier.execute {
      directory.mkdirs()
      val resources = BayBlockerResources.file(context, directory)?.path
      main.post {
        whenStarted(context, ready = {
          BayEngine.setContentBlocking(paths, version, directory.resolve("engine.bin").path, resources) { loaded ->
            onDone(if (loaded) Result.success(Unit) else Result.failure(IllegalStateException("The filter lists couldn't be read.")))
          }
        }, failed = { onDone(Result.failure(IllegalStateException("Bay's engine didn't start."))) })
      }
    }
  }

  private val resourcesCopier = Executors.newSingleThreadExecutor()

  fun setBlockingPausedHosts(hosts: List<String>) =
    runWhenStarted { BayEngine.setBlockingPausedHosts(hosts.toTypedArray()) }

  fun setTrackingParameters(json: String): Boolean {
    runWhenStarted { BayEngine.setTrackingParameters(json) }
    return true
  }

  /** Settings that arrive before the engine starts (the app sets them at launch) apply once it has. */
  private fun runWhenStarted(apply: () -> Unit) {
    main.post { if (BayEngine.isStarted()) apply() else pendingSettings += apply }
  }

  private val pendingSettings = mutableListOf<() -> Unit>()

  private fun onEngineStarted(context: Context) {
    if (started) return
    started = true
    pendingSettings.toList().forEach { it() }
    pendingSettings.clear()
    listenToDownloads(context)
  }

  private var started = false

  // Downloads --------------------------------------------------------------------------------------------------

  /** A web image saved from a page's menu: fetched by that page's tab, with its cookies. */
  fun saveImage(context: Context, url: String, promise: Promise) {
    val view = BayEngineView.lastActive
    if (view == null || !view.download(url)) {
      BayDownloads.saveImage(context, url, { null }, promise)
      return
    }
    promise.resolve(null)
  }

  /** The engine fetches downloads; BayDownloader shows them and moves each finished file into Downloads. */
  private fun listenToDownloads(context: Context) {
    // Engine ids to BayDownloader's.
    val jobs = mutableMapOf<String, String>()
    EngineDownloads.setListener(object : EngineDownloads.Listener {
      override fun onStarted(id: String, url: String, filename: String, mimeType: String, total: Long, isPrivate: Boolean) {
        jobs[id] = BayDownloader.startFromEngine(context, url, filename, mimeType.ifEmpty { null }, total, isPrivate) { EngineDownloads.cancel(id) }
      }

      override fun onProgress(id: String, received: Long, total: Long) {
        jobs[id]?.let { BayDownloader.engineProgress(context, it, received, total) }
      }

      override fun onFinished(id: String, path: String, mimeType: String) {
        val job = jobs.remove(id)
        if (job == null) File(path).delete() else BayDownloader.engineFinished(context, job, path, mimeType)
      }

      override fun onFailed(id: String, message: String) {
        jobs.remove(id)?.let { BayDownloader.engineFailed(context, it, message) }
      }

      override fun onCancelled(id: String) {
        jobs.remove(id)?.let(BayDownloader::engineCancelled)
      }
    })
  }

  /** An activity result for a file picker this engine opened; false if it wasn't one. */
  fun deliverActivityResult(payload: OnActivityResultPayload): Boolean = BayFileChooser.deliver(payload)
}
