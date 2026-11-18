package bay.app.browser

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import bay.app.AppModel
import bay.app.Strings
import bay.core.Action
import bay.core.BookmarkNode
import bay.core.BrowserSpace
import bay.core.BrowserFolder
import bay.core.BrowserTab
import bay.core.DownloadItem
import bay.core.DownloadState
import bay.core.MediaReport
import bay.core.NavigationReport
import bay.core.PinKind
import bay.core.PinnedSite
import bay.core.ReaderSettings
import bay.core.ReaderSettingsInput
import bay.core.ScriptTiming
import bay.core.SearchEngine
import bay.core.SiteSetting
import bay.core.SiteSettingInput
import bay.core.SpaceColor
import bay.core.TabUpdate
import bay.core.TipId
import bay.core.cleanUrl
import bay.core.hostOf
import bay.core.initialTiming
import bay.core.isWebUrl
import bay.core.parseMediaMessage
import bay.core.readerVariables
import bay.core.scriptsFor
import bay.core.searchEngine
import bay.core.siteHost
import bay.engine.BayEngineView
import bay.engine.Engine
import bay.engine.EngineEvent
import bay.engine.MediaControl
import bay.engine.NavigationState
import bay.engine.PageRequest
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
import org.json.JSONObject

/** What a search opens: a page, an open tab, or a tab back from the archive. */
sealed interface OpenTarget {
    data class Url(val url: String) : OpenTarget

    data class Tab(val id: String) : OpenTarget

    data class Archived(val id: String) : OpenTarget
}

enum class Overlay { NONE, SEARCH, TABS }

/** The sheet open over the browser. */
enum class Panel { PAGE, SPACE_EDIT, ARCHIVE, HISTORY, BOOKMARKS, DOWNLOADS, SITE_SETTINGS, LINK, TABS, PIN, REQUEST, READER }

/** Ad and tracker blocking on the page showing: on, paused for its site, off for this visit only, or off in Settings. */
enum class PageBlocking { ON, PAUSED, RESTORED, OFF }

