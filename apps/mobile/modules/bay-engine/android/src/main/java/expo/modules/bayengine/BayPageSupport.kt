package expo.modules.bayengine

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors

// What both engines' page views share: none of it depends on how the page is rendered.

/** The activity behind a view's context, or null outside one. */
internal fun activityFor(context: Context): Activity? {
  var current: Context? = context
  while (current is ContextWrapper) {
    if (current is Activity) return current
    current = current.baseContext
  }
  return null
}

internal fun isWebUrl(url: Uri): Boolean = url.scheme?.lowercase() in listOf("http", "https") && !url.host.isNullOrEmpty()

/** A scheme that belongs to another app (B5): tel:, mailto:, maps, an app's own scheme. Web and page data stay here. */
internal fun isExternalUrl(url: Uri): Boolean {
  val scheme = url.scheme?.lowercase() ?: return false
  val inPage = setOf("http", "https", "about", "javascript", "data", "blob", "file", "ws", "wss", "chrome", "chrome-extension")
  return scheme !in inPage && Regex("^[a-z][a-z0-9+.-]*$").matches(scheme)
}

/** Hands a link to the app that takes it (B5), once the person agreed; nothing happens when no app does. */
internal fun openExternalUrl(context: Context, url: String) {
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

/** Asks the system for runtime permissions (B7); `done` receives whether they were granted (`requireAll` or any). */
internal fun requestSystemPermissions(appContext: AppContext, permissions: Array<String>, requireAll: Boolean = true, done: (Boolean) -> Unit) {
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

/**
 * Video fullscreen (A2): a page's player view over the whole window, in landscape and without the system bars, until
 * Back or the page itself ends it. The orientation and bars come back as they were.
 */
internal class BayFullscreen(private val context: Context) {
  private var view: View? = null
  private var originalOrientation: Int? = null
  private var backCallback: OnBackPressedCallback? = null

  val isShowing: Boolean
    get() = view != null

  /** Shows `fullscreen`; `onBack` runs when the person presses Back. False when it can't (already showing, no activity). */
  fun enter(fullscreen: View, onBack: () -> Unit): Boolean {
    if (view != null) return false
    val activity = activityFor(context) ?: return false
    view = fullscreen
    fullscreen.keepScreenOn = true
    (activity.window.decorView as ViewGroup).addView(fullscreen, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    originalOrientation = activity.requestedOrientation
    // Landscape for the video; the app follows the system orientation (B10), so this turns the whole activity
    // sideways for the player and restores whatever was current when the player's view hides.
    activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
    hideSystemBars(activity)
    registerBack(activity, onBack)
    return true
  }

  /** Takes the fullscreen view down; returns it, or null when nothing was showing. */
  fun exit(): View? {
    val shown = view ?: return null
    view = null
    shown.keepScreenOn = false
    backCallback?.remove()
    backCallback = null
    val activity = activityFor(context)
    if (activity != null) {
      (shown.parent as? ViewGroup)?.removeView(shown)
      originalOrientation?.let { activity.requestedOrientation = it }
      originalOrientation = null
      showSystemBars(activity)
    }
    return shown
  }

  private fun registerBack(activity: Activity, onBack: () -> Unit) {
    val appCompat = activity as? AppCompatActivity
    val back = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (view != null) {
          onBack()
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

  private fun hideSystemBars(activity: Activity) {
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

  private fun showSystemBars(activity: Activity) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      activity.window.insetsController?.show(WindowInsets.Type.systemBars())
    } else {
      @Suppress("DEPRECATION")
      activity.window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
        View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
    }
  }
}

/** A page view's switcher snapshot: each new one replaces the last in the app cache. */
internal class BaySnapshotWriter(private val context: Context) {
  /** Only [writer]'s single thread touches it, so swaps can't race. */
  private var file: File? = null

  /** Encodes `bitmap` as a JPEG off the main thread and resolves with its file URI; the bitmap is recycled. */
  fun write(bitmap: Bitmap, promise: Promise) {
    val directory = BayEngineSnapshots.directory(context)
    writer.execute {
      val next = File(directory, "${UUID.randomUUID()}.jpg")
      try {
        check(directory.isDirectory || directory.mkdirs()) { "Couldn't create the snapshot cache." }
        next.outputStream().use { if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 75, it)) throw IOException("Couldn't encode the page snapshot.") }
        val previous = file
        file = next
        previous?.delete()
        promise.resolve(Uri.fromFile(next).toString())
      } catch (error: Exception) {
        next.delete()
        promise.reject("E_SNAPSHOT", "Couldn't save the page snapshot.", error)
      } finally {
        bitmap.recycle()
      }
    }
  }

  companion object {
    /** Encodes and writes snapshots off the main thread, one at a time. */
    private val writer = Executors.newSingleThreadExecutor()

    /** Snapshots are at most this wide, in pixels. */
    const val MAX_WIDTH = 640
  }
}
