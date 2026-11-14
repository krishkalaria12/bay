package expo.modules.bayengine

import android.app.Activity
import android.content.Intent
import android.net.Uri
import expo.modules.kotlin.events.OnActivityResultPayload

/**
 * File upload (A1): the system's file picker for `<input type="file">`. WebKit opens it natively on iOS; on Android
 * the engine asks the page view (BayTabClient.onFileChooser), which launches the picker and hands the chosen files
 * back to the page. Only one chooser can be pending at a time (a second request cancels the first, as Chrome does).
 * Results travel back through the module's `OnActivityResult` (the view has no activity-result handler of its own).
 */
object BayFileChooser {
  const val REQUEST_CODE = 7919

  /** The pending upload's result sink, or null when no picker is open. Main thread only. */
  var callback: ((Array<Uri>?) -> Unit)? = null
    private set

  fun setPending(pending: ((Array<Uri>?) -> Unit)?) {
    callback = pending
  }

  /** Cancels the pending upload, delivering null so the page treats it as a cancelled picker. */
  fun cancelPending() {
    callback?.invoke(null)
    callback = null
  }

  /** Delivers an activity result to the pending upload; true when it was for [REQUEST_CODE]. */
  fun deliver(payload: OnActivityResultPayload): Boolean {
    if (payload.requestCode != REQUEST_CODE) return false
    val pending = callback
    callback = null
    if (pending == null) return true
    val uris = if (payload.resultCode == Activity.RESULT_OK) urisFrom(payload.data) else null
    pending(uris)
    return true
  }

  private fun urisFrom(data: Intent?): Array<Uri>? {
    if (data == null) return null
    val clip = data.clipData
    if (clip != null && clip.itemCount > 0) {
      val uris = mutableListOf<Uri>()
      for (index in 0 until clip.itemCount) {
        clip.getItemAt(index).uri?.let { uris.add(it) }
      }
      if (uris.isNotEmpty()) return uris.toTypedArray()
    }
    return data.data?.let { arrayOf(it) }
  }
}
