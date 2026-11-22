package bay.app.browser

import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.layout.height
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.draw.blur
import androidx.compose.ui.graphics.luminance
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.windowInsetsTopHeight
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

/** How small the switcher starts as it comes up behind the shrinking page, and goes as the page grows back. */
private const val SWITCHER_FROM = 0.94f

/** Bay's one screen: the page showing (or the start page), the floating bar, and what opens over them. */
@Composable
fun BrowserScreen(browser: BrowserModel, strings: Strings, onSettings: () -> Unit, onChecks: () -> Unit = {}) {
    val app = browser.app
    LaunchedEffect(app.activeTabId, app.tabs.map { it.url }) { browser.refreshMounted() }
    LaunchedEffect(app.preferences) { browser.preferencesChanged() }
    // A site with the mini player off pauses once its tab is left.
    LaunchedEffect(app.activeTabId, browser.overlay, browser.hasPage) { browser.pauseLeftMedia() }
    FullscreenWindow(browser.fullscreen)
    // While a sheet or Settings is open, the browser behind it steps out of TalkBack's way, as iOS does under its sheets.
    val behind = browser.panel != null || browser.covered
    // The picker's card stays above the sheet it opened (Inspect's details), so it's reachable there.
    val pickerOnTop = browser.picking != null && browser.panel != null
    // Over a page the screen takes its look from the page: the status bar's strip is the colour at its top, and the bar
    // the colour along its foot (behind the bar, where the page leaves room for it), so the bar sits in the page rather
    // than on it. The system's icons stay readable on either.
    val pageShows = browser.hasPage && browser.overlay != Overlay.TABS && !browser.covered
    val topColor = if (pageShows) pageColor(browser.shownColor(browser.pageColors[app.activeTabId])) else null
    val footColor = if (pageShows) pageColor(browser.shownColor(browser.pageBottomColors[app.activeTabId] ?: browser.pageColors[app.activeTabId])) else null
    val systemDark = androidx.compose.foundation.isSystemInDarkTheme()
    SystemBarIcons(lightTop = topColor?.let { it.luminance() > 0.5f } ?: !systemDark, lightBottom = footColor?.let { it.luminance() > 0.5f } ?: !systemDark)
    Box(Modifier.fillMaxSize()) {
        // The bar's column: the player, toasts and the bar, or the picker's card in its place. While the picker has a
        // sheet open (Inspect's details), the card and its notices stay above the sheet, as they did before it opened.
        val bottom: @Composable BoxScope.() -> Unit = {
            // Off a fullscreen site; and, over a page, slid away in step with it as it scrolls down (BrowserModel.barGone).
            // The toast and the player go with it.
            val onPage = browser.overlay == Overlay.NONE
            val away by animateFloatAsState(if (onPage && browser.fullscreen) 1f else 0f, tween(200), label = "bar")
            val barDark = if (onPage && footColor != null) footColor.luminance() <= 0.4f else systemDark
            bay.design.BayTheme(dark = barDark) {
                Column(
                    Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                        .graphicsLayer { translationY = maxOf(away, if (onPage) browser.barGone else 0f) * size.height }
                        .navigationBarsPadding().padding(horizontal = Space.edge).padding(bottom = Space.xs),
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
                    // The picker's card sits over the bar, which stays: Settings and the page menu are still in reach.
                    val picking = browser.picking
                    if (picking != null && browser.hasPage) PickerCard(browser, strings, picking)
                    if (browser.find != null && browser.hasPage) {
                        FindBar(browser, strings)
                    } else {
                        BrowserBar(browser, strings, onSettings, Modifier.fillMaxWidth(), onChecks)
                    }
                }
            }
        }
        Box(Modifier.fillMaxSize().then(if (behind) Modifier.clearAndSetSemantics {} else Modifier)) {
        Wallpaper(app.preferences.wallpaper)
        // The pages stay in place under the switcher, so a page isn't torn down and reloaded on the way back.
        if (browser.hasPage || browser.mounted.isNotEmpty()) {
            val shown = pageShows
            // The page runs under the floating bar to the screen's foot and is never resized as the bar comes and goes:
            // a resize mid-scroll lays the page out again and reallocates its surface, which shook the whole page. The
            // engine takes the bar as the page's bottom toolbar instead, lifting what a site pins to its bottom above it.
            val density = LocalDensity.current
            val barCover = WindowInsets.navigationBars.getBottom(density) + with(density) { (Space.xs + BAR_HEIGHT + Space.sm).roundToPx() }
            LaunchedEffect(barCover) { browser.barCoverChanged(barCover) }
            if (shown) {
                // Behind the page: until it draws its first frame, and in the room it leaves the bar at its foot, the colour
                // along its bottom edge (else the engine's blank white), so the bar sits on the page's own colour.
                Box(Modifier.fillMaxSize().graphicsLayer { translationX = browser.tabSwipe.offset.value }.background(footColor ?: Color.White).clearAndSetSemantics {})
            }
            // A fullscreen site takes the status bar's place too.
            val top = if (browser.fullscreen) Modifier else Modifier.statusBarsPadding()
            // After a switch from a page, the new space's page comes in from the side its space sits on.
            val slide = remember { androidx.compose.animation.core.Animatable(0f) }
            val spaceIndex = app.spaces.indexOfFirst { it.id == app.activeSpaceId }
            var lastSpace by remember { androidx.compose.runtime.mutableIntStateOf(spaceIndex) }
            val pageWidth = with(LocalDensity.current) { androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp.dp.toPx() }
            browser.tabSwipe.width = pageWidth
            LaunchedEffect(spaceIndex) {
                val from = lastSpace
                lastSpace = spaceIndex
                if (from < 0 || spaceIndex < 0 || from == spaceIndex || browser.overlay != Overlay.NONE) return@LaunchedEffect
                slide.snapTo((if (spaceIndex > from) 1 else -1) * pageWidth * 0.5f)
                slide.animateTo(0f, androidx.compose.animation.core.spring(dampingRatio = 0.9f, stiffness = 380f))
            }
            PagesHost(
                browser, shown && !behind,
                Modifier.fillMaxSize().then(top).graphicsLayer {
                    translationX = slide.value + browser.tabSwipe.offset.value
                    alpha = 1f - (kotlin.math.abs(slide.value) / pageWidth).coerceIn(0f, 0.6f)
                },
                visible = shown,
            )
            // The room the page leaves the bar at its foot, which the engine paints white: the colour along the page's
            // bottom edge instead, going with the bar as it slides away.
            if (shown && footColor != null && !browser.siteSetting.fullscreen) {
                Box(
                    Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(with(density) { barCover.toDp() })
                        .graphicsLayer {
                            translationX = browser.tabSwipe.offset.value
                            translationY = browser.barGone * size.height
                        }
                        .background(footColor).clearAndSetSemantics {},
                )
            }
            if (shown) {
                TabSwipeLayer(browser, strings)
                TabCoverLayer(browser)
            }
            // On a fullscreen site, a tap along the bottom edge brings the bar back for a moment.
            if (browser.fullscreen) {
                Box(
                    Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(28.dp).testTag("fullscreen-edge")
                        .pointerInput(Unit) { detectTapGestures { browser.peekBar() } },
                )
            }
            // Under the search sheet the page stays put, frosted: the engine draws on a SurfaceView, which no blur in the
            // app reaches, so its picture is drawn over it, blurred (Android 12 and later; dimmed only before that).
            if (browser.overlay == Overlay.SEARCH && browser.searchKeepsPage) {
                val pixels = with(androidx.compose.ui.platform.LocalDensity.current) { 240.dp.roundToPx() }
                rememberFileImage(browser.activeTab?.snapshot, pixels)?.let { picture ->
                    androidx.compose.foundation.Image(
                        picture, null,
                        Modifier.fillMaxSize().statusBarsPadding().blur(24.dp),
                        contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                    )
                }
            }
        }
        if (browser.overlay == Overlay.TABS) {
            // In from a page, the page shrinks into its card as the switcher comes up behind it; back to a page, the
            // card grows into it as the switcher falls away (TabZoom).
            val opening = browser.opening
            val reveal = remember { androidx.compose.animation.core.Animatable(if (opening != null) 0f else 1f) }
            LaunchedEffect(opening) {
                if (opening == null) return@LaunchedEffect
                reveal.snapTo(0f)
                reveal.animateTo(1f, bay.design.Motion.settle.spec())
                browser.openingDone()
            }
            val leave by animateFloatAsState(if (browser.zoom != null) 1f else 0f, bay.design.Motion.open.spec(), label = "switcher-leave")
            Wallpaper(app.preferences.wallpaper)
            Box(
                Modifier.fillMaxSize().graphicsLayer {
                    val shown = reveal.value * (1 - leave)
                    alpha = shown
                    scaleX = SWITCHER_FROM + (1 - SWITCHER_FROM) * shown
                    scaleY = scaleX
                },
            ) { TabSwitcher(browser, strings, onSettings) }
            opening?.let { TabMorph(browser, it, browser.cardFrames[it.id], 1f - reveal.value) }
        } else if (browser.hasPage) {
            val failure = browser.failure
            if (failure != null && failure.tabId == app.activeTabId) {
                PageError(failure.message, strings, browser::retry, Modifier.statusBarsPadding())
            }
            // The strip behind the status bar, in the colour at the top of the page.
            Box(Modifier.fillMaxWidth().windowInsetsTopHeight(WindowInsets.statusBars).background(topColor ?: Theme.colors.background).clearAndSetSemantics {})
        } else if (browser.overlay == Overlay.NONE) {
            StartScreen(browser, strings)
        }
        val activity = LocalContext.current as? android.app.Activity
        if (browser.locked && browser.activeTab?.private == true && browser.overlay == Overlay.NONE) {
            PrivateLock(strings) { activity?.let(browser::unlock) }
        }
        browser.zoom?.let { zoom -> TabZoom(browser, zoom, browser::zoomFinished) }
        if (browser.overlay != Overlay.SEARCH) {
            if (!pickerOnTop) bottom()
        } else {
            val active = browser.activeTab
            // Search opened over a dark page is dark too, so the sheet doesn't glare over it.
            val overDark = browser.searchKeepsPage && (pageColor(browser.shownColor(browser.pageColors[app.activeTabId]))?.luminance() ?: 1f) <= 0.4f
            bay.design.BayTheme(dark = overDark || systemDark) {
                SearchCard(
                    browser, strings, if (browser.searchInNewTab) "" else active?.url.orEmpty(),
                    browser.searchPrivately || (!browser.searchInNewTab && active?.private == true), browser.searchOverPage,
                )
            }
        }
        androidx.compose.animation.AnimatedVisibility(
            browser.drawerOpen,
            enter = androidx.compose.animation.slideInHorizontally { it } + androidx.compose.animation.fadeIn(),
            exit = androidx.compose.animation.slideOutHorizontally { it } + androidx.compose.animation.fadeOut(),
        ) { BookmarksDrawer(browser, strings) }
        androidx.compose.animation.AnimatedVisibility(
            browser.topNote != null,
            Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = Space.xs),
            enter = androidx.compose.animation.slideInVertically { -it } + androidx.compose.animation.fadeIn(),
            exit = androidx.compose.animation.slideOutVertically { -it } + androidx.compose.animation.fadeOut(),
        ) {
            browser.topNote?.let { TopPill(it, browser::dismissTopNote) }
        }
        }
        SpaceEditPanel(browser, strings, browser.activeSpace, browser.panel == Panel.SPACE_EDIT)
        PageMenu(browser, strings, browser.panel == Panel.PAGE, onSettings)
        SiteSettingsPanel(browser, strings, browser.panel == Panel.SITE_SETTINGS, onSettings)
        LinkMenu(browser, strings, browser.panel == Panel.LINK)
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

/** Hides the status and navigation bars while a site set to Always fullscreen shows; a swipe from the edge brings them. */
@Composable
private fun FullscreenWindow(on: Boolean) {
    val view = androidx.compose.ui.platform.LocalView.current
    DisposableEffect(on) {
        val window = generateSequence(view.context) { (it as? android.content.ContextWrapper)?.baseContext }
            .filterIsInstance<android.app.Activity>().firstOrNull()?.window
        val controller = window?.let { androidx.core.view.WindowCompat.getInsetsController(it, view) }
        val bars = androidx.core.view.WindowInsetsCompat.Type.systemBars()
        if (on) {
            controller?.systemBarsBehavior = androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller?.hide(bars)
        }
        onDispose { if (on) controller?.show(bars) }
    }
}

/** A page colour read from the page ([r, g, b], 0–255), or null when it has none. */
private fun pageColor(rgb: List<Double>?): Color? =
    rgb?.takeIf { it.size >= 3 }?.let { Color(it[0].toFloat() / 255, it[1].toFloat() / 255, it[2].toFloat() / 255) }

/** The status bar's and navigation bar's icons: dark over a light colour behind them, light over a dark one. */
@Composable
private fun SystemBarIcons(lightTop: Boolean, lightBottom: Boolean) {
    val view = androidx.compose.ui.platform.LocalView.current
    androidx.compose.runtime.SideEffect {
        val window = (view.context as? android.app.Activity)?.window ?: return@SideEffect
        androidx.core.view.WindowCompat.getInsetsController(window, view).apply {
            isAppearanceLightStatusBars = lightTop
            isAppearanceLightNavigationBars = lightBottom
        }
    }
}
