package bay.app

import android.app.Application
import android.content.Context
import org.bay.engine.BayEngineApplication

/**
 * Starts Bay's Chromium. The engine's renderer and GPU processes run this class too, and none of the app starts in
 * them: `appProcess` is false there.
 */
class BayApplication : Application() {
    private var appProcess = true

    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
        appProcess = BayEngineApplication.attachBaseContext(this)
    }

    override fun onCreate() {
        super.onCreate()
        if (!appProcess) return
        BayEngineApplication.onCreate(this)
    }
}
