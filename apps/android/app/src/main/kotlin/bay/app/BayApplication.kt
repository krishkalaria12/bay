package bay.app

import android.app.Application
import android.content.Context
import bay.core.CrashLog
import bay.core.CrashReport
import org.bay.engine.BayEngineApplication

/**
 * Starts Bay's Chromium. The engine's renderer and GPU processes run this class too, and none of the app starts in
 * them: `appProcess` is false there.
 */
class BayApplication : Application() {
    private var appProcess = true

    /** The crashes Bay kept, for Settings › Report a problem: made on first use (by a crash or by the app). */
    val crashLog: CrashLog by lazy { CrashLog(filesDir.absolutePath) }

    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
        appProcess = BayEngineApplication.attachBaseContext(this)
    }

    override fun onCreate() {
        super.onCreate()
        if (!appProcess) return
        keepCrashes()
        BayEngineApplication.onCreate(this)
    }

    /** Keeps a copy of what nothing caught, then lets the system's handler end the app as it would have. */
    private fun keepCrashes() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            runCatching { crashLog.record(CrashReport(System.currentTimeMillis(), throwable.toString(), throwable.stackTraceToString())) }
            previous?.uncaughtException(thread, throwable)
        }
    }
}
