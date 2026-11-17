package bay.app

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import bay.core.Action
import bay.core.BrowserPreferences
import bay.core.BrowserSpace
import bay.core.BrowserStore
import bay.core.BrowserTab
import bay.core.Pairing
import bay.core.PhoneSync
import bay.core.StoreObserver
import bay.core.SyncObserver
import bay.core.SyncView
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * The app's view of the core: the browser store's slices screens read, and sync's view, refreshed whenever either
 * changes. Every change goes through the core; nothing here edits state of its own.
 */
class AppModel(context: Context, barTitle: String) {
    private val documents = context.filesDir.absolutePath
    val store: BrowserStore = BrowserStore.open(documents, UUID.randomUUID().toString(), now())
    val sync = PhoneSync(store, UrlConnectionHttp(), KeystoreSecrets(context), documents, deviceName(context), barTitle, null)

    var spaces by mutableStateOf(emptyList<BrowserSpace>())
        private set
    var activeSpaceId by mutableStateOf("")
        private set
    var activeTabId by mutableStateOf("")
        private set

    /** The tabs of the space showing, in list order. */
    var tabs by mutableStateOf(emptyList<BrowserTab>())
        private set
    var preferences by mutableStateOf<BrowserPreferences>(store.preferences())
        private set
    var syncView by mutableStateOf<SyncView>(sync.view())
        private set

    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var cycles: Job? = null
    private var kick: Job? = null
    private var pairing: Job? = null

    init {
        store.observe(object : StoreObserver {
            override fun changed(revision: ULong) {
                main.post { storeChanged() }
            }
        })
        sync.observe(object : SyncObserver {
            override fun changed(view: SyncView) {
                main.post { syncView = view }
            }
        })
        refresh()
    }

    fun dispatch(action: Action): Boolean = store.dispatch(action)

    /** Saves at once: as the app leaves the foreground. */
    fun flush() {
        runCatching { store.flush() }
    }

    /** Syncs every half minute while Bay is in front. */
    fun startSyncing() {
        cycles?.cancel()
        cycles = scope.launch {
            while (isActive) {
                sync.syncNow()
                delay(CYCLE_MS)
            }
        }
    }

    fun stopSyncing() {
        cycles?.cancel()
        kick?.cancel()
    }

    fun syncNow() {
        scope.launch { sync.syncNow() }
    }

    /** Shows a code and asks every two seconds whether a computer has let this phone in. */
    fun pair() {
        pairing?.cancel()
        pairing = scope.launch {
            var state: Pairing? = sync.startPairing()
            while (isActive && state is Pairing.Waiting) {
                delay(PAIRING_POLL_MS)
                state = sync.pollPairing()
            }
        }
    }

    fun cancelPairing() {
        pairing?.cancel()
        sync.cancelPairing()
    }

    /** Joins with the recovery phrase; the problem with it when it doesn't read. */
    suspend fun join(phrase: String): String? = runCatching { sync.joinWithPhrase(phrase) }.exceptionOrNull()?.message

    fun leave() {
        scope.launch { sync.leave() }
    }

    private fun storeChanged() {
        refresh()
        // A change to what syncs: a cycle a moment later, once a burst of changes has settled.
        kick?.cancel()
        kick = scope.launch {
            delay(AFTER_CHANGE_MS)
            sync.syncNow()
        }
    }

    private fun refresh() {
        spaces = store.spaces()
        activeSpaceId = store.activeSpaceId()
        activeTabId = store.activeTabId()
        tabs = store.spaceTabs(activeSpaceId)
        preferences = store.preferences()
    }

    companion object {
        private const val CYCLE_MS = 30_000L
        private const val AFTER_CHANGE_MS = 3_000L
        private const val PAIRING_POLL_MS = 2_000L

        /** Milliseconds since 1970, as the store's timestamps are. */
        fun now(): Long = System.currentTimeMillis()

        /** The name the person gave the phone, else its model. */
        private fun deviceName(context: Context): String =
            Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) ?: Build.MODEL ?: "Android"
    }
}
