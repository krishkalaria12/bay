package bay.app.browser

import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import bay.app.AppModel
import bay.app.Strings
import bay.core.Action
import bay.core.BrowserSpace
import bay.core.BrowserTab
import bay.core.MediaReport
import bay.core.NavigationReport
import bay.core.PinnedSite
import bay.core.ScriptTiming
import bay.core.SearchEngine
import bay.core.SpaceColor
import bay.core.TabUpdate
import bay.core.TipId
import bay.core.hostOf
import bay.core.initialTiming
import bay.core.isWebUrl
import bay.core.parseMediaMessage
import bay.core.scriptsFor
import bay.core.searchEngine
import bay.engine.BayEngineView
import bay.engine.Engine
import bay.engine.EngineEvent
import bay.engine.MediaControl
import bay.engine.NavigationState
import bay.engine.PageScript
import bay.engine.runScript
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray

/** What a search opens: a page, an open tab, or a tab back from the archive. */
sealed interface OpenTarget {
    data class Url(val url: String) : OpenTarget

    data class Tab(val id: String) : OpenTarget

    data class Archived(val id: String) : OpenTarget
}

enum class Overlay { NONE, SEARCH, TABS }

/** The sheet open over the browser. */
enum class Panel { SPACE_EDIT }

/** A card growing into its page: the tab and where its card sat on screen, in pixels. */
data class Zoom(val tab: BrowserTab, val frame: androidx.compose.ui.geometry.Rect)

/** One short message above the bar; a newer one replaces it. One with an action (Undo) stays longer. */
data class ToastMessage(val id: Long, val text: String, val actionLabel: String? = null, val action: (() -> Unit)? = null)

/** What a tab's media last reported, and when. */
data class TabMedia(val report: MediaReport, val at: Long)

/** A page that failed to load, while its tab shows. */
data class PageFailure(val tabId: String, val url: String, val message: String)

/**
 * The browser screen's state over the store: which pages are loaded, what each reports, and what is over them. The
 * Expo app's BrowserScreen, without its rendering. Every change to tabs goes through the core's store.
 */
class BrowserModel(private val context: Context, val app: AppModel, private val strings: Strings) {
    var overlay by mutableStateOf(Overlay.NONE)

    var panel by mutableStateOf<Panel?>(null)

    var zoom by mutableStateOf<Zoom?>(null)
        private set

    var toast by mutableStateOf<ToastMessage?>(null)
        private set

    /** The bar is scrolled away while the page scrolls down. */
    var barHidden by mutableStateOf(false)
        private set

    /** Media playing (or paused) in each tab, as its page reports it. */
    val media = mutableStateMapOf<String, TabMedia>()

    /** Private tabs are covered once Bay has been in the background, until the owner unlocks them. */
    var locked by mutableStateOf(false)
        private set

    private var toastTimer: Job? = null

    /** Tabs stopped from the mini player or the system's controls: the pause report that follows stays out. */
    private val stopped = HashSet<String>()

    /** The search was started for a new tab (from the switcher) rather than for the page on screen. */
    var searchInNewTab by mutableStateOf(false)
        private set
    var searchPrivately by mutableStateOf(false)
        private set

    /** What each loaded page last reported. */
    val navigation = mutableStateMapOf<String, NavigationState>()
    var failure by mutableStateOf<PageFailure?>(null)
        private set

    /** The loaded pages, the one showing first. */
    var mounted by mutableStateOf(emptyList<String>())
        private set

    /** The colour at the top of each page, for the strip behind the status bar ([r, g, b]); absent when it has none. */
    val pageColors = mutableStateMapOf<String, List<Double>>()

    private val views = HashMap<String, BayEngineView>()
    private val visited = HashMap<String, String>()
    private val timing = HashMap<String, ScriptTiming>()
    private val failed = HashSet<String>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    init {
        app.mediaControl = ::mediaControl
    }

    val activeTab: BrowserTab? get() = app.tabs.firstOrNull { it.id == app.activeTabId }

    /** The tab showing has a page; otherwise the start page shows. */
    val hasPage: Boolean get() = !activeTab?.url.isNullOrEmpty()

    val activeNavigation: NavigationState get() = navigation[app.activeTabId] ?: NavigationState.EMPTY

    val engine: SearchEngine get() = searchEngine(app.preferences.searchEngineId, app.preferences.customSearchUrl)

