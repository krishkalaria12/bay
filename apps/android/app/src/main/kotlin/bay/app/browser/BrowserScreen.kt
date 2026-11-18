package bay.app.browser

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
import bay.core.Action
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.Haptics
import bay.design.IconSize
import bay.design.Space
import bay.design.TextTone
import bay.design.TextVariant
import bay.design.Theme

private val BAR_HEIGHT = 52.dp

/** Bay's one screen: the page showing (or the start page), the floating bar, and what opens over them. */
@Composable
fun BrowserScreen(browser: BrowserModel, strings: Strings, onSettings: () -> Unit) {
    val app = browser.app
    LaunchedEffect(app.activeTabId, app.tabs.map { it.url }) { browser.refreshMounted() }
    Box(Modifier.fillMaxSize()) {
        Wallpaper(app.preferences.wallpaper)
        if (browser.hasPage) {
            PagesHost(browser, Modifier.fillMaxSize().statusBarsPadding())
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
        if (browser.overlay != Overlay.SEARCH) {
            BrowserBar(
                browser,
                strings,
                onSettings,
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().navigationBarsPadding().padding(horizontal = Space.edge).padding(bottom = Space.xs),
            )
        } else {
            val active = browser.activeTab
            SearchCard(browser, strings, if (browser.searchInNewTab) "" else active?.url.orEmpty(), browser.searchPrivately || active?.private == true)
        }
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
            browser.app.dispatch(Action.RemovePin(site.id))
        })
        Column(Modifier.clearAndSetSemantics {}, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            BayText(strings.t("start.tapToSearch"), variant = TextVariant.SUBHEAD, weight = FontWeight.Medium, tone = TextTone.MUTED)
            BayIconView(BayIcon.DOWN, size = IconSize.small, color = Theme.colors.muted)
        }
    }
}
