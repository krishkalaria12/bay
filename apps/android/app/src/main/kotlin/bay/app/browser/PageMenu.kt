package bay.app.browser

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import bay.app.Strings
import bay.design.ActionRow
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.IconSize
import bay.design.PanelSheet
import bay.design.Radius
import bay.design.RowDivider
import bay.design.RowGroup
import bay.design.SheetIconButton
import bay.design.Space
import bay.design.TextTone
import bay.design.TextVariant
import bay.design.Theme
import bay.design.baySurface
import bay.design.pressFeedback
import bay.design.style

private val CAPSULE_HEIGHT = 47.dp
private val TILES_GAP = 17.dp
private val TILE_SPACING = 16.dp
private val TILE_HEIGHT = 64.dp
private val TILE_RADIUS = 22.dp
private val ROW_HEIGHT = 48.dp
private const val ZOOM_MIN = 80
private const val ZOOM_MAX = 200

/**
 * What to do with the page showing (bar-more): where to go, the four things done most, display options, this site, the
 * page's tools one step away, and what blocking did on it.
 */
@Composable
fun PageMenu(browser: BrowserModel, strings: Strings, visible: Boolean, onSettings: () -> Unit) {
    // Rarely used page tools sit one step away, and the display options open in place, so the menu fits.
    var tools by remember { mutableStateOf(false) }
    var display by remember { mutableStateOf(false) }
    LaunchedEffect(visible) {
        if (visible) {
            tools = false
            display = false
        }
    }
    val close = { browser.panel = null }
    // Closes the menu, then does what was picked.
    fun act(action: () -> Unit): () -> Unit = {
        close()
        action()
    }
    if (tools) {
        val title = strings.t("pageMenu.toolsTitle")
        PanelSheet(visible, title, "page-menu", strings.sheetWords(title), onClose = close, onBack = { tools = false }, maxFraction = 0.8f) {
            ToolsRows(browser, strings, ::act)
        }
        return
    }
    val title = strings.t("pageMenu.title")
    val blocking = browser.blocking
    PanelSheet(
        visible,
        title,
        "page-menu",
        strings.sheetWords(title),
        onClose = close,
        maxFraction = 0.88f,
        header = { SiteHeader(browser, strings, blocking) },
        accessory = {
            SheetIconButton(BayIcon.SETTINGS, strings.t("pageMenu.settings"), Modifier.testTag("page-settings"), muted = false, onClick = act(onSettings))
        },
    ) {
        val navigation = browser.activeNavigation
        // The address capsule's controls: where to go, and a fresh tab.
        Row(Modifier.padding(top = Space.xs).fillMaxWidth().background(Theme.colors.fill, CircleShape).padding(horizontal = Space.xs)) {
            NavigationAction("page-back", BayIcon.BACK, strings.t("pageMenu.back"), navigation.canGoBack, act(browser::goBack))
            NavigationAction("page-forward", BayIcon.FORWARD, strings.t("pageMenu.forward"), navigation.canGoForward, act(browser::goForward))
            if (navigation.isLoading) {
                NavigationAction("page-stop", BayIcon.CLOSE, strings.t("pageMenu.stop"), true, act(browser::stop))
            } else {
                NavigationAction("page-reload", BayIcon.RELOAD, strings.t("pageMenu.reload"), true, act(browser::reload))
            }
            NavigationAction("page-new-tab", BayIcon.ADD, strings.t("pageMenu.newTab"), true, act { browser.search(inNewTab = true) })
        }
        Row(Modifier.padding(top = TILES_GAP), horizontalArrangement = Arrangement.spacedBy(TILE_SPACING)) {
            Tile("page-find", BayIcon.FIND, strings.t("pageMenu.find"), onClick = act(browser::startFind))
            val reading = browser.readerTab == browser.app.activeTabId
            Tile("page-reader", BayIcon.READER, strings.t("pageMenu.reader"), strings.t("pageMenu.reader"), reading) { browser.openReader() }
            val bookmarked = browser.isBookmarked
            Tile(
                "page-bookmark",
                if (bookmarked) BayIcon.BOOKMARKED else BayIcon.BOOKMARK,
                strings.t("pageMenu.bookmark"),
                if (bookmarked) strings.t("pageMenu.removeBookmark") else strings.t("pageMenu.bookmark"),
                bookmarked,
                act(browser::toggleBookmark),
            )
            Tile("page-share", BayIcon.SHARE, strings.t("pageMenu.share"), onClick = act(browser::share))
        }
        val zoom = browser.pageZoom
        RowGroup(modifier = Modifier.padding(top = Space.lg)) {
            ActionRow(
                strings.t("pageMenu.displayOptions"),
                "page-display-options",
                icon = BayIcon.TEXT_SIZE,
                value = if (zoom == 100) null else "$zoom%",
                chevron = !display,
            ) { display = !display }
            if (display) {
                RowDivider()
                ActionRow(strings.t("pageMenu.translate"), "page-translate", icon = BayIcon.TRANSLATE, onClick = act(browser::translate))
                RowDivider()
                ZoomRow(strings, zoom, browser::setZoom)
                RowDivider()
                val desktop = browser.siteSetting.desktopMode
                ActionRow(strings.t("site.desktop"), "page-desktop", icon = BayIcon.DESKTOP, toggle = desktop) { browser.setDesktop(!desktop) }
            }
            RowDivider()
            ActionRow(strings.t("pageMenu.siteSettings"), "page-site-settings", icon = BayIcon.TUNE, chevron = true) { browser.panel = Panel.SITE_SETTINGS }
            RowDivider()
            ActionRow(strings.t("pageMenu.tools"), "page-more-tools", icon = BayIcon.MORE, chevron = true) { tools = true }
        }
        if (blocking != PageBlocking.OFF) BlockingCard(browser, strings, blocking, act(browser::restoreOriginal))
    }
}

