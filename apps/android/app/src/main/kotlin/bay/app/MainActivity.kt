package bay.app

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.WindowManager
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalWindowInfo
import bay.app.browser.PrivateCover
import androidx.compose.runtime.DisposableEffect
import androidx.compose.foundation.isSystemInDarkTheme
import bay.app.browser.Overlay
import bay.core.PreferencesUpdate
import bay.app.welcome.FirstRunScreen
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import bay.app.browser.BrowserModel
import bay.app.browser.BrowserScreen
import bay.app.browser.ListPanels
import bay.app.settings.SettingsModel
import bay.app.settings.SettingsScreen
import bay.design.BayTheme
import bay.engine.Engine
import bay.engine.EngineHost
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import bay.core.Pairing
import bay.core.SyncStatus
import kotlinx.coroutines.launch
import androidx.compose.runtime.Composable
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import bay.core.Action
import bay.core.BrowserTab
import bay.core.importedTabs
import bay.core.incomingLink
import java.util.UUID

class MainActivity : ComponentActivity(), EngineHost {
    private lateinit var model: AppModel
    private lateinit var browser: BrowserModel
    private lateinit var settings: SettingsModel
    private var launched = false

    /** A link or `bay://` command that came in, waiting until the browser shows (past the welcome) to open. */
    private var incoming: String? = null

    /** The page's permission request waiting on the system's answer (one at a time, as the system asks). */
    private var permissionsAnswered: (() -> Unit)? = null
    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        permissionsAnswered?.invoke()
        permissionsAnswered = null
    }

    override val currentActivity: Activity get() = this

    override fun hasPermission(permission: String) =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    override fun requestPermissions(permissions: Array<String>, done: () -> Unit) {
        permissionsAnswered?.invoke()
        permissionsAnswered = done
        permissionRequest.launch(permissions)
    }

    @Deprecated("The engine's pickers and voice search still start activities for a result.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        Engine.deliverActivityResult(requestCode, resultCode, data)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Engine.host = this
        enableEdgeToEdge()
        val strings = Strings(applicationContext)
        model = AppModel(applicationContext, strings.t("sync.bar"))
        browser = BrowserModel(this, model, strings)
        settings = SettingsModel(applicationContext, model, browser, strings)
        // Brought back after the system let it go, the activity has its launch intent again: answered the first time.
        if (savedInstanceState == null) receive(intent)
        setContent {
            // The stand-in screens (the engine check, the store check) behind a long press on Settings, for testing.
            var checks by remember { mutableStateOf<String?>(null) }
            // No picture in recents while something private is on screen. Recents shows Bay live at first, with Bay still
            // resumed but no longer focused: the private cover stands in for the screen then.
            val hidden = browser.privateShowing
            LaunchedEffect(hidden) { hideFromRecents(hidden) }
            val focused = LocalWindowInfo.current.isWindowFocused
            BayTheme {
                Box(Modifier.semantics { testTagsAsResourceId = true }) {
                    when (checks) {
                        "store" -> StoreCheck(model, strings, openEngine = { checks = "engine" }, close = { checks = null })
                        "engine" -> EngineCheck(model, close = { checks = "store" })
                        else -> {
                            BrowserScreen(browser, strings, onSettings = settings::open, onChecks = { checks = "store" })
                            if (settings.visible) SettingsScreen(settings)
                            ListPanels(browser, strings)
                            // The first run, until it's done; Settings › General › Show welcome again brings it back.
                            if (!model.preferences.welcomed) {
                                // The browser underneath steps out of TalkBack's way while the welcome is up.
                                DisposableEffect(Unit) {
                                    settings.close()
                                    browser.covered = true
                                    onDispose { browser.covered = settings.visible }
                                }
                                FirstRunScreen(model, strings, isSystemInDarkTheme()) { openField ->
                                    model.dispatch(Action.Preferences(PreferencesUpdate(null, null, null, null, null, null, null, true, null, null, null, null)))
                                    // Skipped early: the plate hands over to the real field.
                                    if (openField) browser.search(inNewTab = false)
                                    openIncoming(welcomed = true)
                                }
                            }
                        }
                    }
                    if (hidden && !focused) PrivateCover()
                }
            }
        }
        window.decorView.announceContentChangesToUiAutomator()
    }

    /**
     * Recents shows Bay blank while something private is on screen, as Chrome's Incognito does. Only the secure flag
     * covers the live screen recents shows on the way in (setRecentsScreenshotEnabled covers just the saved picture), so
     * screenshots are off meanwhile too.
     */
    private fun hideFromRecents(hide: Boolean) {
        if (hide) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    override fun onStart() {
        super.onStart()
        model.startSyncing()
        model.refreshBangs()
        if (launched) cameBack() else launch()
    }

    /**
     * Bay opens ready to type (C1): the search card comes up as it starts, over a fresh start page after a long time
     * away. Not on the run that shows the welcome, which ends on the field itself when it's skipped.
     */
    private fun launch() {
        launched = true
        val opened = model.store.startFresh(AppModel.now(), UUID.randomUUID().toString())
        if (!model.preferences.welcomed || !model.preferences.openSearchOnLaunch) return
        // Over a page, a new search starts a new tab and leaves the page as it was.
        browser.search(inNewTab = !opened && browser.activeTab?.url?.isNotEmpty() == true)
    }

    /** Back in front: a fresh start page after a long time away, ready to type too. */
    private fun cameBack() {
        if (!model.preferences.welcomed || !model.store.startFresh(AppModel.now(), UUID.randomUUID().toString())) return
        browser.overlay = Overlay.NONE
        browser.panel = null
        settings.close()
        if (model.preferences.openSearchOnLaunch) browser.search(inNewTab = false)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        receive(intent)
    }

    override fun onResume() {
        super.onResume()
        openIncoming()
    }

    /**
     * Keeps what an intent brings in (B9): a link or `bay://` command to view, or the first web address in shared
     * text. Opened in [onResume], once a return's fresh start page (in [onStart]) is done, so the link is what shows.
     */
    private fun receive(intent: Intent) {
        // Reopened from recents: the intent is the one that first started Bay, already answered.
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        val value = when (intent.action) {
            Intent.ACTION_VIEW -> intent.dataString
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)?.let { text ->
                if (incomingLink(text) != null) text else importedTabs(text).firstOrNull()?.url
            }
            else -> null
        }
        if (value != null) incoming = value
    }

    /** Opens the waiting link or command over whatever is up; while the welcome shows, it keeps waiting. */
    private fun openIncoming(welcomed: Boolean = model.preferences.welcomed) {
        val value = incoming ?: return
        if (!welcomed) return
        incoming = null
        if (browser.openIncoming(value)) settings.close()
    }

    override fun onStop() {
        super.onStop()
        browser.appLeft()
        model.stopSyncing()
        model.dispatch(Action.Left(AppModel.now()))
        model.flush()
    }
}

