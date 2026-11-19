package bay.app.browser

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import bay.app.Strings
import bay.core.TipId
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.Haptics
import bay.design.IconSize
import bay.design.Space
import bay.design.TextTone
import bay.design.TextVariant
import bay.design.Theme
import bay.design.overWallpaper

private val BAR_HEIGHT = 52.dp

/** Bay's one screen: the page showing (or the start page), the floating bar, and what opens over them. */
@Composable
fun BrowserScreen(browser: BrowserModel, strings: Strings, onSettings: () -> Unit, onChecks: () -> Unit = {}) {
    val app = browser.app
    LaunchedEffect(app.activeTabId, app.tabs.map { it.url }) { browser.refreshMounted() }
    LaunchedEffect(app.preferences) { browser.preferencesChanged() }
    // While a sheet or Settings is open, the browser behind it steps out of TalkBack's way, as iOS does under its sheets.
    val behind = browser.panel != null || browser.covered
    // The picker's card stays above the sheet it opened (Inspect's details), so it's reachable there.
    val pickerOnTop = browser.picking != null && browser.panel != null
    Box(Modifier.fillMaxSize()) {
        // The bar's column: the player, toasts and the bar, or the picker's card in its place. While the picker has a
        // sheet open (Inspect's details), the card and its notices stay above the sheet, as they did before it opened.
        val bottom: @Composable BoxScope.() -> Unit = {
            // Scrolled away while the page scrolls down; the toast and the player go with it.
            val away by animateFloatAsState(if (browser.barHidden && browser.overlay == Overlay.NONE) 1f else 0f, tween(200), label = "bar")
            Column(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().navigationBarsPadding().padding(horizontal = Space.edge).padding(bottom = Space.xs)
                    .graphicsLayer { translationY = away * 140.dp.toPx() },
                verticalArrangement = Arrangement.spacedBy(Space.md),
            ) {
                browser.player?.let { (tab, media) -> MiniPlayer(browser, strings, tab, media) }
                browser.downloadToast?.let { item -> DownloadToast(browser, strings, item) }
                // Under Settings the toast shows on Settings instead (SettingsScreen).
                if (!browser.covered) browser.toast?.let { toast -> Toast(toast, browser::dismissToast) }
                val tip = browser.tip
                if (tip != null) {
                    val key = if (tip == TipId.BLOCKING) "tip.blocking" else "tip.bar"
                    TipCard(strings.t("$key.title"), strings.t("$key.body"), strings.t("tip.gotIt")) { app.dispatch(bay.core.Action.TipSeen(tip)) }
                    // An unanswered tip goes after a while; it has been seen.
                    LaunchedEffect(tip) {
                        kotlinx.coroutines.delay(12_000)
                        app.dispatch(bay.core.Action.TipSeen(tip))
                    }
                }
                val picking = browser.picking
                if (picking != null && browser.hasPage) {
                    PickerCard(browser, strings, picking)
                } else if (browser.find != null && browser.hasPage) {
                    FindBar(browser, strings)
                } else {
                    Box(contentAlignment = Alignment.Center) {
                        BrowserBar(browser, strings, onSettings, Modifier.fillMaxWidth(), onChecks)
                        // The ring round the capsule the tip means.
                        if (tip == TipId.BAR) Box(Modifier.size(184.dp, 62.dp).border(2.5.dp, Theme.colors.accent, RoundedCornerShape(31.dp)).clearAndSetSemantics {})
                    }
                }
            }
        }
        Box(Modifier.fillMaxSize().then(if (behind) Modifier.clearAndSetSemantics {} else Modifier)) {
        Wallpaper(app.preferences.wallpaper)
        // The pages stay in place under the switcher, so a page isn't torn down and reloaded on the way back.
        if (browser.hasPage || browser.mounted.isNotEmpty()) {
            val shown = browser.hasPage && browser.overlay != Overlay.TABS && !browser.covered
            // The engine has no inset for what covers a page, so the page ends above the floating bar (what a site pins
            // to its bottom stays clear of it), over the page's own colour. Nothing is covered while the bar is away.
            val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
            val covered = if (browser.barHidden && browser.overlay == Overlay.NONE) 0.dp else maxOf(navBottom, Space.md) + Space.xs + BAR_HEIGHT + Space.sm
            if (shown) {
                val rgb = browser.pageColors[app.activeTabId]
                val behind = rgb?.let { Color(it[0].toFloat() / 255, it[1].toFloat() / 255, it[2].toFloat() / 255) } ?: Theme.colors.background
                Box(Modifier.fillMaxSize().background(behind).clearAndSetSemantics {})
            }
            PagesHost(browser, shown && !behind, Modifier.fillMaxSize().statusBarsPadding().padding(bottom = covered), visible = shown)
        }
        if (browser.overlay == Overlay.TABS) {
            Wallpaper(app.preferences.wallpaper)
            TabSwitcher(browser, strings, onSettings)
        } else if (browser.hasPage) {
            val failure = browser.failure
            if (failure != null && failure.tabId == app.activeTabId) {
                PageError(failure.message, strings, browser::retry, Modifier.statusBarsPadding())
            }
            // The strip behind the status bar, in the colour at the top of the page.
            val rgb = browser.pageColors[app.activeTabId]
            val strip = rgb?.let { Color(it[0].toFloat() / 255, it[1].toFloat() / 255, it[2].toFloat() / 255) } ?: Theme.colors.background
            Box(Modifier.fillMaxWidth().windowInsetsTopHeight(WindowInsets.statusBars).background(strip).clearAndSetSemantics {})
        } else if (browser.overlay == Overlay.NONE) {
            StartScreen(browser, strings)
        }
        val activity = LocalContext.current as? android.app.Activity
        if (browser.locked && browser.activeTab?.private == true && browser.overlay == Overlay.NONE) {
            PrivateLock(strings) { activity?.let(browser::unlock) }
        }
        browser.zoom?.let { zoom -> TabZoom(zoom, browser::zoomFinished) }
        if (browser.overlay != Overlay.SEARCH) {
            if (!pickerOnTop) bottom()
        } else {
            val active = browser.activeTab
            SearchCard(browser, strings, if (browser.searchInNewTab) "" else active?.url.orEmpty(), browser.searchPrivately || (!browser.searchInNewTab && active?.private == true))
        }
        }
        SpaceEditPanel(browser, strings, browser.activeSpace, browser.panel == Panel.SPACE_EDIT)
        PageMenu(browser, strings, browser.panel == Panel.PAGE, onSettings)
        SiteSettingsPanel(browser, strings, browser.panel == Panel.SITE_SETTINGS, onSettings)
        LinkMenu(browser, strings, browser.panel == Panel.LINK)
        TabsMenu(browser, strings, browser.panel == Panel.TABS)
        PinPanel(browser, strings, browser.panel == Panel.PIN)
        PageRequestPanel(browser, strings, browser.panel == Panel.REQUEST)
        ReaderPanel(browser, strings, browser.panel == Panel.READER)
        InspectPanel(browser, strings, browser.panel == Panel.INSPECT)
        if (pickerOnTop && browser.overlay != Overlay.SEARCH) bottom()
    }
}

/** The start page: the whole screen opens search, with the pins and recent pages beside it. */
@Composable
private fun StartScreen(browser: BrowserModel, strings: Strings) {
    val view = LocalView.current
    Box(
        Modifier.fillMaxSize()
            .testTag("start-screen")
            .semantics { contentDescription = strings.t("start.tapToSearch"); role = Role.Button }
            .clickable(remember { MutableInteractionSource() }, null) { browser.search(inNewTab = false) },
    )
    Column(
        Modifier.fillMaxSize().navigationBarsPadding().padding(bottom = BAR_HEIGHT + Space.xxl),
        verticalArrangement = Arrangement.spacedBy(Space.xl, Alignment.Bottom),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        StartPage(browser.app, strings, onOpen = { browser.open(OpenTarget.Url(it), privately = false) }, onUnpin = { site ->
            Haptics.tick(view)
            browser.unpin(site)
        })
        Column(Modifier.clearAndSetSemantics {}, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            BayText(strings.t("start.tapToSearch"), variant = TextVariant.SUBHEAD, weight = FontWeight.Medium, color = Theme.colors.overWallpaper)
            BayIconView(BayIcon.DOWN, size = IconSize.small, color = Theme.colors.muted)
        }
    }
}
