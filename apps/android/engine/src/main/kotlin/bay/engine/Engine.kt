package bay.engine

import android.content.Context
import android.content.Intent
import android.net.Uri
import bay.core.DownloadEvent
import java.lang.ref.WeakReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

/**
 * What every page view shares: content blocking, private browsing, spaces' website data, downloads, media controls,
 * voice search and saved images. The Expo module's functions (`BayEngineModule`), called from Kotlin. Call from the
 * main thread.
 */
object Engine {
  private var hostRef: WeakReference<EngineHost>? = null

  /** The activity the engine starts pickers, intents and permission requests from. The activity sets it in onCreate. */
  var host: EngineHost?
    get() = hostRef?.get()
    set(value) {
      hostRef = value?.let(::WeakReference)
    }

  /** `downloads` hears each download's progress (for the store); `media` what the system's media controls asked for. */
  fun start(downloads: (DownloadEvent) -> Unit, media: (MediaControl) -> Unit) {
    BayDownloads.emit = downloads
    BayMedia.emit = { action -> MediaControl.entries.firstOrNull { it.action == action }?.let(media) }
  }

  /** Hands an activity result to the file chooser or voice search, whichever asked. */
  fun deliverActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    val payload = OnActivityResultPayload(requestCode, resultCode, data)
    if (!BayEngineBackend.deliverActivityResult(payload)) BayVoice.deliver(payload)
  }

  // Content blocking

  /**
   * Blocks with filter list files (`file://` URIs, EasyList syntax), or stops blocking with null. Each list's group
   * (`ads`, `trackers`, `cookies`, or `shared`) lets a site turn a group off. The engine reads the files itself.
   */
  suspend fun setContentBlocking(context: Context, lists: List<String>?, version: String, groups: List<String>? = null) {
    suspendCoroutine { continuation ->
      BayEngineBackend.setContentBlocking(lists, groups, version, context.applicationContext) { result ->
        result.fold({ continuation.resume(Unit) }, { continuation.resumeWithException(it) })
      }
    }
  }

  /** Sites (hosts, matching their subdomains) where blocking is paused. */
  fun setBlockingPausedHosts(hosts: List<String>) = BayEngineBackend.setBlockingPausedHosts(hosts)

  /** The groups each site turns off, as `{ host: [group] }` JSON. */
  fun setSiteBlocking(json: String) = BayEngineBackend.setSiteBlocking(json)

  /** The tracking-parameter table (`@bay/core`'s `TRACKING_PARAMS` as JSON) stripped from main-frame navigations. */
  fun setTrackingParameters(json: String): Boolean = BayEngineBackend.setTrackingParameters(json)

  // Sessions and data

  /** Whether the app has private tabs, mounted or not: the private session lasts while this is true. */
  fun setPrivateSessionActive(active: Boolean) = BayEngineBackend.setPrivateSessionActive(active)

  /** Clears cookies, storage, cache, snapshots and saved tab states in every space's profile. Close page views first. */
  suspend fun clearData(context: Context, profiles: List<String>) {
    suspendCoroutine { continuation ->
      BayEngineBackend.clearWebsiteData(context, profiles) { error ->
        if (error != null) {
          continuation.resumeWithException(EngineException(error.code, error.message, error.cause))
          return@clearWebsiteData
        }
        try {
          BayEngineSnapshots.clear(context)
          BayEngineTabStates.clear(context)
          continuation.resume(Unit)
        } catch (failure: Exception) {
          continuation.resumeWithException(failure)
        }
      }
    }
  }

  /** Deletes a space's website data, as deleting the space does. */
  suspend fun deleteProfile(context: Context, profile: String) {
    suspendCoroutine { continuation -> BayEngineBackend.deleteProfile(context, profile) { continuation.resume(Unit) } }
  }

  /** Deletes snapshots that aren't in `keep` (file URIs). Recent files stay: their tab may not have been told yet. */
  fun pruneSnapshots(context: Context, keep: List<String>) {
    val names = keep.mapNotNullTo(HashSet()) { Uri.parse(it).lastPathSegment }
    val cutoff = System.currentTimeMillis() - 30_000
    BayEngineSnapshots.directory(context).listFiles()?.forEach { file ->
      if (file.name !in names && file.lastModified() < cutoff) file.delete()
    }
  }

  /** Deletes saved tab states whose tab ids aren't in `keep`. */
  fun pruneTabStates(context: Context, keep: List<String>) = BayEngineTabStates.prune(context, keep)

  // Downloads, images, media and voice

  /** Opens a finished download in the app that shows its type. */
  suspend fun openDownload(context: Context, reference: String) {
    answer<Any?> { BayDownloads.open(context, reference, it) }
  }

  fun cancelDownload(id: String) = BayDownloads.cancel(id)

  /** Saves a web image through the page on screen (with its cookies), shown by Bay's downloader. */
  suspend fun saveImage(context: Context, url: String) {
    answer<Any?> { BayEngineBackend.saveImage(context, url, it) }
  }

  /** Posts what's playing to the media notification, or clears it with a null title. */
  fun setMediaSession(context: Context, title: String?, site: String, playing: Boolean) {
    if (title == null) BayMedia.clear() else BayMedia.update(context, title, site, playing)
  }

  /** Listens once through the system's recogniser and answers with what was said, or null. */
  suspend fun listen(): String? = answer<Any?> { BayVoice.listen(host?.currentActivity, it) } as? String

  /** A shared link in an intent (`ACTION_SEND` text holding a web address), as `bay://share?url=…`, or null. */
  fun shareLink(intent: Intent?): String? {
    if (intent?.action != Intent.ACTION_SEND) return null
    val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return null
    val url = sharedPattern.find(text)?.value?.trimEnd(')', '.', ',', ';', '"', '\'') ?: return null
    return "bay://share?url=" + Uri.encode(url, "")
  }

  private val sharedPattern = Regex("https?://[^\\s\"<>()\\[\\]]+")

  private suspend fun <T> answer(call: (Promise) -> Unit): T = suspendCoroutine { call(it.asPromise()) }
}

/** What the system's media controls asked for. */
enum class MediaControl(val action: String) {
  TOGGLE("toggle"),
  STOP("stop"),
  SKIP_FORWARD("skip-forward"),
  SKIP_BACKWARD("skip-backward"),
}

class EngineException(val code: String, message: String, cause: Throwable? = null) : Exception(message, cause)