/**
 * The stand-in screen behind Settings until it lands (plan N5): the space's tabs from the core's store, a button that
 * adds one, sync, the link resolver and the engine check, to prove each works end to end.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun StoreCheck(model: AppModel, strings: Strings, openEngine: () -> Unit, close: () -> Unit) {
    BackHandler(onBack = close)
    Column(
        modifier = Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp).semantics { testTagsAsResourceId = true },
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        BasicText("Bay", style = TextStyle(fontSize = 34.sp, fontWeight = FontWeight.SemiBold))
        val count = model.tabs.size
        BasicText(
            if (count == 1) strings.t("tabs.one") else strings.t("tabs.count", mapOf("count" to "$count")),
            modifier = Modifier.testTag("tab-count"),
        )
        model.tabs.forEach { tab ->
            BasicText(
                tab.url.ifEmpty { "—" },
                style = TextStyle(fontSize = 13.sp, color = if (tab.id == model.activeTabId) Color.Black else Color.Gray),
            )
        }
        BasicText(
            strings.t("tabs.newTab"),
            modifier = Modifier.testTag("new-tab").clickable {
                val now = AppModel.now()
                val tab = BrowserTab(
                    id = UUID.randomUUID().toString(),
                    url = "https://example.com/$count",
                    title = "",
                    favicon = null,
                    createdAt = now,
                    lastVisit = now,
                    snapshot = null,
                    private = false,
                    spaceId = model.activeSpaceId,
                    folderId = null,
                )
                model.dispatch(Action.NewTab(tab, false))
            },
            style = TextStyle(fontSize = 17.sp, color = Color(0xFF3478F6)),
        )
        SyncCheck(model)
        BasicText(
            "Resolve https://www.github.com",
            modifier = Modifier.testTag("resolve-link").clickable { model.resolve("https://www.github.com") },
            style = TextStyle(fontSize = 17.sp, color = Color(0xFF3478F6)),
        )
        model.resolved?.let { BasicText(it, modifier = Modifier.testTag("resolved-link"), style = TextStyle(fontSize = 13.sp)) }
        BasicText(
            "Engine check",
            modifier = Modifier.testTag("engine-check").clickable(onClick = openEngine),
            style = TextStyle(fontSize = 17.sp, color = Color(0xFF3478F6)),
        )
        BasicText(
            "Core ${bay.core.version()} · ${strings.locale}",
            modifier = Modifier.testTag("core-version"),
            style = TextStyle(fontSize = 13.sp),
        )
    }
}

/**
 * A stand-in for Settings › Sync until it lands (plan N5): the status, the devices, pairing by code and joining by the
 * recovery phrase, to prove sync works end to end against the relay.
 */
@Composable
private fun SyncCheck(model: AppModel) {
    val view = model.syncView
    var phrase by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val link = TextStyle(fontSize = 17.sp, color = Color(0xFF3478F6))
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        BasicText("Sync: ${view.status}", modifier = Modifier.testTag("sync-status"))
        view.devices.forEach { device -> BasicText(device.name + if (device.current) " (this phone)" else "", style = TextStyle(fontSize = 13.sp)) }
        (view.pairing as? Pairing.Waiting)?.let { waiting ->
            BasicText(waiting.code, modifier = Modifier.testTag("sync-code"), style = TextStyle(fontSize = 22.sp))
            BasicText(waiting.digits, modifier = Modifier.testTag("sync-digits"))
        }
        if (view.status == SyncStatus.OFF) {
            BasicText("Pair with a computer", modifier = Modifier.testTag("sync-pair").clickable { model.pair() }, style = link)
            BasicTextField(
                value = phrase,
                onValueChange = { phrase = it },
                modifier = Modifier.fillMaxWidth().border(1.dp, Color.Gray).padding(8.dp).testTag("sync-phrase"),
            )
            BasicText("Join", modifier = Modifier.testTag("sync-join").clickable { scope.launch { problem = model.join(phrase) } }, style = link)
            problem?.let { BasicText(it, style = TextStyle(fontSize = 13.sp, color = Color.Red)) }
        } else {
            BasicText("Sync now", modifier = Modifier.testTag("sync-now").clickable { model.syncNow() }, style = link)
            BasicText("Leave", modifier = Modifier.testTag("sync-leave").clickable { model.leave() }, style = link)
        }
    }
}
