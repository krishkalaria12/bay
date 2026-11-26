package bay.engine

import android.app.Activity
import android.content.Intent
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A call's one answer: a value, or why not. The engine's code answers through it. */
interface Promise {
  fun resolve(value: Any?)
  fun reject(code: String?, message: String?, cause: Throwable?)
}

/** A promise that resumes a coroutine: with the value, or with an `EngineException` for a rejection. */
internal fun <T> Continuation<T>.asPromise(): Promise = object : Promise {
  @Suppress("UNCHECKED_CAST")
  override fun resolve(value: Any?) = resume(value as T)

  override fun reject(code: String?, message: String?, cause: Throwable?) =
    resumeWithException(EngineException(code ?: "E_ENGINE", message ?: "The engine couldn't do that.", cause))
}

/** An activity result the engine asked for (a file chooser, voice search), handed back by the activity. */
data class OnActivityResultPayload(val requestCode: Int, val resultCode: Int, val data: Intent?)

/**
 * What the engine needs from the app's activity: the activity itself, to start pickers and intents from, and runtime
 * permissions for a page that asks for the camera, the microphone or the location. The activity sets `Engine.host`
 * and hands back what it gets with `Engine.deliverActivityResult` and `Engine.deliverPermissionsResult`.
 */
interface EngineHost {
  val currentActivity: Activity?

  fun hasPermission(permission: String): Boolean

  /** Asks the system for `permissions`, then calls `done` once the person answered. */
  fun requestPermissions(permissions: Array<String>, done: () -> Unit)
}

/** What a page view reports: one stream per view (`BayEngineView.onEvent`), on the main thread. */
sealed interface EngineEvent {
  /** The address, title, progress, loading and history the view now has. */
  data class Navigation(val state: NavigationState) : EngineEvent

  /** A main-frame load failed. */
  data class Failure(val url: String, val code: String, val message: String) : EngineEvent

  /** How far the bar (BayEngineView.barHeight) has slid away with the page: 0 showing in full, 1 gone. Each frame it moves. */
  data class BarMoved(val hidden: Float) : EngineEvent

  /** A long press on a link or a bare image, which the app's own menu answers. */
  data class LinkPress(val url: String, val title: String, val x: Double?, val y: Double?, val image: Boolean) : EngineEvent

  /** A message a page script sent with `post(message)`, as JSON text. */
  data class PageMessage(val message: String) : EngineEvent

  /** A site asked something and waits: answer with `BayEngineView.answerPageRequest`. */
  data class Request(val request: PageRequest) : EngineEvent

  /** A new window (`target=_blank`, `window.open`) that becomes a real tab, in the opener's own session. */
  data class NewWindow(val url: String, val isPrivate: Boolean) : EngineEvent

  /** A page's video went fullscreen, or came back out of it. */
  data class Fullscreen(val fullscreen: Boolean) : EngineEvent

  /** A swipe back past the tab's first page (`back`), or forward past its last. */
  data class SwipedPast(val back: Boolean) : EngineEvent

  /** How many requests the blocker stopped on the page now showing. */
  data class BlockedCount(val count: Int) : EngineEvent
}

data class NavigationState(
  val url: String,
  val title: String,
  /** Estimated completion, between 0 and 1. */
  val progress: Double,
  val isLoading: Boolean,
  val canGoBack: Boolean,
  val canGoForward: Boolean,
  /** The tab's first navigation became a download, so it has no page to show. */
  val blank: Boolean = false,
) {
  companion object {
    val EMPTY = NavigationState("", "", 0.0, isLoading = false, canGoBack = false, canGoForward = false)
  }
}

/** A page's `alert`/`confirm`/`prompt`, the server's HTTP sign-in, a link to another app, or a device permission. */
data class PageRequest(
  val id: String,
  /** `alert`, `confirm`, `prompt`, `auth`, `external` or `permission`. */
  val kind: String,
  val message: String,
  val url: String,
  val defaultValue: String? = null,
  val realm: String? = null,
  val externalUrl: String? = null,
  /** `camera`, `microphone`, `camera-microphone` or `location`. */
  val permission: String? = null,
)
