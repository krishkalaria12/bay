package bay.app.browser

import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.draw.shadow
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.border
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

private val ADDRESS_HEIGHT = 48.dp
private val TILE_HEIGHT = 76.dp
private val ROW_HEIGHT = 52.dp
/** The menu stands no taller than this part of the screen; its rows scroll. */
private const val MENU_FRACTION = 0.62f
private const val ZOOM_MIN = 80
private const val ZOOM_MAX = 200

/**
 * What to do with the page showing (bar-more), as one floating sheet: the address with back, forward, copy and reload on
 * top; Share, Pin, Save and Find; this site's settings and Developer tools a step away; Reader, Hide elements, Translate
 * and the page's zoom; Bookmarks, History, Downloads and Settings.
 */
@Composable
fun PageMenu(browser: BrowserModel, strings: Strings, visible: Boolean, onSettings: () -> Unit) {
    var tools by remember { mutableStateOf(false) }
    LaunchedEffect(visible) { if (visible) tools = false }
    val close = { browser.panel = null }
    // Closes the menu, then does what was picked.
    fun act(action: () -> Unit): () -> Unit = {
        close()
        action()
    }
    if (tools) {
        val title = strings.t("pageMenu.developerTools")
        PanelSheet(visible, title, "page-menu", strings.sheetWords(title), onClose = close, onBack = { tools = false }, maxFraction = MENU_FRACTION) {
            ToolsRows(browser, strings, ::act)
        }
        return
    }
    val title = strings.t("pageMenu.title")
    val app = browser.app
    PanelSheet(
        visible,
        title,
        "page-menu",
        strings.sheetWords(title),
        onClose = close,
        maxFraction = MENU_FRACTION,
        header = { AddressRow(browser, strings, ::act) },
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            MenuTile("page-share", BayIcon.SHARE, strings.t("pageMenu.share"), onClick = act(browser::share))
            val pinned = browser.isPinned
            MenuTile(
                "page-pin", if (pinned) BayIcon.UNPIN else BayIcon.PIN, strings.t("pageMenu.pin"),
                strings.t(if (pinned) "pageMenu.unpin" else "pageMenu.pinToStart"), pinned, act(browser::togglePin),
            )
            val bookmarked = browser.isBookmarked
            MenuTile(
                "page-bookmark", if (bookmarked) BayIcon.BOOKMARKED else BayIcon.BOOKMARK, strings.t("pageMenu.save"),
                strings.t("pageMenu.bookmark"), bookmarked,
            ) { browser.panel = Panel.SAVE }
            MenuTile("page-find", BayIcon.FIND, strings.t("pageMenu.find"), onClick = act(browser::startFind))
        }
        Column(Modifier.padding(top = Space.md)) {
            RowGroup {
                ActionRow(strings.t("pageMenu.siteSettings"), "page-site-settings", icon = BayIcon.TUNE, chevron = true) { browser.panel = Panel.SITE_SETTINGS }
                ActionRow(strings.t("pageMenu.developerTools"), "page-more-tools", icon = BayIcon.TOOLS, chevron = true) { tools = true }
            }
            RowGroup {
                val reading = browser.readerTab == app.activeTabId
                val readerHere = browser.siteSetting.reader
                val readerLabel = strings.t(if (reading) "pageMenu.readerSettings" else "pageMenu.showReader")
                ListRow(
                    readerLabel, "page-reader", BayIcon.READER, { browser.openReader() },
                    buildList {
                        add(Choice(readerLabel) { browser.openReader() })
                        if (reading) add(Choice(strings.t("reader.exit"), onPick = act(browser::exitReader)))
                        add(Choice(strings.t("site.reader"), checked = readerHere) { browser.changeSiteSetting { it.copy(reader = !readerHere) } })
                    },
                )
                RowDivider()
                ActionRow(strings.t("pageMenu.hideElements"), "page-hide-elements", icon = BayIcon.HIDE, onClick = act { browser.startPicking(PickMode.HIDE) })
                RowDivider()
                val languages = bay.core.locales().let { all -> all.filter { it.id == strings.locale } + all.filter { it.id != strings.locale } }
                ListRow(
                    strings.t("pageMenu.translatePage"), "page-translate", BayIcon.TRANSLATE, act(browser::translate),
                    languages.map { language -> Choice(language.name, onPick = act { browser.translate(language.id) }) },
                )
                RowDivider()
                ZoomRow(strings, browser.pageZoom, browser::setZoom)
            }
            RowGroup {
                ActionRow(strings.t("pageMenu.bookmarks"), "page-bookmarks", icon = BayIcon.BOOKMARK, chevron = true) { browser.openDrawer() }
                ActionRow(strings.t("pageMenu.history"), "page-history", icon = BayIcon.HISTORY, chevron = true) { browser.panel = Panel.HISTORY }
                ActionRow(strings.t("pageMenu.downloads"), "page-downloads", icon = BayIcon.DOWNLOAD, chevron = true) { browser.panel = Panel.DOWNLOADS }
                ActionRow(strings.t("pageMenu.settings"), "page-settings", icon = BayIcon.SETTINGS, chevron = true, onClick = act(onSettings))
            }
        }
    }
}