    /** The page view for a tab, made the first time it is shown and kept while it stays loaded. */
    fun view(tab: BrowserTab): BayEngineView = views.getOrPut(tab.id) {
        BayEngineView(context).apply {
            isPrivate = tab.private
            profile = tab.spaceId
            // Private tabs keep no saved state.
            stateKey = if (tab.private) null else tab.id
            onEvent = { event -> receive(tab.id, event) }
            loadInitial(tab.url.ifEmpty { null })
        }
    }

    /** Keeps the tab showing loaded, with the most recently shown others, up to MAX_LIVE. */
    fun refreshMounted() {
        val existing = app.tabs.mapTo(HashSet()) { it.id }
        val next = if (hasPage) mutableListOf(app.activeTabId) else mutableListOf()
        // A tab playing media stays loaded, so its sound doesn't stop when others open.
        val playing = media.filterValues { it.report.playing }.keys.filter { it in existing }
        for (id in playing + mounted) {
            if (id !in next && id in existing && next.size < MAX_LIVE) next += id
        }
        views.keys.filter { it !in next }.forEach { id ->
            views.remove(id)?.let { view ->
                view.saveState()
                (view.parent as? android.view.ViewGroup)?.removeView(view)
                view.dispose()
            }
            navigation.remove(id)
            timing.remove(id)
            if (media.remove(id) != null) updateMediaSession()
        }
        if (next != mounted) mounted = next
    }

    /** A screen of its own (Settings) is over the browser: no page is active. */
    var covered by mutableStateOf(false)

    /** Takes every page view off the screen and forgets what they reported, for clearing browsing data. */
    fun closeAllPages() {
        overlay = Overlay.NONE
        panel = null
        views.values.forEach { view ->
            (view.parent as? android.view.ViewGroup)?.removeView(view)
            view.dispose()
        }
        views.clear()
        navigation.clear()
        timing.clear()
        visited.clear()
        media.clear()
        pageColors.clear()
        failure = null
        mounted = emptyList()
        Engine.setMediaSession(context, null, "", false)
    }

    // Actions

    fun search(inNewTab: Boolean, privately: Boolean = false) {
        searchInNewTab = inNewTab
        searchPrivately = privately
        overlay = Overlay.SEARCH
    }

    fun dismissSearch() {
        overlay = Overlay.NONE
    }

    fun open(target: OpenTarget, privately: Boolean) {
        overlay = Overlay.NONE
        when (target) {
            is OpenTarget.Tab -> activate(target.id)
            is OpenTarget.Archived -> restore(target.id)
            is OpenTarget.Url -> {
                // The tab showing takes the page unless the search was for a new tab, or private mode changed.
                val active = activeTab
                if (active != null && (!searchInNewTab || !hasPage) && active.private == privately) {
                    navigate(active.id, target.url)
                    return
                }
                val emptyTab = if (hasPage) null else active?.id
                openTab(target.url, privately)
                emptyTab?.let(::close)
            }
        }
    }

    fun navigate(tabId: String, url: String) {
        app.dispatch(Action.UpdateTab(tabId, TabUpdate(url, null, null, null, null)))
        views[tabId]?.let { runCatching { it.load(url) } }
        refreshMounted()
    }

    fun activate(id: String) {
        app.dispatch(Action.ActivateTab(id, AppModel.now()))
        overlay = Overlay.NONE
        barHidden = false
        refreshMounted()
    }

    fun openTab(url: String, privately: Boolean = false, background: Boolean = false) {
        app.dispatch(Action.NewTab(blankTab(app.activeSpaceId, url, privately), background))
        refreshMounted()
    }

    /** Closes a tab into the archive (private tabs are simply gone). A space left without tabs gets a blank one. */
    fun close(id: String) {
        val spaceId = app.store.tabs().firstOrNull { it.id == id }?.spaceId ?: app.activeSpaceId
        app.dispatch(Action.CloseTab(id, AppModel.now(), blankTab(spaceId)))
        visited.remove(id)
        refreshMounted()
    }

    /** Closes a tab into the archive, with a toast to bring it straight back. */
    fun archive(id: String) {
        val tab = app.store.tabs().firstOrNull { it.id == id }
        close(id)
        if (tab == null || tab.url.isEmpty() || tab.private) return
        showToast(strings.t("toast.tabArchived"), strings.t("toast.undo")) { restore(id) }
    }

