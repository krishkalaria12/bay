package bay.app.settings

import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import bay.app.AppModel
import bay.app.Strings
import bay.app.browser.BrowserModel
import bay.core.Action
import bay.core.ClearStage
import bay.core.DefaultBrowser
import bay.core.EngineChoice
import bay.core.IndexCounts
import bay.core.IndexEntry
import bay.core.LanguageState
import bay.core.SettingsAction
import bay.core.SettingsContext
import bay.core.SettingsMatch
import bay.core.SettingsPage
import bay.core.SettingsPlatform
import bay.core.builtInEngines
import bay.core.cleanUrl
import bay.core.settingsPath
import bay.engine.Engine
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** A page's name as the Expo app's ids have it: SYNC_JOIN is "syncJoin". */
val SettingsPage.id: String
    get() = name.lowercase().split('_').mapIndexed { index, part -> if (index == 0) part else part.replaceFirstChar(Char::uppercase) }.joinToString("")

/**
 * Settings' state: the pages open over its index, how far clearing browsing data has got, and what the core needs to
 * write the pages (`context`). The core writes every page; this runs what its rows ask for (`perform`).
 */
class SettingsModel(private val appContext: Context, val app: AppModel, val browser: BrowserModel, val strings: Strings) {
    var visible by mutableStateOf(false)
        private set

    /** The pages over the index, the one in front last. */
    val stack = mutableStateListOf<SettingsPage>()
    var clearStage by mutableStateOf(ClearStage.IDLE)
        private set

    /** The row a search opened a page at, lit for a moment. */
    var focus by mutableStateOf<String?>(null)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    fun open() {
        stack.clear()
        clearStage = ClearStage.IDLE
        visible = true
        browser.covered = true
    }

    fun close() {
        visible = false
        browser.covered = false
    }

    fun push(pages: List<SettingsPage>) {
        stack.addAll(pages)
    }

    /** ‹: back a page, or closes Settings from its index. */
    fun back() {
        if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex) else close()
    }

    val context: SettingsContext
        get() {
            val prefs = app.preferences
            val version = runCatching { appContext.packageManager.getPackageInfo(appContext.packageName, 0).versionName }.getOrNull().orEmpty()
            return SettingsContext(
                strings.locale,
                SettingsPlatform.ANDROID,
                version,
                prefs,
                builtInEngines().map { EngineChoice(it.id, it.name) },
                "",
                strings.t("settings.wallpapers.${prefs.wallpaper.name.lowercase()}"),
                null,
                LanguageState(strings.saved, strings.locale, strings.device),
                DefaultBrowser.UNKNOWN,
                app.store.tabs().size.toUInt(),
                null,
                clearStage,
                app.syncView,
                AppModel.now(),
            )
        }

    val counts: IndexCounts
        get() {
            val history = app.store.history(app.activeSpaceId, "", 0u, 10_000u).size
            return IndexCounts(0u, history.toUInt(), app.downloads.size.toUInt(), 0u)
        }

    /** Opens an index entry: a page (or the page a search found a row on), or one of the browser's own sheets. */
    fun open(entry: IndexEntry, match: SettingsMatch? = null) {
        when (entry) {
            is IndexEntry.Page -> {
                focus = match?.row
                push(match?.page?.let { settingsPath(it) } ?: listOf(entry.page))
            }
            // The browser's sheets (bookmarks, history, downloads, import) come with the panels.
            is IndexEntry.Action -> {}
        }
    }

    /** Does what a row asks. */
    fun perform(action: SettingsAction) {
        when (action) {
            is SettingsAction.Change -> app.dispatch(Action.Preferences(action.update))
            is SettingsAction.ChooseEngine -> app.dispatch(Action.SearchEngine(action.id, null))
            is SettingsAction.SetArchiveAfterDays -> app.dispatch(Action.ArchiveDays(action.days))
            is SettingsAction.SetBlockContent -> app.dispatch(Action.BlockContent(action.on))
            is SettingsAction.ResumeBlocking -> app.dispatch(Action.PauseBlocking(action.host, false))
            is SettingsAction.SetLockPrivateTabs -> app.dispatch(Action.LockPrivateTabs(action.on))
            is SettingsAction.SetLanguage -> strings.choose(action.locale)
            SettingsAction.MakeDefault -> appContext.startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            SettingsAction.ExportTabs -> exportTabs()
            is SettingsAction.ForgetLogin -> {}
            SettingsAction.AskToClear -> clearStage = ClearStage.CONFIRMING
            SettingsAction.KeepData -> clearStage = ClearStage.IDLE
            SettingsAction.ConfirmClear -> clear()
            SettingsAction.ShowWelcome -> app.dispatch(Action.WelcomeAgain)
            is SettingsAction.OpenLink -> openLink(action.url)
            is SettingsAction.OpenSyncedTab -> openLink(action.url)
            SettingsAction.SyncNow -> app.syncNow()
            is SettingsAction.SetSyncType -> app.sync.setType(action.kind, action.on)
            SettingsAction.LeaveSync -> app.leave()
        }
    }

    private fun openLink(url: String) {
        close()
        browser.openTab(url)
    }

    /**
     * Clears browsing data: every page view goes first (a page still open could write fresh data), the store starts
     * afresh, then the engine clears what pages kept in every space. Settings closes over the empty start page.
     */
    private fun clear() {
        if (clearStage == ClearStage.BUSY) return
        clearStage = ClearStage.BUSY
        val profiles = app.store.spaces().map { it.id }
        browser.closeAllPages()
        app.store.reset(UUID.randomUUID().toString(), AppModel.now())
        scope.launch {
            clearStage = runCatching { Engine.clearData(appContext, profiles) }.fold({ ClearStage.IDLE }, { ClearStage.FAILED })
            if (clearStage == ClearStage.IDLE) close()
        }
    }

    /** The open tabs' addresses, one a line, without their tracking parameters; private tabs stay out. */
    private fun exportTabs() {
        val urls = app.store.tabs().filter { it.url.isNotEmpty() && !it.private }.map { cleanUrl(it.url) }
        if (urls.isEmpty()) return
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, urls.joinToString("\n"))
        appContext.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
