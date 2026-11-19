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
import bay.core.BrowserFolder
import bay.core.BrowserPreferences
import bay.core.BrowserSpace
import bay.core.BrowserStore
import bay.core.BrowserTab
import bay.core.CrashLog
import bay.core.DownloadEvent
import bay.core.DownloadItem
import bay.core.HistoryEntry
import bay.core.Pairing
import bay.core.PhoneSync
import bay.core.PinnedSite
import bay.core.StoreObserver
import bay.core.SyncObserver
import bay.core.SyncView
import bay.core.resolveLink
import bay.engine.Engine
import bay.engine.MediaControl
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext
import kotlinx.coroutines.NonCancellable
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
    val http = UrlConnectionHttp()
    val sync = PhoneSync(store, http, KeystoreSecrets(context), documents, deviceName(context), barTitle, null)

    /** Fetches sites' icons from the sites themselves into the app's files; [favicons] lists what it has kept. */
    val iconFetcher = bay.core.Favicons(store, http, documents)

    /** Sign-ins saved from the HTTP sign-in sheet, in the keystore. */
    val logins = bay.core.SavedLogins(KeystoreSecrets(context))

    /** The crashes kept for Settings › Report a problem: the one the application records into. */
    val crashLog: CrashLog = (context.applicationContext as BayApplication).crashLog

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

    /** Where the link check's link ended, while the stand-in screens prove the HTTP client. */
    var resolved by mutableStateOf<String?>(null)
        private set

    /** Downloads, newest first. */
    var downloads by mutableStateOf(emptyList<DownloadItem>())
        private set

    /** The space's pinned pages: Essentials and rows. */
    var pins by mutableStateOf(emptyList<PinnedSite>())
        private set

    /** The space's folders of pinned rows. */
    var folders by mutableStateOf(emptyList<BrowserFolder>())
        private set

    /** The space's latest history, newest first, for the start page. */
    var recentHistory by mutableStateOf(emptyList<HistoryEntry>())
        private set

    /** Saved site icons (local file addresses) by host. */
    var favicons by mutableStateOf(emptyMap<String, String>())
        private set

    /** The store's revision: sheets that read the store directly (history, the archive, bookmarks) redraw when it moves. */
    var revision by mutableStateOf(0uL)
        private set

    /** Hears the system's media controls (the media notification): the screen showing the media sets it. */
    var mediaControl: ((MediaControl) -> Unit)? = null

    /** Hears each download update once the store has it, for the download toast. */
    var downloadUpdated: ((DownloadEvent) -> Unit)? = null

    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /** What the content blocker is doing, for Settings. */
    var blockerStatus by mutableStateOf<BlockerStatus>(BlockerStatus.Off)
        private set
    // Made on first use, after the engine has started.
    private val blocker by lazy { ContentBlocker(context.applicationContext, documents, http, scope) { blockerStatus = it } }
    private var cycles: Job? = null
    private var kick: Job? = null
    private var pairing: Job? = null

    /** Follows a link's redirects without opening it, as the link menu will. */
    fun resolve(url: String) {
        scope.launch { resolved = resolveLink(http, url) ?: "no answer" }
    }

    init {
        // Downloads keep reporting after their tab closes, so the store hears them here.
        Engine.start(
            downloads = { update ->
                main.post {
                    store.dispatch(Action.Download(update, now()))
                    downloadUpdated?.invoke(update)
                }
            },
            media = { control -> mediaControl?.invoke(control) },
        )
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
        // The icons of sites Bay shows without one, once a launch.
        scope.launch { iconFetcher.fillKnown() }
    }

    /**
     * The model follows the change at once, so the code that dispatched it reads the new state: the store's own notice
     * comes a turn later. A tab opened from a link at launch read the old active tab and mounted it, and that tab's
     * page took the window's compositor from the link's for a frame, which left the link's page blank.
     */
    fun dispatch(action: Action): Boolean = store.dispatch(action).also { changed -> if (changed) refresh() }

    /** Saves at once: as the app leaves the foreground. */
    fun flush() {
        runCatching { store.flush() }
    }

    /** Syncs every half minute while Bay is in front. */
    fun startSyncing() {
        cycles?.cancel()
        cycles = scope.launch {
            while (isActive) {
                cycle()
                delay(CYCLE_MS)
            }
        }
    }

    fun stopSyncing() {
        cycles?.cancel()
        kick?.cancel()
    }

    fun syncNow() {
        scope.launch { cycle() }
    }

    /** One cycle. Once started it runs to its end: cancelling the job waiting on it would throw away what it read. */
    private suspend fun cycle() = withContext(NonCancellable) { sync.syncNow() }

    /** Shows a code and asks every two seconds whether a computer has let this phone in. */
    fun pair() {
        pairing?.cancel()
        pairing = scope.launch {
            var state: Pairing? = sync.startPairing()
            while (isActive && state is Pairing.Waiting) {
                delay(PAIRING_POLL_MS)
                // A poll that finds the phone let in goes on to join, even if the code's page closes meanwhile.
                state = withContext(NonCancellable) { sync.pollPairing() }
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
            cycle()
        }
    }

    private fun refresh() {
        spaces = store.spaces()
        activeSpaceId = store.activeSpaceId()
        activeTabId = store.activeTabId()
        tabs = store.spaceTabs(activeSpaceId)
        preferences = store.preferences()
        blocker.follow(preferences)
        downloads = store.downloads()
        pins = store.pinnedSites(activeSpaceId)
        folders = store.folders(activeSpaceId)
        recentHistory = store.history(activeSpaceId, "", 0u, 24u)
        val icons = store.favicons()
        // Clearing history or browsing data drops icons: their files go too.
        if (icons.size < favicons.size) iconFetcher.forgetDropped()
        favicons = icons
        revision = store.revision()
        val hasPrivate = store.tabs().any { it.private }
        if (hasPrivate != privateSession) {
            privateSession = hasPrivate
            Engine.setPrivateSessionActive(hasPrivate)
        }
    }

    /** Whether the engine keeps the private session for tabs whose views are unloaded. */
    private var privateSession = false

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
