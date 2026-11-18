package bay.app.browser

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import bay.app.AppModel
import bay.core.Action
import bay.core.BrowserTab
import bay.core.NavigationReport
import bay.core.PinnedSite
import bay.core.ScriptTiming
import bay.core.SearchEngine
import bay.core.TabUpdate
import bay.core.initialTiming
import bay.core.isWebUrl
import bay.core.scriptsFor
import bay.core.searchEngine
import bay.engine.BayEngineView
import bay.engine.EngineEvent
import bay.engine.NavigationState
import bay.engine.PageScript
import bay.engine.runScript
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
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

/** A page that failed to load, while its tab shows. */
data class PageFailure(val tabId: String, val url: String, val message: String)

/**
 * The browser screen's state over the store: which pages are loaded, what each reports, and what is over them. The
 * Expo app's BrowserScreen, without its rendering. Every change to tabs goes through the core's store.
 */
class BrowserModel(private val context: Context, val app: AppModel) {
    var overlay by mutableStateOf(Overlay.NONE)

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
        for (id in mounted) {
            if (id != app.activeTabId && id in existing && next.size < MAX_LIVE) next += id
        }
        views.keys.filter { it !in next }.forEach { id ->
            views.remove(id)?.let { view ->
                view.saveState()
                (view.parent as? android.view.ViewGroup)?.removeView(view)
                view.dispose()
            }
            navigation.remove(id)
            timing.remove(id)
        }
        if (next != mounted) mounted = next
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

    /** Archives every tab in the switcher's grid; the pinned ones stay. */
    fun archiveAll() {
        switcherTabs.forEach { close(it.id) }
        overlay = Overlay.NONE
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