/** Find on page: the words, what the page found for them (`count` null before the first search ends), the match shown. */
data class FindState(val query: String = "", val count: Int? = null, val index: Int = -1, val foundFor: String = "")

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

    private var panelState by mutableStateOf<Panel?>(null)

    var panel: Panel?
        get() = panelState
        set(value) {
            val before = panelState
            panelState = value
            // The prompts sheet swiped away (or covered by another): the page's question is cancelled.
            if (before == Panel.REQUEST && value != Panel.REQUEST && pageRequests.isNotEmpty()) answerPageRequest(false)
        }

    /** What pages asked and wait on, oldest first; the prompts sheet shows the first. */
    val pageRequests = mutableStateListOf<Pair<String, PageRequest>>()

    /** The tab whose page Reader is showing; a new page in it, or another tab, ends Reader. */
    var readerTab by mutableStateOf<String?>(null)
        private set

    /** The address Reader last opened by itself on (a site that keeps Reader on), so coming back stays quiet. */
    private var autoReaderUrl: String? = null

    /** The tab whose card was held, for the pin sheet. */
    var pinTab by mutableStateOf<BrowserTab?>(null)
        private set

    /** The folder picked in the tabs menu, which it renames or deletes. */
    var activeFolderId by mutableStateOf<String?>(null)

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

    /** Find on page, while it is open over the page showing. */
    var find by mutableStateOf<FindState?>(null)
        private set

    /** What the blocker stopped on each page, where the engine counts it. */
    val blocked = mutableStateMapOf<String, Int>()

    /** A site shown without blocking until its tab leaves it. */
    var restoredHost by mutableStateOf<String?>(null)
        private set

    /** The link (or bare image) a long press on the page showing opened the link menu for. */
    var link by mutableStateOf<EngineEvent.LinkPress?>(null)
        private set

    /** AMP pages each tab already left for their publisher's page. One that comes back stays, so the two never bounce. */
    private val ampLeft = HashMap<String, MutableSet<String>>()
    private var findTimer: Job? = null

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
            configure(this, tab.url)
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
            // An unloaded page no longer waits on its questions.
            if (pageRequests.removeAll { it.first == id } && pageRequests.isEmpty() && panelState == Panel.REQUEST) panelState = null
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
        if (id != app.activeTabId) {
            endFind()
            readerTab = null
        }
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

    /** A space with the next default name ("Space 3"). */
    fun newSpace() = createSpace(strings.t("space.default", mapOf("index" to "${app.spaces.size + 1}")))

    fun newFolder(name: String) {
        val folder = BrowserFolder(UUID.randomUUID().toString(), app.activeSpaceId, name)
        app.dispatch(Action.NewFolder(folder))
        activeFolderId = folder.id
    }

    fun renameFolder(id: String, name: String) = app.dispatch(Action.RenameFolder(id, name))

    /** Deletes a folder; its pinned rows return to the top level. */
    fun deleteFolder(id: String) {
        if (activeFolderId == id) activeFolderId = null
        app.dispatch(Action.DeleteFolder(id))
    }

    /**
     * Moves the tab showing to a space, or into one of the space's folders, where its page is pinned as a row (as the
     * desktop's Pinned folders hold pinned rows).
     */
    fun moveActiveTab(spaceId: String, folderId: String?) {
        val id = app.activeTabId
        app.dispatch(Action.MoveTab(id, spaceId, null))
        activeFolderId = folderId
        if (folderId != null) app.dispatch(Action.PinSite(id, UUID.randomUUID().toString(), PinKind.ROW, folderId))
        refreshMounted()
    }

    /** The pin sheet for a held tab card. Private and blank tabs have nothing to pin. */
    fun showPinMenu(tab: BrowserTab) {
        if (tab.private || tab.url.isEmpty()) return
        pinTab = tab
        panel = Panel.PIN
    }

    /** Pins a tab's page that way, or unpins it when it is already pinned so. */
    fun pin(tab: BrowserTab, kind: PinKind, folderId: String?) {
        panel = null
        app.dispatch(Action.PinSite(tab.id, UUID.randomUUID().toString(), kind, folderId))
    }

    /** Answers the page question on show, then shows the next one waiting, if any. */
    fun answerPageRequest(accepted: Boolean, value: String? = null, username: String? = null, password: String? = null) {
        if (pageRequests.isEmpty()) return
        val (tabId, request) = pageRequests.removeAt(0)
        views[tabId]?.answerPageRequest(request.id, accepted, value, username, password)
        panel = if (pageRequests.isNotEmpty()) Panel.REQUEST else if (panel == Panel.REQUEST) null else panel
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

    /** Opens a page from history or bookmarks: a page on screen stays, and the listed one opens beside it. */
    fun openListed(url: String) {
        panel = null
        overlay = Overlay.NONE
        val tab = activeTab
        if (hasPage || tab == null) openTab(url) else navigate(tab.id, url)
    }

    /** Brings an archived tab back and shows it. */
    fun restoreArchived(id: String) {
        panel = null
        overlay = Overlay.NONE
        restore(id)
    }

    /** Opens a finished download in the phone's viewer for its kind. */
    fun openDownload(item: DownloadItem) {
        val path = item.path?.takeIf { item.state == DownloadState.FINISHED } ?: return
        scope.launch {
            runCatching { Engine.openDownload(context, path) }.onFailure { showToast(strings.t("downloads.status.failed")) }
        }
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
            is EngineEvent.BlockedCount -> blocked[tabId] = event.count
            is EngineEvent.LinkPress -> if (tabId == app.activeTabId) {
                link = event
                panel = Panel.LINK
            }
            is EngineEvent.Request -> {
                pageRequests += tabId to event.request
                panel = Panel.REQUEST
            }
            else -> {}
        }
    }

    private fun navigated(tabId: String, state: NavigationState) {
        val before = navigation[tabId]
        val started = state.isLoading && before?.isLoading != true
        val finished = !state.isLoading && (before?.isLoading ?: true)
        if (before != state) navigation[tabId] = state
        if (before?.url != state.url) views[tabId]?.let { configure(it, state.url) }
        val restored = restoredHost
        if (tabId == app.activeTabId && restored != null && hostOf(state.url) != restored) {
            // A site shown without blocking for one visit gets its blocking back once the tab is somewhere else.
            restoredHost = null
            applyBlockingPauses()
        }
        if (started) {
            blocked.remove(tabId)
            if (tabId == app.activeTabId) endFind()
            if (readerTab == tabId) readerTab = null
            failed -= tabId
            if (failure?.tabId == tabId) failure = null
            // A new document has no media until it reports some.
            if (media.remove(tabId) != null) updateMediaSession()
        }
        val view = views[tabId]
        if (finished && tabId == app.activeTabId) openReaderBySite(tabId, state.url)
        if (finished && view != null) {
            scope.launch {
                val json = runCatching { view.runScript(PageScript.PAGE_COLOR) }.getOrNull()
                val rgb = json?.let { runCatching { JSONArray(it) }.getOrNull() }?.let { array -> List(array.length()) { array.getDouble(it) } }
                if (rgb != null) pageColors[tabId] = rgb else pageColors.remove(tabId)
            }
        }
        val plan = scriptsFor(timing[tabId] ?: initialTiming(), NavigationReport(state.url, state.progress, state.isLoading), false)
        timing[tabId] = plan.timing
        if (plan.watchMedia && view != null) {
            // Early in each load (so text doesn't jump late) and again once it finishes.
            applyTweaks(tabId, state.url)
            scope.launch { runCatching { view.runScript(PageScript.WATCH_MEDIA) } }
        }

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

    // The page menu

    private val activeView: BayEngineView? get() = views[app.activeTabId]

    /** The address the page showing is at: what it last reported, else its tab's. */
    val activeUrl: String get() = activeNavigation.url.ifEmpty { activeTab?.url.orEmpty() }

    fun goBack() = activeView?.goBack()

    fun goForward() = activeView?.goForward()

    fun reload() = activeView?.reload()

    fun stop() = activeView?.stop()

    val isPinned: Boolean
        get() {
            val url = activeTab?.url
            return app.pins.any { it.kind == PinKind.ESSENTIAL && it.url == url }
        }

    val isBookmarked: Boolean
        get() {
            val url = activeTab?.url
            return !url.isNullOrEmpty() && app.store.isBookmarked(app.activeSpaceId, url)
        }

    fun togglePin() {
        val tab = activeTab ?: return
        val pinned = isPinned
        app.dispatch(Action.PinSite(tab.id, UUID.randomUUID().toString(), PinKind.ESSENTIAL, null))
        showToast(if (pinned) strings.t("toast.unpinned") else strings.t("toast.pinned"))
    }

    fun toggleBookmark() {
        val tab = activeTab?.takeIf { it.url.isNotEmpty() } ?: return
        val bookmarked = isBookmarked
        val bookmark = BookmarkNode.Url(UUID.randomUUID().toString(), "bookmarks", tab.title.ifEmpty { tab.url }, tab.url, AppModel.now())
        app.dispatch(Action.ToggleBookmark(app.activeSpaceId, bookmark))
        if (bookmarked) {
            showToast(strings.t("toast.unbookmarked"))
        } else {
            showToast(strings.t("toast.bookmarked"), strings.t("toast.showBookmarks")) { panel = Panel.BOOKMARKS }
        }
    }

    fun share() = share(activeUrl)

    /** Shares a page address (a link's, an image's) through the system's share sheet. */
    fun share(address: String) {
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, cleanUrl(address))
        context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun copyLink() = copyAddress(activeUrl)

    /** Android 13+ confirms copies itself with the system's clipboard preview. */
    fun copyAddress(address: String) {
        copy(cleanUrl(address))
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) showToast(strings.t("toast.linkCopied"))
    }

    /** Saves a web image to Downloads. */
    fun saveImage(address: String) {
        scope.launch {
            runCatching { Engine.saveImage(context, address) }
                .onSuccess { showToast(strings.t("toast.savedToDownloads")) }
                .onFailure { showToast(strings.t("toast.imageNotSaved")) }
        }
    }

    private fun copy(text: String) {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText(null, text))
    }

    /** The page through Google Translate, into the app's language. */
    fun translate() {
        val url = activeUrl
        if (url.isEmpty() || Regex("^https://[^/]+\\.translate\\.goog/").containsMatchIn(url)) return
        val language = strings.locale.substringBefore('-').ifEmpty { "en" }
        navigate(app.activeTabId, "https://translate.google.com/translate?sl=auto&tl=$language&u=${Uri.encode(url)}")
    }

    /** The article on the page as Markdown, on the clipboard. */
    // Reader

    /** Reader on the page showing, with its settings sheet; when Reader already reads it, only the sheet opens. */
    fun openReader() {
        val tabId = app.activeTabId
        if (readerTab == tabId) {
            panel = Panel.READER
            return
        }
        val view = activeView ?: return
        scope.launch {
            if (startReader(view)) {
                readerTab = tabId
                panel = Panel.READER
            } else {
                if (panel == Panel.PAGE) panel = null
                showToast(strings.t("notice.noArticle"))
            }
        }
    }

    /** A site that keeps Reader on: as each page there finishes loading, Reader opens by itself, once per address. */
    private fun openReaderBySite(tabId: String, url: String) {
        if (readerTab == tabId || autoReaderUrl == url || url.isEmpty() || !app.store.siteSetting(url).reader) return
        if (locked && activeTab?.private == true) return
        val view = views[tabId] ?: return
        autoReaderUrl = url
        scope.launch { if (startReader(view) && app.activeTabId == tabId) readerTab = tabId }
    }

    /** Runs Reader's open script with the chosen look; false when the page has no article. */
    private suspend fun startReader(view: BayEngineView): Boolean {
        val json = runCatching { view.runScript(PageScript.OPEN_READER, mapOf("variables" to readerVariables(app.preferences.reader))) }.getOrNull()
        return json?.let { runCatching { JSONObject(it).optBoolean("ok") }.getOrNull() } ?: false
    }

    fun exitReader() {
        panel = null
        readerTab = null
        val view = activeView ?: return
        scope.launch { runCatching { view.runScript(PageScript.CLOSE_READER) } }
    }

    /** Keeps Reader's new look and restyles the page Reader is showing. */
    fun changeReader(settings: ReaderSettings) {
        app.dispatch(Action.ReaderSettingsChange(ReaderSettingsInput(settings.theme, settings.font, settings.size.toDouble())))
        val view = activeView?.takeIf { readerTab == app.activeTabId } ?: return
        scope.launch { runCatching { view.runScript(PageScript.UPDATE_READER, mapOf("variables" to readerVariables(settings))) } }
    }

    fun copyMarkdown() {
        val view = activeView ?: return
        scope.launch {
            val json = runCatching { view.runScript(PageScript.MARKDOWN) }.getOrNull() ?: return@launch
            val markdown = runCatching { JSONObject(json).getString("markdown") }.getOrNull() ?: return@launch
            copy(markdown)
            showToast(strings.t("notice.markdownCopied"))
        }
    }

    // This site's own settings

    /** What the page showing follows: its site's own setting, else every global choice. */
    val siteSetting: SiteSetting get() = app.store.siteSetting(activeUrl)

    /** The page's zoom in percent: its site's own, else Bay's. */
    val pageZoom: Int get() = (siteSetting.textSize ?: app.preferences.textSize).toInt()

    fun setZoom(zoom: Int) {
        val global = app.preferences.textSize.toInt()
        changeSiteSetting { it.copy(textSize = if (zoom == global) null else zoom.toDouble()) }
    }

    fun setDesktop(on: Boolean) = changeSiteSetting { it.copy(desktopMode = on) }

    fun changeSiteSetting(change: (SiteSettingInput) -> SiteSettingInput) {
        val host = siteHost(activeUrl)
        if (host.isEmpty()) return
        val setting = siteSetting
        val input = SiteSettingInput(setting.textSize?.toDouble(), setting.reader, setting.desktopMode, setting.blockOff, setting.swipe)
        app.dispatch(Action.SiteSettings(host, change(input)))
        preferencesChanged()
    }

    /** A changed preference or site setting reaches the open pages at once. */
    fun preferencesChanged() {
        for ((id, view) in views) {
            val url = navigation[id]?.url ?: app.tabs.firstOrNull { it.id == id }?.url.orEmpty()
            configure(view, url)
            applyTweaks(id, url)
        }
        applyBlockingPauses()
    }

    /** The page view's settings for the page it shows: its site's desktop mode and swipe, and Bay's own choices. */
    private fun configure(view: BayEngineView, url: String) {
        val preferences = app.preferences
        val setting = if (url.isEmpty()) null else app.store.siteSetting(url)
        view.desktopMode = setting?.desktopMode == true
        view.swipeMode = (setting?.swipe ?: preferences.swipeToNavigate).name.lowercase()
        view.pullToRefreshEnabled = preferences.pullToRefresh
        view.appLinks = preferences.appLinks.name.lowercase()
    }

    /** Bay's page zoom (the site's own first) and the AMP swap, on the page a tab shows. */
    private fun applyTweaks(tabId: String, url: String) {
        val view = views[tabId] ?: return
        if (!isWebUrl(url)) return
        val zoom = app.store.siteSetting(url).textSize ?: app.preferences.textSize
        val skipAmp = app.preferences.skipAmp && ampLeft[tabId]?.contains(url) != true
        scope.launch {
            val result = runCatching { view.runScript(PageScript.PAGE_TWEAKS, mapOf("textSize" to zoom, "skipAmp" to skipAmp)) }.getOrNull()
            if (result == "\"amp\"") ampLeft.getOrPut(tabId) { HashSet() } += url
        }
    }

    // Blocking on this page

    val blocking: PageBlocking
        get() {
            if (!app.preferences.blockContent) return PageBlocking.OFF
            val host = hostOf(activeUrl)
            return when {
                pausedEntry(host) != null -> PageBlocking.PAUSED
                host.isNotEmpty() && host == restoredHost -> PageBlocking.RESTORED
                else -> PageBlocking.ON
            }
        }

    /** The paused host this site falls under: itself or a domain it's part of. */
    private fun pausedEntry(host: String): String? =
        if (host.isEmpty()) null else app.preferences.blockingPausedHosts.firstOrNull { host == it || host.endsWith(".$it") }

    fun toggleBlocking() {
        val host = hostOf(activeUrl).ifEmpty { return }
        if (restoredHost == host) {
            restoredHost = null
        } else {
            val entry = pausedEntry(host)
            app.dispatch(Action.PauseBlocking(entry ?: host, entry == null))
        }
        applyBlockingPauses()
        // The change applies to new loads; reload so this page shows it.
        reload()
    }

    /**
     * The page again without blocking, and the question whether that fixed it: yes keeps blocking off for the site;
     * otherwise it comes back when the tab leaves.
     */
    fun restoreOriginal() {
        val host = hostOf(activeUrl).ifEmpty { return }
        restoredHost = host
        applyBlockingPauses()
        reload()
        showToast(strings.t("toast.restoredBlocking"), strings.t("toast.keepBlockingOff")) {
            app.dispatch(Action.PauseBlocking(host, true))
            restoredHost = null
            applyBlockingPauses()
        }
    }

    private fun applyBlockingPauses() = Engine.setBlockingPausedHosts(app.preferences.blockingPausedHosts + listOfNotNull(restoredHost))

    // Find on page

    fun startFind() {
        find = FindState()
    }

    fun findChanged(query: String) {
        val current = find ?: return
        find = current.copy(query = query)
        findTimer?.cancel()
        val view = activeView ?: return
        if (query.isEmpty()) {
            find = find?.copy(count = null)
            scope.launch { runCatching { view.runScript(PageScript.FIND_CLEAR) } }
            return
        }
        // Typing pauses a moment before the page is searched.
        findTimer = scope.launch {
            delay(150)
            search(query, view)
        }
    }

    private fun found(json: String?): Pair<Int, Int>? =
        json?.let { runCatching { JSONObject(it) }.getOrNull() }?.let { it.optInt("count") to it.optInt("index", -1) }

    private suspend fun search(query: String, view: BayEngineView) {
        // A page that can't be searched has nothing to show for these words.
        val (count, index) = found(runCatching { view.runScript(PageScript.FIND, mapOf("query" to query)) }.getOrNull()) ?: (0 to -1)
        val current = find ?: return
        if (current.query == query) find = current.copy(count = count, index = index, foundFor = query)
    }

    fun findStep(step: Int) {
        val current = find ?: return
        val view = activeView ?: return
        // Return right after typing searches now rather than stepping through the old matches.
        if (current.foundFor != current.query) {
            findTimer?.cancel()
            scope.launch { search(current.query, view) }
            return
        }
        if ((current.count ?: 0) == 0) return
        scope.launch {
            val (count, index) = found(runCatching { view.runScript(PageScript.FIND_STEP, mapOf("step" to step)) }.getOrNull()) ?: return@launch
            val now = find ?: return@launch
            if (now.query == current.query) find = now.copy(count = count, index = index)
        }
    }

    fun endFind() {
        if (find == null) return
        find = null
        findTimer?.cancel()
        activeView?.let { view -> scope.launch { runCatching { view.runScript(PageScript.FIND_CLEAR) } } }
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
