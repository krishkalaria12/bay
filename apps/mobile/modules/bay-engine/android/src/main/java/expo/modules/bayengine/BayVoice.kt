package expo.modules.bayengine

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import expo.modules.kotlin.Promise
import expo.modules.kotlin.events.OnActivityResultPayload
import java.util.Locale

/**
 * Voice search (B16): one system recognition, resolved with the transcript or null (cancelled, denied, or no
 * recognition service on the device). The intent travels through the module's `OnActivityResult`, like the file
 * chooser (BayFileChooser); only one recognition is pending at a time.
 */
object BayVoice {
  const val REQUEST_CODE = 7920

  /** The pending recognition's result sink, or null when nothing is listening. Main thread only. */
  private var pending: Promise? = null

  fun listen(activity: Activity?, promise: Promise) {
    if (activity == null || pending != null) {
      promise.resolve(null)
      return
    }

    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtras(
      android.os.Bundle().apply {
        putString(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.packageName)
        putString(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putString(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
        putInt(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        putBoolean(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      },
    )

    // No recogniser on the device (some small devices have none): say nothing rather than waking an error screen.
    if (intent.resolveActivity(activity.packageManager) == null) {
      promise.resolve(null)
      return
    }

    pending = promise
    activity.startActivityForResult(intent, REQUEST_CODE)
  }

  /** Delivers an activity result to the pending recognition; true when it was for [REQUEST_CODE]. */
  fun deliver(payload: OnActivityResultPayload): Boolean {
    if (payload.requestCode != REQUEST_CODE) return false
    val answer = pending
    pending = null
    if (answer == null) return true

    answer.resolve(
      if (payload.resultCode == Activity.RESULT_OK) {
        payload.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
      } else {
        null
      },
    )
    return true
  }
}
