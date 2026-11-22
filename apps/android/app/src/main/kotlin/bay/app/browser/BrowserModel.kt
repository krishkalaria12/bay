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
import android.util.Base64
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import bay.app.AppModel
import bay.app.BlockerStatus
import bay.app.Strings
import bay.core.Action
import bay.core.BayCommand
import bay.core.BookmarkNode
import bay.core.BrowserSpace
import bay.core.BrowserFolder
import bay.core.BrowserTab
import bay.core.DownloadEvent
import bay.core.DownloadEventState
import bay.core.DownloadItem
import bay.core.ImportCounts
import bay.core.ImportChoice
import bay.core.ChosenExport
import bay.core.ImportedTab
import bay.core.DownloadState
import bay.core.MediaReport
import bay.core.NavigationReport
import bay.core.PinKind
import bay.core.InspectedElement
import bay.core.PickedElement
import bay.core.PinnedSite
import bay.core.ReaderSettings
import bay.core.ReaderSettingsInput
import bay.core.ScriptTiming
import bay.core.SearchEngine
import bay.core.SiteFont
import bay.core.SiteSetting
import bay.core.SiteSettingInput
import bay.core.SpaceColor
import bay.core.TabUpdate
import bay.core.TipId
import bay.core.bayCommand
import bay.core.cleanUrl
import bay.core.incomingLink
import bay.core.initialTiming
import bay.core.isWebUrl
import kotlinx.coroutines.flow.drop
import androidx.compose.runtime.snapshotFlow
import bay.core.youtubeSelectors
import bay.core.opensWhenFinished
import bay.core.parseInspectedElement
import bay.core.parseMediaMessage
import bay.core.parsePickedMessage
import bay.core.readerVariables
import bay.core.scriptsFor
import bay.core.searchEngine
import bay.core.siteFontFace
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
import kotlinx.coroutines.async
import kotlinx.coroutines.withContext
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
enum class Panel { PAGE, SPACE_EDIT, HISTORY, SAVE, DOWNLOADS, SITE_SETTINGS, LINK, PIN, REQUEST, READER, INSPECT, IMPORT }

/** What the element picker does with a tap on the page: hide the element, or describe it. */
enum class PickMode { HIDE, INSPECT }

/** Ad and tracker blocking on the page showing: on, paused for its site, off for this visit only, or off in Settings. */
enum class PageBlocking { ON, PAUSED, RESTORED, OFF }

/** Find on page: the words, what the page found for them (`count` null before the first search ends), the match shown. */
data class FindState(val query: String = "", val count: Int? = null, val index: Int = -1, val foundFor: String = "")

/** A card growing into its page: the tab and where its card sat on screen, in pixels. */
data class Zoom(val tab: BrowserTab, val frame: androidx.compose.ui.geometry.Rect)

/**
 * A short notice at the top of the screen, under the status bar: the space just switched to, where a bookmark went.
 * Tapping it does `action`, when it has one.
 */
data class TopNote(val id: Long, val text: String, val space: BrowserSpace? = null, val action: (() -> Unit)? = null)

/** One short message above the bar; a newer one replaces it. One with an action (Undo) stays longer. */
/** A short message above the bar; a reading tool's notice (Inspect, Reader, the element picker) has its own id. */
data class ToastMessage(val id: Long, val text: String, val actionLabel: String? = null, val action: (() -> Unit)? = null, val notice: Boolean = false)

/** What a tab's media last reported, and when. */
data class TabMedia(val report: MediaReport, val at: Long)

/** A page that failed to load, while its tab shows. */
data class PageFailure(val tabId: String, val url: String, val message: String)