@Composable
private fun ToolsRows(browser: BrowserModel, strings: Strings, act: (() -> Unit) -> () -> Unit) {
    val pinned = browser.isPinned
    Column(verticalArrangement = Arrangement.spacedBy(Space.lg)) {
        RowGroup {
            ActionRow(
                if (pinned) strings.t("pageMenu.unpin") else strings.t("pageMenu.pinToStart"),
                "page-pin",
                icon = if (pinned) BayIcon.UNPIN else BayIcon.PIN,
                onClick = act(browser::togglePin),
            )
            RowDivider()
            ActionRow(strings.t("pageMenu.copyLink"), "page-copy", icon = BayIcon.LINK, onClick = act(browser::copyLink))
            RowDivider()
            ActionRow(strings.t("pageMenu.privateTab"), "page-new-private", icon = BayIcon.PRIVATE, onClick = act { browser.search(inNewTab = true, privately = true) })
            RowDivider()
            // Hiding elements and inspecting come with the element picker.
            ActionRow(strings.t("pageMenu.hideElements"), "page-hide-elements", icon = BayIcon.HIDE, detail = strings.t("pageMenu.hideElements.detail"), onClick = act {})
            RowDivider()
            ActionRow(strings.t("pageMenu.inspect"), "page-inspect", icon = BayIcon.INSPECT, detail = strings.t("pageMenu.inspect.detail"), onClick = act {})
            RowDivider()
            ActionRow(
                strings.t("pageMenu.markdown"),
                "page-markdown",
                icon = BayIcon.MARKDOWN,
                detail = strings.t("pageMenu.markdown.detail"),
                onClick = act(browser::copyMarkdown),
            )
        }
        RowGroup {
            ActionRow(strings.t("pageMenu.history"), "page-history", icon = BayIcon.HISTORY, chevron = true) { browser.panel = Panel.HISTORY }
            RowDivider()
            ActionRow(strings.t("pageMenu.downloads"), "page-downloads", icon = BayIcon.DOWNLOAD, chevron = true) { browser.panel = Panel.DOWNLOADS }
            RowDivider()
            ActionRow(strings.t("pageMenu.archiveTab"), "page-close-tab", icon = BayIcon.ARCHIVE, onClick = act { browser.archive(browser.app.activeTabId) })
        }
    }
}