@Composable
private fun ToolsRows(browser: BrowserModel, strings: Strings, act: (() -> Unit) -> () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(Space.md)) {
        RowGroup {
            ActionRow(
                strings.t("pageMenu.inspect"), "page-inspect", icon = BayIcon.INSPECT, detail = strings.t("pageMenu.inspect.detail"),
                onClick = act { browser.startPicking(PickMode.INSPECT) },
            )
            val hidden = browser.activeHidden.size
            if (hidden > 0) {
                RowDivider()
                ActionRow(
                    if (hidden == 1) strings.t("pageMenu.hiddenOne") else strings.t("pageMenu.hiddenMany", mapOf("count" to "$hidden")),
                    "page-show-hidden",
                    icon = BayIcon.VISIBILITY,
                    onClick = act(browser::showHidden),
                )
            }
            RowDivider()
            ActionRow(
                strings.t("pageMenu.markdown"), "page-markdown", icon = BayIcon.MARKDOWN, detail = strings.t("pageMenu.markdown.detail"),
                onClick = act(browser::copyMarkdown),
            )
        }
        RowGroup {
            ActionRow(strings.t("pageMenu.privateTab"), "page-new-private", icon = BayIcon.PRIVATE, onClick = act { browser.search(inNewTab = true, privately = true) })
            RowDivider()
            ActionRow(strings.t("pageMenu.archiveTab"), "page-close-tab", icon = BayIcon.ARCHIVE, onClick = act { browser.archive(browser.app.activeTabId) })
        }
    }
}

/**
 * The page's address in one capsule: back and forward at its left, the lock (or a warning) and the address cut short at
 * its end, and copy and reload (or stop) at its right. Tapping the address opens search with it filled in.
 */
