package bay.app

import android.content.pm.ApplicationInfo
import android.view.View
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager

/**
 * Debug builds only: keeps UiAutomator clients (Argent, the e2e tests) reading the screen as it is.
 *
 * Compose sends accessibility events only while an accessibility *service* is on, and UiAutomator isn't one (it's
 * missing from `getEnabledAccessibilityServiceList`, which Compose checks). Without "content changed" events, the
 * UiAutomator client keeps the nodes it cached on its first read, so every later read shows that first frame. After a
 * frame is drawn, this says the window's content changed, at most every [INTERVAL_MS], which clears that cache.
 * TalkBack and other services are unaffected: with one on, Compose sends its own events.
 */
fun View.announceContentChangesToUiAutomator() {
    if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return
    val accessibility = context.getSystemService(AccessibilityManager::class.java) ?: return
    var pending = false
    val announce = Runnable {
        pending = false
        if (!accessibility.isEnabled) return@Runnable
        val event = AccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED).apply {
            contentChangeTypes = AccessibilityEvent.CONTENT_CHANGE_TYPE_SUBTREE
            setSource(this@announceContentChangesToUiAutomator)
        }
        parent?.requestSendAccessibilityEvent(this, event)
    }
    viewTreeObserver.addOnDrawListener {
        if (pending || !accessibility.isEnabled) return@addOnDrawListener
        pending = true
        postDelayed(announce, INTERVAL_MS)
    }
}

private const val INTERVAL_MS = 100L