    /** Takes a pin away, with a toast to put it back where it was. */
    fun unpin(site: PinnedSite) {
        val index = app.store.pinnedSites(site.spaceId).indexOfFirst { it.id == site.id }.coerceAtLeast(0)
        app.dispatch(Action.RemovePin(site.id))
        showToast(strings.t("toast.unpinned"), strings.t("toast.undo")) { app.dispatch(Action.AddPin(site, index.toLong())) }
    }

    fun showToast(text: String, actionLabel: String? = null, action: (() -> Unit)? = null) {
        val message = ToastMessage(System.nanoTime(), text, actionLabel, action)
        toast = message
        toastTimer?.cancel()
        toastTimer = scope.launch {
            delay(if (action == null) 2_500 else 8_000)
            if (toast?.id == message.id) toast = null
        }
    }

    fun dismissToast() {
        toast = null
    }

    // The bar

    /** Moves to the tab before (-1) or after (1) the one showing, in the switcher's order. */
    fun swipeTabs(step: Int) {
        val index = app.tabs.indexOfFirst { it.id == app.activeTabId }
        val next = app.tabs.getOrNull(index + step) ?: return
        app.dispatch(Action.TipSeen(TipId.BAR))
        capture(app.activeTabId)
        activate(next.id)
    }

    private fun scrolled(tabId: String, offsetY: Double, deltaY: Double) {
        if (tabId != app.activeTabId) return
        if (offsetY < 24 || deltaY < -8) barHidden = false else if (deltaY > 8) barHidden = true
    }

    // Media

    /** The tab whose media the mini player shows: the latest playing one that isn't on screen. */
    val player: Pair<BrowserTab, TabMedia>?
        get() {
            val onScreen = if (overlay == Overlay.NONE && hasPage) app.activeTabId else null
            return latestMedia { it.id != onScreen && !(locked && it.private) }
        }

    private fun latestMedia(include: (BrowserTab) -> Boolean): Pair<BrowserTab, TabMedia>? {
        val tabs = app.store.tabs()
        return media.mapNotNull { (id, state) -> tabs.firstOrNull { it.id == id }?.takeIf(include)?.let { it to state } }
            .maxWithOrNull(compareBy<Pair<BrowserTab, TabMedia>> { it.second.report.playing }.thenBy { it.second.at })
    }

    /** The media notification shows the latest media outside private tabs. */
    private fun updateMediaSession() {
        val session = latestMedia { !it.private }
        if (session == null) {
            Engine.setMediaSession(context, null, "", false)
            return
        }
        val (tab, state) = session
        Engine.setMediaSession(context, state.report.title.ifEmpty { tab.title }, hostOf(tab.url), state.report.playing)
    }

    private fun mediaControl(control: MediaControl) {
        val tab = latestMedia { !it.private }?.first ?: return
        when (control) {
            MediaControl.TOGGLE -> toggleMedia(tab.id)
            MediaControl.STOP -> stopMedia(tab.id)
            MediaControl.SKIP_FORWARD -> seekMedia(tab.id, 10)
            MediaControl.SKIP_BACKWARD -> seekMedia(tab.id, -10)
        }
    }

    fun toggleMedia(tabId: String) = command(tabId, PageScript.TOGGLE_MEDIA)

    fun seekMedia(tabId: String, seconds: Int) = command(tabId, PageScript.SEEK_MEDIA, mapOf("seconds" to seconds))

    fun stopMedia(tabId: String) {
        stopped += tabId
        command(tabId, PageScript.PAUSE_MEDIA)
        media.remove(tabId)
        updateMediaSession()
    }

    fun pictureInPicture(tabId: String) = command(tabId, PageScript.PIP_MEDIA)

    /** Runs a media script on a tab's page; one that finds no media there forgets the tab's media. */
    private fun command(tabId: String, script: PageScript, args: Map<String, Any?>? = null) {
        val view = views[tabId] ?: return
        scope.launch {
            val result = runCatching { view.runScript(script, args) }.getOrNull()
            if (result == "null") {
                media.remove(tabId)
                updateMediaSession()
            }
        }
    }

    private fun mediaReported(tabId: String, report: MediaReport) {
        if (!report.playing && tabId in stopped) return
        stopped -= tabId
        media[tabId] = TabMedia(report, System.currentTimeMillis())
        updateMediaSession()
    }

    /** A card picked in the switcher grows into its page; a tab without a picture has nothing to grow from. */
    fun pick(tab: BrowserTab, frame: androidx.compose.ui.geometry.Rect) {
        if (tab.snapshot == null) activate(tab.id) else zoom = Zoom(tab, frame)
    }

    fun zoomFinished() {
        val current = zoom ?: return
        zoom = null
        activate(current.tab.id)
    }

