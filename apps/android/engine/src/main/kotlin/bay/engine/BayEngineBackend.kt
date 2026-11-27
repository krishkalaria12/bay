package bay.engine

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.bay.engine.BayEngine
import org.bay.engine.BayProfile
import java.io.File
import java.util.concurrent.Executors
import org.bay.engine.BayDownloads as EngineDownloads

/** The engine's side of BayEngineModule: Bay's own Chromium (bay-engine.aar). Main thread, like the engine itself. */
internal object BayEngineBackend {
  private val main = Handler(Looper.getMainLooper())

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
  /** Ended sessions whose downloads were still running; each goes once no private download is left. */
  private val retiredProfiles = mutableListOf<BayProfile>()
  /** Private downloads in flight, by engine id. */
  private val privateDownloads = mutableSetOf<String>()
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

  /**
   * Once no private tab or page is left, the session ends: its cookies, storage and cache were only in memory, and
   * the next private tab gets a new profile. A download the session started keeps its profile until it finishes.
   */
  private fun endUnusedPrivateSession() {
    if (privateViews > 0 || privateSessionActive) return
    val ended = privateProfile ?: return
    privateProfile = null
    if (privateDownloads.isEmpty()) ended.destroy() else retiredProfiles += ended
  }

  private fun privateDownloadEnded(id: String) {
    if (!privateDownloads.remove(id) || privateDownloads.isNotEmpty()) return
    retiredProfiles.forEach(BayProfile::destroy)
    retiredProfiles.clear()
  }

  // Website data -----------------------------------------------------------------------------------------------

  /** Clears cookies, site storage and the network cache; `done` gets null on success or the error to reject with. */
  // Spaces' profiles --------------------------------------------------------------------------------------------

  /** The space whose data is the engine's normal profile. */
  const val PERSONAL_PROFILE = "personal"

  /**
   * A space's profile: its own cookies, storage and cache, as each desktop space has. The personal space keeps the
   * normal profile, so what it held before spaces had their own stays. The engine must have started.
   */
  fun profileFor(space: String): BayProfile =
    if (space == PERSONAL_PROFILE || space.isEmpty()) BayProfile.normal() else BayProfile.forSpace(space)

  /** Clears every listed space's website data, the normal profile's included. */
  fun clearWebsiteData(context: Context, profiles: List<String>, done: (BayEngineError?) -> Unit) {
    whenStarted(context, ready = {
      val targets = (profiles + PERSONAL_PROFILE).distinct().map(::profileFor)
      var left = targets.size
      var allCleared = true
      for (profile in targets) {
        profile.clearData { complete ->
          allCleared = allCleared && complete
          left -= 1
          if (left == 0) done(if (allCleared) null else BayEngineError("E_CLEAR_DATA", "Some website data couldn't be cleared."))
        }
      }
    }, failed = { done(BayEngineError("E_ENGINE", "Bay's engine didn't start.")) })
  }

  /** A deleted space's website data goes with it. The personal space's never does. */
  fun deleteProfile(context: Context, space: String, done: () -> Unit) {
    if (space == PERSONAL_PROFILE || space.isEmpty()) return done()
    whenStarted(context, ready = { profileFor(space).clearData { done() } }, failed = { done() })
  }

  // Content blocking -------------------------------------------------------------------------------------------

  /**
   * Blocks with these filter list files (`file://` URIs; null or empty stops blocking). The engine compiles them off
   * the main thread and caches the result per `version`, so later launches load it at once.
   */
  /** `groups` names each file's group (C18), in the same order; without one for every file, the lists have none. */
  fun setContentBlocking(files: List<String>?, groups: List<String>?, version: String, context: Context, onDone: (Result<Unit>) -> Unit) {
    val pairs = files.orEmpty().mapIndexedNotNull { index, file -> Uri.parse(file).path?.let { it to groups?.getOrNull(index) } }
    val paths = pairs.map { it.first }.toTypedArray()
    val fileGroups = pairs.mapNotNull { it.second }.takeIf { it.size == pairs.size }?.toTypedArray() ?: emptyArray()
    val directory = File(context.cacheDir, "bay-engine-blocker")
    // The resources file is copied out of the app's assets once per install, off the main thread.
    resourcesCopier.execute {
      directory.mkdirs()
      val resources = BayBlockerResources.file(context, directory)?.path
      main.post {
        whenStarted(context, ready = {
          BayEngine.setContentBlocking(paths, fileGroups, version, directory.resolve("engine.bin").path, resources) { loaded ->
            onDone(if (loaded) Result.success(Unit) else Result.failure(IllegalStateException("The filter lists couldn't be read.")))
          }
        }, failed = { onDone(Result.failure(IllegalStateException("Bay's engine didn't start."))) })
      }
    }
  }

  private val resourcesCopier = Executors.newSingleThreadExecutor()

  fun setBlockingPausedHosts(hosts: List<String>) =
    runWhenStarted { BayEngine.setBlockingPausedHosts(hosts.toTypedArray()) }

  /** The groups each site turns off (C18), as `{ host: [group] }` JSON. */
  fun setSiteBlocking(json: String) = runWhenStarted { BayEngine.setSiteBlocking(json) }

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
        if (isPrivate) privateDownloads += id
        jobs[id] = BayDownloader.startFromEngine(context, url, filename, mimeType.ifEmpty { null }, total, isPrivate) { EngineDownloads.cancel(id) }
      }

      override fun onProgress(id: String, received: Long, total: Long) {
        jobs[id]?.let { BayDownloader.engineProgress(context, it, received, total) }
      }

      override fun onFinished(id: String, path: String, mimeType: String) {
        privateDownloadEnded(id)
        val job = jobs.remove(id)
        if (job == null) File(path).delete() else BayDownloader.engineFinished(context, job, path, mimeType)
      }

      override fun onFailed(id: String, message: String) {
        privateDownloadEnded(id)
        jobs.remove(id)?.let { BayDownloader.engineFailed(context, it, message) }
      }

      override fun onCancelled(id: String) {
        privateDownloadEnded(id)
        jobs.remove(id)?.let(BayDownloader::engineCancelled)
      }
    })
  }

  /** An activity result for a file picker this engine opened; false if it wasn't one. */
  fun deliverActivityResult(payload: OnActivityResultPayload): Boolean = BayFileChooser.deliver(payload)
}