/** A round icon button for the navigation row: the icons say enough on their own. */
@Composable
private fun RowScope.NavigationAction(id: String, icon: BayIcon, label: String, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.weight(1f).height(CAPSULE_HEIGHT).alpha(if (enabled) 1f else 0.35f).testTag(id)
            .semantics { contentDescription = label }
            .pressFeedback(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { BayIconView(icon, size = IconSize.control) }
}

/** A square with an icon and its label under it, four to a row. */
@Composable
private fun RowScope.Tile(id: String, icon: BayIcon, label: String, description: String = label, active: Boolean = false, onClick: () -> Unit) {
    val colors = Theme.colors
    Column(
        Modifier.weight(1f).testTag(id)
            .pressFeedback(onClick = onClick)
            .clearAndSetSemantics {
                contentDescription = description
                if (active) selected = true
            },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        Box(
            Modifier.fillMaxWidth().height(TILE_HEIGHT).background(if (active) colors.accent.copy(alpha = 0.15f) else colors.fill, RoundedCornerShape(TILE_RADIUS)),
            contentAlignment = Alignment.Center,
        ) { BayIconView(icon, size = IconSize.control + 2.dp, color = if (active) colors.accent else colors.foreground) }
        BayText(label, variant = TextVariant.CAPTION, tone = if (active) TextTone.ACCENT else TextTone.DEFAULT, maxLines = 1)
    }
}

/** Page zoom, a tenth at a time, kept for this site. */
@Composable
private fun ZoomRow(strings: Strings, zoom: Int, onZoom: (Int) -> Unit) {
    fun step(up: Boolean) {
        val next = Math.round(zoom / 10.0).toInt() * 10 + if (up) 10 else -10
        onZoom(next.coerceIn(ZOOM_MIN, ZOOM_MAX))
    }
    Row(
        Modifier.fillMaxWidth().heightIn(min = ROW_HEIGHT + 4.dp).padding(start = Space.lg, end = Space.sm),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BayIconView(BayIcon.TEXT_SIZE, size = IconSize.control)
        BayText(strings.t("site.zoom"), Modifier.weight(1f))
        BayText("$zoom%", Modifier.testTag("page-zoom-value"), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED)
        Row(Modifier.background(Theme.colors.fill, RoundedCornerShape(Radius.control))) {
            ZoomStep("−", "page-zoom-out", strings.t("site.zoom.out"), zoom > ZOOM_MIN) { step(false) }
            ZoomStep("+", "page-zoom-in", strings.t("site.zoom.in"), zoom < ZOOM_MAX) { step(true) }
        }
    }
}

@Composable
private fun ZoomStep(glyph: String, id: String, label: String, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.size(44.dp, 36.dp).alpha(if (enabled) 1f else 0.35f).testTag(id)
            .semantics { contentDescription = label }
            .pressFeedback(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { BayText(glyph, weight = FontWeight.SemiBold) }
}

/**
 * What blocking did on this page: the count where the engine has one, the switch for this site, and a way to see the
 * page as the site made it when blocking broke something.
 */
@Composable
private fun BlockingCard(browser: BrowserModel, strings: Strings, blocking: PageBlocking, onRestore: () -> Unit) {
    val count = browser.blocked[browser.app.activeTabId] ?: 0
    val counted = blocking == PageBlocking.ON && count > 0
    val label = when {
        !counted -> strings.t("pageMenu.blocking")
        count == 1 -> strings.t("pageMenu.blockedOne")
        else -> strings.t("pageMenu.blockedCount", mapOf("count" to "$count"))
    }
    val detail = when (blocking) {
        PageBlocking.PAUSED -> strings.t("pageMenu.blocking.paused")
        PageBlocking.RESTORED -> strings.t("pageMenu.blocking.restored")
        else -> strings.t("pageMenu.blocking.on")
    }
    RowGroup(modifier = Modifier.padding(top = Space.lg)) {
        ActionRow(label, "page-blocking", icon = BayIcon.SHIELD, detail = detail, toggle = blocking == PageBlocking.ON, onClick = browser::toggleBlocking)
        if (blocking == PageBlocking.ON) {
            RowDivider()
            Row(
                Modifier.fillMaxWidth().testTag("page-restore").semantics(mergeDescendants = true) {}.pressFeedback(onClick = onRestore)
                    .heightIn(min = ROW_HEIGHT - 4.dp).padding(horizontal = Space.lg),
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BayIconView(BayIcon.RELOAD, size = IconSize.control)
                BayText(strings.t("pageMenu.restore"), Modifier.weight(1f), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED)
            }
        }
    }
}

/** The page's title and address, its site behind a lock (or a warning when it isn't encrypted), and what's blocked. */
@Composable
private fun RowScope.SiteHeader(browser: BrowserModel, strings: Strings, blocking: PageBlocking) {
    val url = browser.activeUrl
    val title = browser.activeNavigation.title.ifEmpty { browser.activeTab?.title.orEmpty() }
    val web = url.startsWith("http:") || url.startsWith("https:")
    val insecure = url.startsWith("http:")
    val status = listOf(
        if (!web) "" else if (insecure) strings.t("pageMenu.notSecure") else strings.t("pageMenu.secure"),
        when (blocking) {
            PageBlocking.ON -> strings.t("pageMenu.blocked")
            PageBlocking.OFF -> ""
            else -> strings.t("pageMenu.blockingPaused")
        },
    ).filter { it.isNotEmpty() }.joinToString(" · ")
    Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(Space.md), verticalAlignment = Alignment.CenterVertically) {
        if (url.isNotEmpty()) SiteIcon(browser.app, url, 44.dp)
        Column(Modifier.weight(1f)) {
            BayText(title.ifEmpty { url }, Modifier.semantics { heading() }, variant = TextVariant.HEADLINE, maxLines = 1)
            BayText(url, Modifier.testTag("page-menu-url"), variant = TextVariant.FOOTNOTE, tone = TextTone.MUTED, maxLines = 1)
            if (status.isNotEmpty()) {
                Row(
                    Modifier.padding(top = Space.xxs).clearAndSetSemantics { contentDescription = status },
                    horizontalArrangement = Arrangement.spacedBy(Space.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val colors = Theme.colors
                    if (web) BayIconView(if (insecure) BayIcon.ERROR else BayIcon.LOCK, size = IconSize.inline - 2.dp, color = if (insecure) colors.danger else colors.muted)
                    BayText(status, variant = TextVariant.CAPTION, weight = FontWeight.Normal, tone = if (insecure) TextTone.DANGER else TextTone.MUTED, maxLines = 1)
                }
            }
        }
    }
}

/** Find on page: sits above the keyboard in place of the bar. */
@Composable
fun FindBar(browser: BrowserModel, strings: Strings, modifier: Modifier = Modifier) {
    val find = browser.find ?: FindState()
    val colors = Theme.colors
    val matches = (find.count ?: 0) > 0
    val status = when {
        find.query.isEmpty() || find.count == null || find.foundFor != find.query -> ""
        find.count == 0 -> strings.t("find.noMatches")
        else -> strings.t("find.matchCount", mapOf("index" to "${find.index + 1}", "count" to "${find.count}"))
    }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Row(
        modifier.imePadding().fillMaxWidth().baySurface(Radius.card).padding(Space.sm).testTag("find-bar"),
        horizontalArrangement = Arrangement.spacedBy(Space.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier.weight(1f).height(44.dp).background(colors.fill, CircleShape).padding(start = Space.lg, end = Space.md),
            horizontalArrangement = Arrangement.spacedBy(Space.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicTextField(
                find.query,
                browser::findChanged,
                Modifier.weight(1f).focusRequester(focus).testTag("find-input").semantics { contentDescription = strings.t("find.placeholder") },
                singleLine = true,
                textStyle = TextVariant.BODY.style(color = colors.foreground),
                cursorBrush = SolidColor(colors.accent),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { browser.findStep(1) }),
                decorationBox = { inner ->
                    Box {
                        if (find.query.isEmpty()) BayText(strings.t("find.placeholder"), tone = TextTone.MUTED, maxLines = 1)
                        inner()
                    }
                },
            )
            // TalkBack reads each new count as it changes.
            BayText(status, Modifier.testTag("find-count").semantics { liveRegion = LiveRegionMode.Polite }, variant = TextVariant.FOOTNOTE, tone = TextTone.MUTED)
        }
        FindButton("find-previous", BayIcon.UP, strings.t("find.previous"), matches) { browser.findStep(-1) }
        FindButton("find-next", BayIcon.DOWN, strings.t("find.next"), matches) { browser.findStep(1) }
        Box(
            Modifier.height(44.dp).testTag("find-done").semantics(mergeDescendants = true) {}.pressFeedback(onClick = browser::endFind).padding(horizontal = Space.md),
            contentAlignment = Alignment.Center,
        ) { BayText(strings.t("find.done"), variant = TextVariant.CALLOUT, weight = FontWeight.SemiBold) }
    }
}

@Composable
private fun FindButton(id: String, icon: BayIcon, label: String, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.size(40.dp, 44.dp).alpha(if (enabled) 1f else 0.35f).testTag(id)
            .semantics { contentDescription = label }
            .pressFeedback(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { BayIconView(icon, size = 22.dp) }
}