    // Tips

    /** The first-run tip showing, if any: the bar's swipe, once two pages are open. */
    val tip: TipId?
        get() {
            if (overlay != Overlay.NONE || panel != null || locked || TipId.BAR in app.preferences.tipsSeen) return null
            return if (app.tabs.count { it.url.isNotEmpty() && !it.private } > 1) TipId.BAR else null
        }

    // Spaces

    val activeSpace: BrowserSpace? get() = app.spaces.firstOrNull { it.id == app.activeSpaceId }

    fun renameSpace(id: String, name: String) = app.dispatch(Action.RenameSpace(id, name))

    fun setSpaceIcon(id: String, icon: String) = app.dispatch(Action.SetSpaceIcon(id, icon))

    fun setSpaceColor(id: String, color: SpaceColor) = app.dispatch(Action.SetSpaceColor(id, color))

    /** Moves a space one place along the bar. */
    fun moveSpace(id: String, step: Int) {
        val index = app.spaces.indexOfFirst { it.id == id }
        if (index >= 0) app.dispatch(Action.ReorderSpace(id, (index + step).toLong()))
    }

    /** Deletes a space with what it kept, and a moment later its website data. */
    fun deleteSpace(id: String) {
        panel = null
        val fallback = app.store.spaces().firstOrNull { it.id != id }?.id ?: "personal"
        app.dispatch(Action.DeleteSpace(id, blankTab(fallback)))
        refreshMounted()
        scope.launch {
            delay(1_000)
            runCatching { Engine.deleteProfile(context, id) }
        }
    }

    // Private tabs

    /** Bay left the foreground: private tabs lock, when the owner asked for that and there are any. */
    fun appLeft() {
        if (app.preferences.lockPrivateTabs && app.store.tabs().any { it.private }) locked = true
    }