/**
 * The browser screen's state over the store: which pages are loaded, what each reports, and what is over them. Every
 * change to tabs goes through the core's store.
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
            // Inspect's details closed: the picker stays on, ready for the next tap.
            if (before == Panel.INSPECT && value != Panel.INSPECT) inspected = null
        }

    /** What pages asked and wait on, oldest first; the prompts sheet shows the first. */
    val pageRequests = mutableStateListOf<Pair<String, PageRequest>>()

    /** The element picker on the page showing, while it runs. */
    var picking by mutableStateOf<PickMode?>(null)
        private set

    /** What the picker selected last. */
    var picked by mutableStateOf<PickedElement?>(null)
        private set

    /** What Inspect read about the picked element. */
    var inspected by mutableStateOf<InspectedElement?>(null)
        private set

    /** Private tabs' hidden elements, by tab and host: kept in memory only, and gone with the tab. */
    private val privateRules = mutableStateMapOf<String, Map<String, List<String>>>()

    /** The download the toast above the bar shows: the latest one, until six seconds after it settles. */
    var downloadToastId by mutableStateOf<String?>(null)
        private set
    private var downloadToastTimer: Job? = null

    /** The tab whose page Reader is showing; a new page in it, or another tab, ends Reader. */
    var readerTab by mutableStateOf<String?>(null)
        private set

    /** The address Reader last opened by itself on (a site that keeps Reader on), so coming back stays quiet. */
    private var autoReaderUrl: String? = null

    /** The tab whose card was held, for the pin sheet. */
    var pinTab by mutableStateOf<BrowserTab?>(null)
        private set

    var zoom by mutableStateOf<Zoom?>(null)
        private set

    var toast by mutableStateOf<ToastMessage?>(null)
        private set
    var topNote by mutableStateOf<TopNote?>(null)
        private set
    private var topNoteTimer: Job? = null
    /** The bookmarks drawer is out, opened on `drawerFolder` when it has one. */
    var drawerOpen by mutableStateOf(false)
        private set
    var drawerFolder: String? = null
        private set
    /** The drawer shows the space's archived tabs instead of its bookmarks. */
    var drawerArchive by mutableStateOf(false)

    /**
     * How far the bar has slid away with the page showing: 0 in full, 1 gone. The engine moves it as Chrome moves its
     * bottom toolbar, in step with the page as it scrolls (BayEngineView.barHeight).
     */
    var barGone by mutableFloatStateOf(0f)
        private set

    /** How much of a page's bottom the bar covers, in pixels, as the screen lays it out. */
    private var barCover = 0

    /** The bar brought back for a moment on a site set to Always fullscreen, by a tap on the bottom edge. */
    var peeking by mutableStateOf(false)
        private set
    private var peekJob: Job? = null

    /** The page showing is on a site set to Always fullscreen, with nothing over it: no bar, no status bar. */
    val fullscreen: Boolean
        get() = hasPage && overlay == Overlay.NONE && panel == null && find == null && !drawerOpen && !peeking &&
            app.preferences.siteSettings[siteHost(activeUrl)]?.fullscreen == true

    /** The screen's layout of the bar: each page leaves that much room for it at its bottom while it shows. */
    fun barCoverChanged(pixels: Int) {
        if (barCover == pixels) return
        barCover = pixels
        for ((id, view) in views) configure(view, pageUrl(id))
    }

    /** The small pill tapped: the bar grows back out of it, and the page makes room for it again. */
    fun bringBarBack() {
        views[app.activeTabId]?.showBar()
        barGone = 0f
    }

    fun peekBar() {
        peeking = true
        barGone = 0f
        peekJob?.cancel()
        peekJob = scope.launch {
            delay(4_000)
            peeking = false
        }
    }

    /** Media playing (or paused) in each tab, as its page reports it. */
    val media = mutableStateMapOf<String, TabMedia>()

    /** Private tabs are covered once Bay has been in the background, until the owner unlocks them. */
    var locked by mutableStateOf(false)
        private set

    private var toastTimer: Job? = null

    /** Tabs stopped from the mini player or the system's controls: the pause report that follows stays out. */
    private val stopped = HashSet<String>()

    /** The search was started for a new tab (from the switcher or the bar) rather than for the page on screen. */
    var searchInNewTab by mutableStateOf(false)
        private set

    /** The page the bar's search opened over, for a new tab: the sheet's first row edits its address instead. */
    var searchOverPage by mutableStateOf<BrowserTab?>(null)
        private set

    /** The search sheet is about the page on screen (editing it, or from its bar), so the page stays frosted behind. */
    val searchKeepsPage get() = !searchInNewTab || searchOverPage != null
    var searchPrivately by mutableStateOf(false)
        private set

    /** The search card should listen as it opens: the widget's microphone (C7). The card turns it off as it starts. */
    var searchListening by mutableStateOf(false)

    /** What each loaded page last reported. */
    val navigation = mutableStateMapOf<String, NavigationState>()
    var failure by mutableStateOf<PageFailure?>(null)
        private set

    /** The loaded pages, the one showing first. */
    var mounted by mutableStateOf(emptyList<String>())
        private set

    /** The colour at the top of each page, for the strip behind the status bar ([r, g, b]); absent when it has none. */
    val pageColors = mutableStateMapOf<String, List<Double>>()

    /** The colour along each page's bottom edge, for the room under it behind the bar, which the bar takes its look from. */
    val pageBottomColors = mutableStateMapOf<String, List<Double>>()

    /**
     * A page colour as the page shows it: on a site with Force dark, Blink draws a light page dark, which the page's own
     * styles (what the colour is read from) don't say.
     */
    fun shownColor(rgb: List<Double>?): List<Double>? {
        if (app.preferences.siteSettings[siteHost(activeUrl)]?.forceDark != true) return rgb
        if (rgb == null || rgb.size < 3) return listOf(18.0, 18.0, 18.0)
        val light = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
        return if (light > 0.5) rgb.map { 255 - it } else rgb
    }

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
        app.downloadUpdated = ::downloadUpdated
        // A change to Settings > YouTube reaches the YouTube pages already open.
        scope.launch { snapshotFlow { app.preferences.youtube }.drop(1).collect { applyHiddenToOpenPages() } }
    }

    val activeTab: BrowserTab? get() = app.tabs.firstOrNull { it.id == app.activeTabId }

    /** The tab showing has a page; otherwise the start page shows. */
    val hasPage: Boolean get() = !activeTab?.url.isNullOrEmpty()

    val activeNavigation: NavigationState get() = navigation[app.activeTabId] ?: NavigationState.EMPTY

    val engine: SearchEngine get() = searchEngine(app.preferences.searchEngineId, app.preferences.customSearchUrl)

    /** The page view for a tab, made the first time it is shown and kept while it stays loaded. */
    fun view(tab: BrowserTab): BayEngineView = views.getOrPut(tab.id) {
        BayEngineView(context).apply {
            // Off screen until the page host shows it: a view made active by default takes the window's one compositor
            // when its tab is created, so a tab restored behind a link opened at launch drew over nothing and the link's
            // page stayed blank.
            isActive = false
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
            colorJobs.remove(id)?.cancel()
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
        pageBottomColors.clear()
        failure = null
        mounted = emptyList()
        Engine.setMediaSession(context, null, "", false)
    }

    // Actions

    fun search(inNewTab: Boolean, privately: Boolean = false) {
        // A fresh picture of the page, drawn blurred behind the search sheet.
        if (!inNewTab && hasPage) capture(app.activeTabId)
        searchInNewTab = inNewTab
        searchPrivately = privately
        searchOverPage = null
        overlay = Overlay.SEARCH
    }

    /**
     * The bar's search. Over a page it's for a new tab, so searching never loses the page (a private page's new tab is
     * private too), and the page stays frosted behind; the sheet's first row edits the page's address instead
     * ([editPageAddress]). Over a new tab, it searches in that tab.
     */
    fun searchFromBar() {
        val page = activeTab?.takeIf { hasPage }
        if (page == null) return search(inNewTab = false)
        capture(page.id)
        search(inNewTab = true, privately = page.private)
        searchOverPage = page
    }

    /** The sheet's "this page" row: the search goes back to the page on screen, its address to edit. */
    fun editPageAddress() {
        searchInNewTab = false
        searchOverPage = null
    }

    /** Swiped past the last tab: a new tab, its search up. */
    fun swipedToNewTab() {
        val privately = activeTab?.private == true
        openTab("", privately)
        search(inNewTab = false, privately = privately)
    }

    /**
     * Answers a link from another app or a `bay://` command from a shortcut or the widget (B9, B15), over whatever is
     * up: a page opens in the blank tab showing or a new one; a command opens a fresh tab, a private one, or the search
     * card over the tab showing. False, and nothing changes, for anything else.
     */
    fun openIncoming(value: String): Boolean {
        val command = bayCommand(value)
        // The page a link opens; a command opens none.
        val url = if (command == null) incomingLink(value) ?: return false else ""
        panel = null
        link = null
        overlay = Overlay.NONE
        when (command) {
            BayCommand.SEARCH, BayCommand.VOICE -> {
                // The widget's search is a new search, so it doesn't take the page over: a new tab, as from the bar.
                search(inNewTab = hasPage)
                searchListening = command == BayCommand.VOICE
            }
            BayCommand.NEW_TAB, BayCommand.PRIVATE_TAB -> openTab("", privately = command == BayCommand.PRIVATE_TAB)
            null -> {
                val tab = activeTab
                if (tab != null && tab.url.isEmpty()) navigate(tab.id, url) else openTab(url)
            }
        }
        return true
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
            pickerGone()
        }
        app.dispatch(Action.ActivateTab(id, AppModel.now()))
        overlay = Overlay.NONE
        barGone = 0f
        views[id]?.showBar()
        refreshMounted()
    }

    fun openTab(url: String, privately: Boolean = false, background: Boolean = false) {
        app.dispatch(Action.NewTab(blankTab(app.activeSpaceId, url, privately), background))
        refreshMounted()
    }

    /** Closes a tab into the archive (private tabs are simply gone). A space left without tabs gets a blank one. */
    fun close(id: String) {
        val spaceId = app.allTabs.firstOrNull { it.id == id }?.spaceId ?: app.activeSpaceId
        app.dispatch(Action.CloseTab(id, AppModel.now(), blankTab(spaceId)))
        visited.remove(id)
        refreshMounted()
    }

    /** Closes a tab into the archive, with a toast to bring it straight back. */
    fun archive(id: String) {
        val tab = app.allTabs.firstOrNull { it.id == id }
        close(id)
        if (tab == null || tab.url.isEmpty() || tab.private) return
        showToast(strings.t("toast.tabArchived"), strings.t("toast.undo")) { restore(id) }
    }

    /** Tabs closed for good whose Undo is still up: they leave the archive once it has gone. */
    private val discarding = HashSet<String>()

    /**
     * Closes a tab for good, not into the archive, with a toast to bring it straight back. It goes through the archive
     * for the toast's time, so Undo restores it as archiving's does, and leaves it after.
     */
    fun discard(id: String) {
        val tab = app.allTabs.firstOrNull { it.id == id }
        close(id)
        if (tab == null || tab.url.isEmpty() || tab.private) return
        discarding += id
        showToast(strings.t("toast.tabClosed"), strings.t("toast.undo")) {
            discarding -= id
            restore(id)
        }
        scope.launch {
            delay(DISCARD_UNDO_MS)
            if (discarding.remove(id)) app.dispatch(Action.RemoveArchived(id))
        }
    }

    /** Takes a pin away, with a toast to put it back where it was. */
    fun unpin(site: PinnedSite) {
        val index = app.store.pinnedSites(site.spaceId).indexOfFirst { it.id == site.id }.coerceAtLeast(0)
        app.dispatch(Action.RemovePin(site.id))
        showToast(strings.t("toast.unpinned"), strings.t("toast.undo")) { app.dispatch(Action.AddPin(site, index.toLong())) }
    }

    fun showToast(text: String, actionLabel: String? = null, action: (() -> Unit)? = null) = show(ToastMessage(System.nanoTime(), text, actionLabel, action))

    /** A notice at the top of the screen for a moment; one with an action stays a little longer. */
    fun showTopNote(note: TopNote) {
        topNote = note
        topNoteTimer?.cancel()
        topNoteTimer = scope.launch {
            delay(if (note.action == null) 1_400 else 3_000)
            if (topNote?.id == note.id) topNote = null
        }
    }

    fun dismissTopNote() {
        topNote = null
    }

    /** Switches space and says so at the top: for switching from a page, where nothing else shows which space it is. */
    fun switchSpace(id: String, announce: Boolean = true) {
        if (id == app.activeSpaceId) return
        val space = app.spaces.firstOrNull { it.id == id } ?: return
        selectSpace(id)
        // Not where the screen already shows the space (the bookmarks drawer).
        if (announce) showTopNote(TopNote(System.nanoTime(), spaceName(space, strings), space))
    }

    /** Closes Settings when something opens over the page instead (the drawer); Settings sets it. */
    var leaveSettings: () -> Unit = {}

    /** Slides the bookmarks drawer out over the page, with `folder` open in it, or on the space's archive. */
    fun openDrawer(folder: String? = null, archive: Boolean = false) {
        if (covered) leaveSettings()
        panel = null
        drawerFolder = folder
        drawerArchive = archive
        drawerOpen = true
    }

    fun closeDrawer() {
        drawerOpen = false
    }

    /** A reading tool's notice: what Inspect, Reader or the element picker did, or why it couldn't. */
    fun showNotice(text: String) = show(ToastMessage(System.nanoTime(), text, notice = true))

    private fun show(message: ToastMessage) {
        toast = message
        toastTimer?.cancel()
        toastTimer = scope.launch {
            delay(if (message.notice) 4_000 else if (message.action == null) 2_500 else DISCARD_UNDO_MS)
            if (toast?.id == message.id) toast = null
        }
    }

    fun dismissToast() {
        toast = null
    }

    // The bar

    /** Sliding the bar sideways between tabs. */
    val tabSwipe = TabSwipe(this)

    /** A swipe along the bar carried the page off to the tab beside it. */
    fun swipedTo(id: String) {
        app.dispatch(Action.TipSeen(TipId.BAR))
        capture(app.activeTabId)
        activate(id)
    }

    // Media

    /** The tab whose media the mini player shows: the latest playing one that isn't on screen. */
    val player: Pair<BrowserTab, TabMedia>?
        get() {
            val onScreen = if (overlay == Overlay.NONE && hasPage) app.activeTabId else null
            return latestMedia { it.id != onScreen && !(locked && it.private) && keepsPlayer(it.url) }
        }

    /** Media from this site goes on in the mini player once its tab is left (on unless the site turned it off). */
    private fun keepsPlayer(url: String) = app.preferences.siteSettings[siteHost(url)]?.miniPlayer != false

    /** Media left playing in a tab that's no longer showing, from a site with the mini player off, pauses. */
    fun pauseLeftMedia() {
        val onScreen = if (overlay == Overlay.NONE && hasPage) app.activeTabId else null
        val tabs = app.allTabs
        for ((id, state) in media) {
            if (id == onScreen || !state.report.playing) continue
            val tab = tabs.firstOrNull { it.id == id } ?: continue
            if (!keepsPlayer(tab.url)) stopMedia(id)
        }
    }

    private fun latestMedia(include: (BrowserTab) -> Boolean): Pair<BrowserTab, TabMedia>? {
        val tabs = app.allTabs
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

    /** A card picked in the switcher grows into its page (`TabZoom`). */
    fun pick(tab: BrowserTab, frame: androidx.compose.ui.geometry.Rect) {
        if (zoom != null || zoomLoading != null) return
        zoomLoading = scope.launch {
            // At the page's size, read before it grows, so it never starts as a plain tile.
            preloadFileImage(tab.snapshot, TAB_PICTURE_WIDTH)
            zoom = Zoom(tab, frame)
            zoomLoading = null
        }
    }
    private var zoomLoading: Job? = null

    fun zoomFinished() {
        val current = zoom ?: return
        zoom = null
        activate(current.tab.id)
        if (current.tab.url.isNotEmpty()) tabSwipe.cover(current.tab)
    }

    // Tips

    /**
     * The first-run tip showing, if any, one at a time and never while anything else is up: what blocking did, over the
     * first page that finishes loading with it on, then the bar's swipe once two pages are open.
     */
    val tip: TipId?
        get() {
            if (overlay != Overlay.NONE || panel != null || locked || covered || link != null || find != null) return null
            val seen = app.preferences.tipsSeen
            if (TipId.BLOCKING !in seen && hasPage && !activeNavigation.isLoading && blocking == PageBlocking.ON && app.blockerStatus is BlockerStatus.Ready) {
                return TipId.BLOCKING
            }
            if (TipId.BAR in seen) return null
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
        if (app.preferences.lockPrivateTabs && app.allTabs.any { it.private }) locked = true
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

    /** Where each tab's card sits in the switcher, in the window: the page shrinks into it and grows out of it. */
    val cardFrames = androidx.compose.runtime.mutableStateMapOf<String, androidx.compose.ui.geometry.Rect>()

    /** The page shrinking into its card as the switcher opens, until it lands (`openingDone`). */
    var opening by mutableStateOf<BrowserTab?>(null)
        private set
    private var openingJob: Job? = null

    /**
     * Opens the switcher. From a page, a fresh picture is taken first, if it comes quickly, so the page that shrinks into
     * its card is the page as it is now.
     */
    fun showTabs() {
        val tab = activeTab
        if (!hasPage || tab == null) {
            overlay = Overlay.TABS
            return
        }
        if (openingJob?.isActive == true) return
        openingJob = scope.launch {
            val fresh = captureAsync(tab.id)
            kotlinx.coroutines.withTimeoutOrNull(OPEN_PICTURE_MS) { fresh?.await() }
            val shown = app.tabs.firstOrNull { it.id == tab.id } ?: tab
            preloadFileImage(shown.snapshot, TAB_PICTURE_WIDTH)
            opening = shown
            overlay = Overlay.TABS
        }
    }

    fun openingDone() {
        opening = null
    }

    /** Takes the tab's picture for the switcher now. Private tabs and failed pages keep none. */
    fun capture(tabId: String) {
        captureAsync(tabId)
    }

    /** The tab's picture as it comes in (its file's address), or null when it keeps none. */
    private fun captureAsync(tabId: String): kotlinx.coroutines.Deferred<String?>? {
        val view = views[tabId] ?: return null
        if (tabId in failed || app.tabs.firstOrNull { it.id == tabId }?.private != false) return null
        return scope.async {
            val uri = runCatching { view.snapshot() }.getOrNull() ?: return@async null
            app.dispatch(Action.UpdateTab(tabId, TabUpdate(null, null, null, null, uri)))
            uri
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
            app.allTabs.filter { it.url.isEmpty() && it.spaceId == app.activeSpaceId }.forEach { close(it.id) }
        }
    }

    /** Switches to a space: the tab it was last on (or a fresh one) becomes current. */
    fun selectSpace(id: String) {
        if (id == app.activeSpaceId) return
        val hasTab = app.allTabs.any { it.spaceId == id }
        app.dispatch(Action.SelectSpace(id, if (hasTab) null else blankTab(id)))
        refreshMounted()
    }

    fun createSpace(name: String) {
        val space = app.store.newSpace(UUID.randomUUID().toString(), name)
        app.dispatch(Action.CreateSpace(space, blankTab(space.id)))
        refreshMounted()
    }

    /** A pinned folder in the space showing, named [name]; answers its id. */
    fun newFolder(name: String): String {
        val folder = BrowserFolder(UUID.randomUUID().toString(), app.activeSpaceId, name)
        app.dispatch(Action.NewFolder(folder))
        return folder.id
    }

    fun renameFolder(id: String, name: String) = app.dispatch(Action.RenameFolder(id, name))

    /** Deletes a pinned folder; its pinned rows stay pinned, loose in the space. */
    fun deleteFolder(id: String) = app.dispatch(Action.DeleteFolder(id))

    /** Puts a pinned folder before the folder [beside], or after it when [after]. */
    fun moveFolder(id: String, beside: String, after: Boolean) = app.dispatch(Action.MoveFolder(id, beside, after))

    /**
     * Makes a pin an Essential or a pinned row, in [folderId] or loose, and beside the pin [beside] when it was dropped
     * on one (after it when [after]).
     */
    fun movePin(site: PinnedSite, kind: PinKind, folderId: String?, beside: String? = null, after: Boolean = false) =
        app.dispatch(Action.MovePin(site.id, kind, folderId, beside, after))

    /** Moves a tab to another space, where it becomes that space's newest tab, and says where at the top. */
    fun moveTab(tab: BrowserTab, spaceId: String) {
        if (tab.spaceId == spaceId) return
        val space = app.spaces.firstOrNull { it.id == spaceId } ?: return
        app.dispatch(Action.MoveTab(tab.id, spaceId, null))
        refreshMounted()
        showTopNote(TopNote(System.nanoTime(), strings.t("tabs.movedTo", mapOf("space" to spaceName(space, strings))), space))
    }

    /** A tab card being dragged in the tab view: the space in the bar it's over, which lights up and takes it when let go. */
    var cardDropSpace by mutableStateOf<String?>(null)
        private set

    /** Where each space sits in the tab view's bar, in the window, for a dragged card to find the one it's over. */
    val spaceDropFrames = mutableMapOf<String, androidx.compose.ui.geometry.Rect>()

    /** The space in the bar under [point], a dragged card's place in the window; answers whether that changed. */
    fun cardDragged(point: androidx.compose.ui.geometry.Offset?): Boolean {
        val over = point?.let { at -> spaceDropFrames.entries.firstOrNull { it.value.inflate(16f).contains(at) }?.key }
        if (over == cardDropSpace) return false
        cardDropSpace = over
        return over != null
    }

    /** A space with the next default name ("Space 3"). */
    fun newSpace() = createSpace(strings.t("space.default", mapOf("index" to "${app.spaces.size + 1}")))

    /** The pin sheet for a held tab card. Private and blank tabs have nothing to pin. */
    fun showPinMenu(tab: BrowserTab) {
        if (tab.private || tab.url.isEmpty()) return
        pinTab = tab
        panel = Panel.PIN
    }

    /**
     * Sets how a tab's page is pinned from its sheet, which stays open: null unpins it (with Undo), and a pin already
     * there moves rather than toggling off.
     */
    fun setPin(tab: BrowserTab, kind: PinKind?, folderId: String?) {
        val current = app.pins.firstOrNull { it.url == tab.url }
        when {
            kind == null -> current?.let(::unpin)
            current == null -> app.dispatch(Action.PinSite(tab.id, UUID.randomUUID().toString(), kind, folderId))
            current.kind != kind || current.folderId != folderId -> movePin(current, kind, folderId)
        }
    }

    /** A copy of a tab beside it, in the background. */
    fun duplicate(tab: BrowserTab) {
        if (tab.url.isNotEmpty()) openTab(tab.url, tab.private, background = true)
    }

    /** Answers the page question on show, then shows the next one waiting, if any. */
    /**
     * Answers the page question on show, then shows the next one waiting, if any. `save` files the sign-in typed into the
     * server's HTTP sign-in, never from a private tab.
     */
    fun answerPageRequest(accepted: Boolean, value: String? = null, username: String? = null, password: String? = null, save: Boolean = false) {
        if (pageRequests.isEmpty()) return
        val (tabId, request) = pageRequests.removeAt(0)
        views[tabId]?.answerPageRequest(request.id, accepted, value, username, password)
        if (save && accepted && request.kind == "auth" && username != null && password != null && !isPrivate(tabId)) {
            app.logins.save(request.url, username, password, AppModel.now())
        }
        panel = if (pageRequests.isNotEmpty()) Panel.REQUEST else if (panel == Panel.REQUEST) null else panel
    }

    /**
     * Tabs and sites answered from a saved login whose server hasn't accepted it yet: asking again right after means the
     * saved password is wrong, so that time the sheet asks.
     */
    private val signedInSilently = mutableSetOf<String>()

    /**
     * Answers a sign-in with the login saved for its site; false when there's none, it just failed, or the tab is private
     * (its sign-ins stay in the private session).
     */
    private fun signInSilently(tabId: String, request: PageRequest): Boolean {
        val key = "$tabId ${bay.core.originOf(request.url) ?: request.url}"
        if (signedInSilently.remove(key)) return false
        if (isPrivate(tabId)) return false
        val login = app.logins.find(request.url) ?: return false
        val view = views[tabId] ?: return false
        signedInSilently += key
        // Chromium asks while it's still making the sign-in, and an answer then fails its check
        // (`!creating_login_delegate_`): the answer goes on the next turn of the main loop, as a person's would.
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            view.answerPageRequest(request.id, true, null, login.username, login.password)
        }
        return true
    }

    /** The icon the page names, for its site; the core keeps it when the site has none yet, or only a small one. */
    private fun fetchIcon(view: BayEngineView, pageUrl: String) {
        scope.launch {
            val named = runCatching { org.json.JSONObject(view.runScript(PageScript.FAVICON)) }.getOrNull() ?: return@launch
            app.iconFetcher.pageLoaded(pageUrl, named.optString("href").ifEmpty { null }, named.optString("userAgent").ifEmpty { null })
        }
    }

    private fun isPrivate(tabId: String): Boolean = app.tabs.firstOrNull { it.id == tabId }?.private == true

    /** A pin's page: its tab in the space when one is open there, else a new one. */
    fun openPin(site: PinnedSite) {
        val open = app.allTabs.firstOrNull { it.spaceId == site.spaceId && it.url == site.url }
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

    /** The download toast's item, while it has one. */
    val downloadToast: DownloadItem? get() = downloadToastId?.let { id -> app.downloads.firstOrNull { it.id == id } }

    /** Shows the toast for a download's update; a Wallet-style pass or a calendar invitation opens itself once saved. */
    private fun downloadUpdated(update: DownloadEvent) {
        downloadToastId = update.id
        downloadToastTimer?.cancel()
        // A tab whose first navigation became this download has no page: it goes back to the start page instead of
        // keeping the file's address (and downloading it again when it's restored). The engine doesn't say so itself.
        if (update.state == DownloadEventState.STARTED) {
            navigation.filter { (_, state) -> state.url == update.url && !state.canGoBack }.keys.forEach { tabId ->
                navigation.remove(tabId)
                app.dispatch(Action.UpdateTab(tabId, TabUpdate("", "", null, null, null)))
            }
            refreshMounted()
        }
        if (update.state == DownloadEventState.FINISHED && opensWhenFinished(update.filename)) {
            app.downloads.firstOrNull { it.id == update.id }?.let(::openDownload)
        }
        if (update.state == DownloadEventState.STARTED || update.state == DownloadEventState.PROGRESS) return
        downloadToastTimer = scope.launch {
            delay(DOWNLOAD_TOAST_MS)
            downloadToastId = null
        }
    }

    // Import

    /** Opens pasted links as background tabs, or files them in the archive, and says how many came in. */
    fun importLinks(tabs: List<ImportedTab>, archive: Boolean) {
        val count = app.store.importTabs(tabs, archive, AppModel.now()).toInt()
        panel = null
        if (count == 0) {
            showToast(strings.t("toast.linksAlreadyHere"))
            return
        }
        val key = if (archive) (if (count == 1) "toast.archivedTab" else "toast.archivedTabs") else if (count == 1) "toast.openedTab" else "toast.openedTabs"
        showToast(strings.t(key, mapOf("count" to "$count")))
    }

    /** Adds the chosen parts of an export to the space showing; its bookmarks go in a folder named for the browser. */
    fun importExport(chosen: ChosenExport, choice: ImportChoice, folderName: String): ImportCounts =
        app.store.importExport(chosen.contents, choice, folderName, AppModel.now())

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
            is EngineEvent.PageMessage -> {
                val report = parseMediaMessage(event.message)
                val element = if (report == null && picking != null && tabId == app.activeTabId) parsePickedMessage(event.message) else null
                when {
                    report != null -> mediaReported(tabId, report)
                    element != null -> {
                        picked = element
                        if (picking == PickMode.INSPECT) inspectPicked()
                    }
                }
            }
            is EngineEvent.BarMoved -> if (tabId == app.activeTabId) {
                // Back after a scroll: the page has moved under the bar, so what's along its edges may have changed.
                if (event.hidden == 0f && barGone > 0f) views[tabId]?.let { refreshPageColors(tabId, it) }
                barGone = event.hidden
            }
            is EngineEvent.BlockedCount -> blocked[tabId] = event.count
            is EngineEvent.LinkPress -> if (tabId == app.activeTabId) {
                link = event
                panel = Panel.LINK
            }
            is EngineEvent.Request -> {
                if (event.request.kind == "auth" && signInSilently(tabId, event.request)) return
                pageRequests += tabId to event.request
                panel = Panel.REQUEST
            }
            else -> {}
        }
    }

    private val colorJobs = mutableMapOf<String, Job>()

    /** The colours along a page's top and bottom edges: as it draws them, else as its styles say (before it has drawn). */
    private suspend fun readPageColors(tabId: String, view: BayEngineView) {
        suspend fun read(args: Map<String, Any?>?): List<Double>? {
            val json = runCatching { view.runScript(PageScript.PAGE_COLOR, args) }.getOrNull()
            return json?.let { runCatching { JSONArray(it) }.getOrNull() }?.let { array -> List(array.length()) { array.getDouble(it) } }
        }
        val drawn = runCatching { view.edgeColors() }.getOrNull()
        val top = drawn?.first ?: read(null)
        if (top != null) pageColors[tabId] = top else pageColors.remove(tabId)
        val bottom = drawn?.second ?: read(mapOf("edge" to "bottom"))
        if (bottom != null) pageBottomColors[tabId] = bottom else pageBottomColors.remove(tabId)
    }

    /** Reads a page's edge colours now and again a moment later, once a page that fetches what it shows has drawn it. */
    private fun refreshPageColors(tabId: String, view: BayEngineView) {
        colorJobs[tabId]?.cancel()
        colorJobs[tabId] = scope.launch {
            readPageColors(tabId, view)
            delay(1_500)
            readPageColors(tabId, view)
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
            if (tabId == app.activeTabId) pickerGone()
            failed -= tabId
            if (failure?.tabId == tabId) failure = null
            // A new document has no media until it reports some.
            if (media.remove(tabId) != null) updateMediaSession()
        }
        val view = views[tabId]
        if (finished && tabId == app.activeTabId) openReaderBySite(tabId, state.url)
        // Read when a load finishes, and when a site that runs as an app moves to another page without one (YouTube's
        // Shorts are dark under a white feed).
        val moved = before != null && before.url != state.url && !state.isLoading
        if ((finished || moved) && view != null) {
            refreshPageColors(tabId, view)
            // The site's icon, unless the tab is private: its icon would say what was opened privately.
            if (!isPrivate(tabId)) fetchIcon(view, state.url)
        }
        val rules = app.allTabs.firstOrNull { it.id == tabId }?.let { pageHidden(it, state.url) }.orEmpty()
        val plan = scriptsFor(timing[tabId] ?: initialTiming(), NavigationReport(state.url, state.progress, state.isLoading), rules.isNotEmpty())
        timing[tabId] = plan.timing
        if (plan.hideElements && view != null) hide(rules, view)
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
        val tab = app.allTabs.firstOrNull { it.id == tabId } ?: return
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

    /** The page showing is pinned in its space, either way. */
    val isPinned: Boolean
        get() {
            val url = activeTab?.url
            return app.pins.any { it.url == url }
        }

    val isBookmarked: Boolean
        get() {
            val url = activeTab?.url
            return !url.isNullOrEmpty() && app.store.isBookmarked(app.activeSpaceId, url)
        }

    /**
     * The page menu's Pin: unpins a pinned page; otherwise pins it as an Essential, or, when the space has folders, offers
     * the ways to pin it.
     */
    fun togglePin() {
        val tab = activeTab ?: return
        val pin = app.pins.firstOrNull { it.url == tab.url }
        when {
            pin != null -> unpin(pin)
            app.folders.isNotEmpty() -> showPinMenu(tab)
            else -> {
                app.dispatch(Action.PinSite(tab.id, UUID.randomUUID().toString(), PinKind.ESSENTIAL, null))
                showToast(strings.t("toast.pinned"))
            }
        }
    }

    fun toggleBookmark() {
        val tab = activeTab?.takeIf { it.url.isNotEmpty() } ?: return
        val bookmarked = isBookmarked
        val bookmark = BookmarkNode.Url(UUID.randomUUID().toString(), "bookmarks", tab.title.ifEmpty { tab.url }, tab.url, AppModel.now())
        app.dispatch(Action.ToggleBookmark(app.activeSpaceId, bookmark))
        if (bookmarked) {
            showToast(strings.t("toast.unbookmarked"))
        } else {
            showToast(strings.t("toast.bookmarked"), strings.t("toast.showBookmarks")) { openDrawer() }
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
    /** The page translated into Bay's language. */
    fun translate() = translate(strings.locale)

    /** The page translated into `locale` (one of Bay's: "pt-BR" translates into Portuguese). */
    fun translate(locale: String) {
        val url = activeUrl
        if (url.isEmpty() || Regex("^https://[^/]+\\.translate\\.goog/").containsMatchIn(url)) return
        val language = locale.substringBefore('-').ifEmpty { "en" }
        navigate(app.activeTabId, "https://translate.google.com/translate?sl=auto&tl=$language&u=${Uri.encode(url)}")
    }

    /** The article on the page as Markdown, on the clipboard. */
    // Hide elements and Inspect

    /** The elements hidden on a tab's site: its own list in a private tab, else the site's saved one. */
    fun hiddenSelectors(tab: BrowserTab, url: String = tab.url): List<String> =
        if (tab.private) privateRules[tab.id]?.get(hostOf(url)).orEmpty() else app.store.hiddenSelectors(url)

    /** Everything a page hides: its site's hidden elements, and on YouTube what Settings > YouTube cleans up. */
    private fun pageHidden(tab: BrowserTab, url: String): List<String> = hiddenSelectors(tab, url) + youtubeSelectors(app.preferences.youtube, url)

    private fun applyHiddenToOpenPages() {
        for ((tabId, view) in views) {
            val tab = app.allTabs.firstOrNull { it.id == tabId } ?: continue
            hide(pageHidden(tab, navigation[tabId]?.url?.ifEmpty { null } ?: tab.url), view)
        }
    }

    /** The elements hidden on the page showing. */
    val activeHidden: List<String> get() = activeTab?.let { hiddenSelectors(it, activeUrl) }.orEmpty()

    private fun hide(selectors: List<String>, view: BayEngineView) {
        scope.launch { runCatching { view.runScript(PageScript.HIDE_ELEMENTS, mapOf("selectors" to selectors)) } }
    }

    /** Keeps the site's hidden elements and applies them to the page showing at once. */
    private fun setHidden(selectors: List<String>) {
        val tab = activeTab ?: return
        val host = hostOf(activeUrl)
        if (tab.private) privateRules[tab.id] = privateRules[tab.id].orEmpty() + (host to selectors)
        else app.dispatch(Action.HiddenElements(host, selectors))
        activeView?.let { hide(selectors + youtubeSelectors(app.preferences.youtube, activeUrl), it) }
    }

    /** Starts the element picker: a tap on the page then picks what's under it, and links don't open. */
    fun startPicking(mode: PickMode) {
        val view = activeView ?: return
        scope.launch {
            if (readerTab == app.activeTabId) {
                readerTab = null
                runCatching { view.runScript(PageScript.CLOSE_READER) }
            }
            runCatching { view.runScript(PageScript.START_PICKER) }
            picked = null
            inspected = null
            picking = mode
        }
    }

    fun endPicking() {
        activeView?.let { view -> scope.launch { runCatching { view.runScript(PageScript.STOP_PICKER) } } }
        pickerGone()
    }

    /** The picker's state goes with its page (a new document, another tab), which stops it anyway. */
    private fun pickerGone() {
        picking = null
        picked = null
        inspected = null
        if (panel == Panel.INSPECT) panel = null
    }

    /** Picks the element around the picked one. */
    fun pickParent() {
        val view = activeView ?: return
        scope.launch {
            val moved = runCatching { view.runScript(PageScript.PICK_PARENT) }.getOrNull() == "true"
            if (!moved) showNotice(strings.t("notice.noParent"))
        }
    }

    fun hidePicked() {
        val selector = picked?.selector ?: return
        val rules = activeHidden
        setHidden(if (selector in rules) rules else rules + selector)
        picked = null
    }

    fun undoHide() = setHidden(activeHidden.dropLast(1))

    /** Brings back everything hidden on the site showing. */
    fun showHidden() = setHidden(emptyList())

    /** Reads what the picked element is, for the inspect sheet. */
    fun inspectPicked() {
        val view = activeView ?: return
        scope.launch {
            val json = runCatching { view.runScript(PageScript.INSPECT) }.getOrNull() ?: return@launch
            val element = parseInspectedElement(json) ?: return@launch
            inspected = element
            panel = Panel.INSPECT
        }
    }

    fun copyInspected() {
        val element = inspected ?: return
        copy(element.agent)
        showNotice(strings.t("notice.copiedForAgent"))
    }

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
                showNotice(strings.t("notice.noArticle"))
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
            showNotice(strings.t("notice.markdownCopied"))
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

    /** The font this site shows in, or none for the one set for all websites. */
    fun setSiteFont(font: SiteFont?) = changeSiteSetting { it.copy(font = font) }

    fun changeSiteSetting(change: (SiteSettingInput) -> SiteSettingInput) {
        val host = siteHost(activeUrl)
        if (host.isEmpty()) return
        val setting = siteSetting
        val input = SiteSettingInput(
            textSize = setting.textSize?.toDouble(), reader = setting.reader, desktopMode = setting.desktopMode,
            blockOff = setting.blockOff, swipe = setting.swipe, font = setting.font, fullscreen = setting.fullscreen,
            forceDark = setting.forceDark, miniPlayer = setting.miniPlayer,
        )
        app.dispatch(Action.SiteSettings(host, change(input)))
        preferencesChanged()
    }

    /** A changed preference or site setting reaches the open pages at once. */
    fun preferencesChanged() {
        for ((id, view) in views) {
            val url = pageUrl(id)
            configure(view, url)
            applyTweaks(id, url)
        }
        applyBlockingPauses()
    }

    /** The address a tab's page shows: where it navigated, else the tab's saved one. */
    private fun pageUrl(tabId: String): String = navigation[tabId]?.url ?: app.tabs.firstOrNull { it.id == tabId }?.url.orEmpty()

    /** The page view's settings for the page it shows: its site's desktop mode and swipe, and Bay's own choices. */
    private fun configure(view: BayEngineView, url: String) {
        val preferences = app.preferences
        val setting = if (url.isEmpty()) null else app.store.siteSetting(url)
        view.desktopMode = setting?.desktopMode == true
        view.forceDark = setting?.forceDark == true
        view.swipeMode = (setting?.swipe ?: preferences.swipeToNavigate).name.lowercase()
        view.pullToRefreshEnabled = preferences.pullToRefresh
        view.appLinks = preferences.appLinks.name.lowercase()
        // A fullscreen site has no bar over it.
        view.barHeight = if (setting?.fullscreen == true) 0 else barCover
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
        applyFont(tabId, view, url)
    }

    /** Each bundled font file as base64, read from the APK's assets the first time a page needs it. */
    private val fontFiles = java.util.concurrent.ConcurrentHashMap<String, String>()

    /** Tabs given one of Bay's fonts on their current page, so a change back to the site's own takes it off again. */
    private val fontedTabs = HashSet<String>()

    /** Tabs whose page wouldn't take Bay's font, and shows in the phone's instead; Site settings says so. */
    val fontBlocked = androidx.compose.runtime.mutableStateListOf<String>()

    /** The site's font (else the one for all websites) on the page a tab shows; nothing to do for the site's own. */
    private fun applyFont(tabId: String, view: BayEngineView, url: String) {
        val face = siteFontFace(app.store.siteFont(url))
        if (face.family.isEmpty() && tabId !in fontedTabs) return
        if (face.family.isEmpty()) fontedTabs -= tabId else fontedTabs += tabId
        scope.launch {
            val faces = withContext(Dispatchers.IO) {
                face.files.mapNotNull { file ->
                    val data = fontFiles[file.file] ?: runCatching {
                        Base64.encodeToString(context.assets.open(file.file).use { it.readBytes() }, Base64.NO_WRAP)
                    }.getOrNull()?.also { fontFiles[file.file] = it }
                    data?.let { mapOf("data" to it, "italic" to file.italic, "weight" to file.weight) }
                }
            }
            val result = runCatching { view.runScript(PageScript.PAGE_FONT, mapOf("family" to face.family, "faces" to faces)) }.getOrNull()
            if (result == "\"blocked\"") {
                if (tabId !in fontBlocked) fontBlocked += tabId
            } else if (result != null) {
                fontBlocked -= tabId
            }
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

        /** How long opening the switcher waits for a fresh picture of the page before shrinking the last one. */
        const val OPEN_PICTURE_MS = 400L

        /** Tab pictures are this wide (BaySnapshotWriter.MAX_WIDTH): decoded as they are, wherever they're drawn. */
        const val TAB_PICTURE_WIDTH = 640

        /** A settled download's toast stays this long. */
        private const val DOWNLOAD_TOAST_MS = 6_000L

        /** How long a toast with Undo stays, and so how long a tab closed for good waits in the archive. */
        private const val DISCARD_UNDO_MS = 8_000L

        fun blankTab(spaceId: String, url: String = "", privately: Boolean = false): BrowserTab {
            val now = AppModel.now()
            return BrowserTab(UUID.randomUUID().toString(), url, "", null, now, now, null, privately, spaceId, null)
        }
    }
}