@Composable
private fun RowScope.AddressRow(browser: BrowserModel, strings: Strings, act: (() -> Unit) -> () -> Unit) {
    val navigation = browser.activeNavigation
    val url = browser.activeUrl
    val insecure = url.startsWith("http:")
    val colors = Theme.colors
    Row(
        Modifier.weight(1f).height(ADDRESS_HEIGHT).background(colors.fill, CircleShape).padding(horizontal = Space.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AddressIcon("page-back", BayIcon.BACK, strings.t("pageMenu.back"), navigation.canGoBack, act(browser::goBack))
        AddressIcon("page-forward", BayIcon.FORWARD, strings.t("pageMenu.forward"), navigation.canGoForward, act(browser::goForward))
        Row(
            Modifier.weight(1f).height(ADDRESS_HEIGHT).testTag("page-menu-url")
                .clearAndSetSemantics {
                    contentDescription = "${strings.t(if (insecure) "pageMenu.notSecure" else "pageMenu.secure")}, $url"
                    role = androidx.compose.ui.semantics.Role.Button
                }
                .pressFeedback(onClick = act { browser.search(inNewTab = false) }),
            horizontalArrangement = Arrangement.spacedBy(Space.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BayIconView(if (insecure) BayIcon.ERROR else BayIcon.LOCK, size = IconSize.inline, color = if (insecure) colors.danger else colors.muted)
            BayText(displayUrl(url), variant = TextVariant.CALLOUT, maxLines = 1)
        }
        AddressIcon("page-copy", BayIcon.LINK, strings.t("pageMenu.copyLink"), true, act(browser::copyLink))
        if (navigation.isLoading) {
            AddressIcon("page-stop", BayIcon.CLOSE, strings.t("pageMenu.stop"), true, act(browser::stop))
        } else {
            AddressIcon("page-reload", BayIcon.RELOAD, strings.t("pageMenu.reload"), true, act(browser::reload))
        }
    }
}

@Composable
private fun AddressIcon(id: String, icon: BayIcon, label: String, enabled: Boolean, onClick: () -> Unit) {
    val colors = Theme.colors
    Box(
        Modifier.size(40.dp, ADDRESS_HEIGHT).testTag(id)
            .clearAndSetSemantics { contentDescription = label; role = androidx.compose.ui.semantics.Role.Button }
            .pressFeedback(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { BayIconView(icon, size = IconSize.row, color = if (enabled) colors.foreground else colors.muted.copy(alpha = 0.5f)) }
}

/** A rounded square with an icon over its label, four to a row: the page menu's and the tab sheet's. */
@Composable
fun RowScope.MenuTile(id: String, icon: BayIcon, label: String, description: String = label, active: Boolean = false, onClick: () -> Unit) {
    val colors = Theme.colors
    Column(
        Modifier.weight(1f).height(TILE_HEIGHT).testTag(id)
            .clearAndSetSemantics {
                contentDescription = description
                role = androidx.compose.ui.semantics.Role.Button
                if (active) selected = true
            }
            .pressFeedback(onClick = onClick)
            .background(if (active) colors.accent.copy(alpha = 0.15f) else colors.fill, RoundedCornerShape(Radius.tile)),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.xs, Alignment.CenterVertically),
    ) {
        BayIconView(icon, size = IconSize.control, color = if (active) colors.accent else colors.foreground)
        BayText(label, variant = TextVariant.CAPTION, weight = FontWeight.Medium, tone = if (active) TextTone.ACCENT else TextTone.DEFAULT, maxLines = 1)
    }
}

/** One choice behind a row's ⌃⌄. */
private class Choice(val label: String, val checked: Boolean = false, val onPick: () -> Unit)

/**
 * A row that does its main thing when tapped and offers a short list behind ⌃⌄ (Reader's choices, Translate's
 * languages); TalkBack gets the list as the row's actions.
 */
@Composable
private fun ListRow(label: String, testID: String, icon: BayIcon, primary: () -> Unit, choices: List<Choice>) {
    var open by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().heightIn(min = ROW_HEIGHT)
            .semantics {
                customActions = choices.map { choice ->
                    androidx.compose.ui.semantics.CustomAccessibilityAction(choice.label) {
                        choice.onPick()
                        true
                    }
                }
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier.weight(1f).heightIn(min = ROW_HEIGHT).testTag(testID)
                .clearAndSetSemantics { contentDescription = label; role = androidx.compose.ui.semantics.Role.Button }
                .pressFeedback(onClick = primary).padding(start = Space.lg),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BayIconView(icon, size = IconSize.control)
            BayText(label, maxLines = 1)
        }
        Box {
            Box(
                Modifier.size(52.dp, ROW_HEIGHT).testTag("$testID-choices")
                    .clearAndSetSemantics { contentDescription = label; role = androidx.compose.ui.semantics.Role.DropdownList }
                    .pressFeedback { open = true },
                contentAlignment = Alignment.Center,
            ) { BayIconView(BayIcon.UNFOLD, size = IconSize.small, color = Theme.colors.muted) }
            if (open) {
                androidx.compose.ui.window.Popup(
                    alignment = Alignment.TopEnd,
                    onDismissRequest = { open = false },
                    properties = androidx.compose.ui.window.PopupProperties(focusable = true),
                ) {
                    Column(Modifier.width(240.dp).baySurface(Radius.card).padding(vertical = Space.xs)) {
                        choices.forEach { choice ->
                            Row(
                                Modifier.fillMaxWidth().heightIn(min = 44.dp)
                                    .pressFeedback {
                                        open = false
                                        choice.onPick()
                                    }
                                    .padding(horizontal = Space.lg),
                                horizontalArrangement = Arrangement.spacedBy(Space.sm),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                BayText(choice.label, Modifier.weight(1f), maxLines = 1)
                                if (choice.checked) BayIconView(BayIcon.CHECK, size = IconSize.small, color = Theme.colors.accent)
                            }
                        }
                    }
                }
            }
        }
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
        BayText(strings.percent(zoom), Modifier.testTag("page-zoom-value"), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED)
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
fun BlockingCard(browser: BrowserModel, strings: Strings, blocking: PageBlocking, onRestore: () -> Unit) {
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
    RowGroup {
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