    /** The fingerprint, face or screen lock unlocks the private tabs. */
    fun unlock(activity: android.app.Activity) {
        val builder = BiometricPrompt.Builder(activity).setTitle(strings.t("lock.prompt"))
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            builder.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
        } else {
            @Suppress("DEPRECATION")
            builder.setDeviceCredentialAllowed(true)
        }
        builder.build().authenticate(CancellationSignal(), activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult?) {
                locked = false
            }
        })
    }

    // The tab switcher

    /** The space's tabs the switcher's grid shows: a tab showing a pinned page is reached by its pin instead. */
    val switcherTabs: List<BrowserTab>
        get() {
            val pinned = app.pins.mapTo(HashSet()) { it.url }
            return app.tabs.filter { it.url.isEmpty() || it.url !in pinned }
        }

    fun showTabs() {
        if (hasPage) capture(app.activeTabId)
        overlay = Overlay.TABS
    }

    /** Takes the tab's picture for the switcher now. Private tabs and failed pages keep none. */
    fun capture(tabId: String) {
        val view = views[tabId] ?: return
        if (tabId in failed || app.tabs.firstOrNull { it.id == tabId }?.private != false) return
        scope.launch {
            val uri = runCatching { view.snapshot() }.getOrNull() ?: return@launch
            app.dispatch(Action.UpdateTab(tabId, TabUpdate(null, null, null, null, uri)))
        }
    }

    /** Archives every tab in the switcher's grid; the pinned ones stay. A toast brings them back. */
    fun archiveAll() {
        val tabs = switcherTabs
        val archived = tabs.filter { it.url.isNotEmpty() && !it.private }.map { it.id }
        tabs.forEach { close(it.id) }
        overlay = Overlay.NONE
        if (archived.isEmpty()) return
        val text = if (archived.size == 1) strings.t("toast.oneTabArchived") else strings.t("toast.tabsArchived", mapOf("count" to "${archived.size}"))
        showToast(text, strings.t("toast.undo")) {
            archived.forEach(::restore)
            // Closing every tab left a blank one behind.
            app.store.tabs().filter { it.url.isEmpty() && it.spaceId == app.activeSpaceId }.forEach { close(it.id) }
        }
    }

    /** Switches to a space: the tab it was last on (or a fresh one) becomes current. */
    fun selectSpace(id: String) {
        if (id == app.activeSpaceId) return
        val hasTab = app.store.tabs().any { it.spaceId == id }
        app.dispatch(Action.SelectSpace(id, if (hasTab) null else blankTab(id)))
        refreshMounted()
    }

    fun createSpace(name: String) {
        val space = app.store.newSpace(UUID.randomUUID().toString(), name)
        app.dispatch(Action.CreateSpace(space, blankTab(space.id)))
        refreshMounted()
    }

    /** A pin's page: its tab in the space when one is open there, else a new one. */
    fun openPin(site: PinnedSite) {
        val open = app.store.tabs().firstOrNull { it.spaceId == site.spaceId && it.url == site.url }
        if (open != null) {
            activate(open.id)
            return
        }
        overlay = Overlay.NONE
        openTab(site.url)
    }

    fun restore(id: String) {
        app.dispatch(Action.RestoreTab(id, UUID.randomUUID().toString(), AppModel.now()))
        refreshMounted()
    }

    fun retry() {
        val current = failure ?: return
        failure = null
        navigate(current.tabId, current.url)
    }

    // Page reports

    private fun receive(tabId: String, event: EngineEvent) {
        when (event) {
            is EngineEvent.Navigation -> navigated(tabId, event.state)
            is EngineEvent.Failure -> {
                failed += tabId
                failure = PageFailure(tabId, event.url.ifEmpty { navigation[tabId]?.url.orEmpty() }, event.message)
            }
            // A new window becomes a real tab in front, in the opener's own session.
            is EngineEvent.NewWindow -> if (isWebUrl(event.url)) openTab(event.url, event.isPrivate)
            is EngineEvent.PageMessage -> parseMediaMessage(event.message)?.let { mediaReported(tabId, it) }
            is EngineEvent.Scroll -> scrolled(tabId, event.offsetY, event.deltaY)
            // Page dialogs get their sheet with the panels (N5); until then nothing waits on one.
            is EngineEvent.Request -> views[tabId]?.answerPageRequest(event.request.id, false, null, null, null)
            else -> {}
        }
    }

    private fun navigated(tabId: String, state: NavigationState) {
        val before = navigation[tabId]
        val started = state.isLoading && before?.isLoading != true
        val finished = !state.isLoading && (before?.isLoading ?: true)
        if (before != state) navigation[tabId] = state
        if (started) {
            failed -= tabId
            if (failure?.tabId == tabId) failure = null
            // A new document has no media until it reports some.
            if (media.remove(tabId) != null) updateMediaSession()
        }
        val view = views[tabId]
        if (finished && view != null) {
            scope.launch {
                val json = runCatching { view.runScript(PageScript.PAGE_COLOR) }.getOrNull()
                val rgb = json?.let { runCatching { JSONArray(it) }.getOrNull() }?.let { array -> List(array.length()) { array.getDouble(it) } }
                if (rgb != null) pageColors[tabId] = rgb else pageColors.remove(tabId)
            }
        }
        val plan = scriptsFor(timing[tabId] ?: initialTiming(), NavigationReport(state.url, state.progress, state.isLoading), false)
        timing[tabId] = plan.timing
        if (plan.watchMedia && view != null) scope.launch { runCatching { view.runScript(PageScript.WATCH_MEDIA) } }

        if (state.blank) {
            app.dispatch(Action.UpdateTab(tabId, TabUpdate("", "", null, null, null)))
            return
        }
        if (!isWebUrl(state.url)) return
        if (tabId in failed) {
            app.dispatch(Action.UpdateTab(tabId, TabUpdate(state.url, null, null, null, null)))
            return
        }
        app.dispatch(Action.UpdateTab(tabId, TabUpdate(state.url, state.title.ifEmpty { null }, null, null, null)))
        // Private pages stay out of history.
        val tab = app.store.tabs().firstOrNull { it.id == tabId } ?: return
        if (tab.private) return
        if (state.title.isNotEmpty() && visited[tabId] == state.url) app.dispatch(Action.PageTitle(state.url, state.title))
        if (!state.isLoading && visited[tabId] != state.url) {
            visited[tabId] = state.url
            app.dispatch(Action.Visit(tab.spaceId, state.url, state.title, null, AppModel.now()))
            // The tab's picture once the page has drawn: a newer visit replaces it.
            scope.launch {
                delay(600)
                capture(tabId)
            }
        }
    }

    companion object {
        /** At most this many pages stay loaded; the rest reload from their saved state when shown again. */
        const val MAX_LIVE = 4

        fun blankTab(spaceId: String, url: String = "", privately: Boolean = false): BrowserTab {
            val now = AppModel.now()
            return BrowserTab(UUID.randomUUID().toString(), url, "", null, now, now, null, privately, spaceId, null)
        }
    }
}
