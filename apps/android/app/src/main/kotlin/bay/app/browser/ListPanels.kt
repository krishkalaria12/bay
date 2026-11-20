package bay.app.browser

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import bay.app.Strings
import bay.core.Action
import bay.core.BookmarkNode
import bay.core.DayBounds
import bay.core.DayGroupId
import bay.core.DownloadItem
import bay.core.DownloadState
import bay.core.downloadInterrupted
import bay.core.groupByDay
import bay.core.pageTitle
import bay.design.ActionRow
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.IconSize
import bay.design.PanelSheet
import bay.design.PillButton
import bay.design.SectionLabel
import bay.design.Space
import bay.design.TextTone
import bay.design.TextVariant
import bay.design.Theme
import bay.design.pressFeedback
import bay.design.style
import bay.engine.Engine
import java.text.DateFormat
import java.text.NumberFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.launch

/** How many history entries the sheet lists at once. */
private const val HISTORY_SHOWN = 200u

/** How far a row is swiped before it is removed, and how far it slides away then. */
private val REMOVE_DISTANCE = 96.dp
private val REMOVE_WIDTH = 400.dp

/** The tall sheets the browser lists things in. */
private const val LIST_FRACTION = 0.85f

/** The browser's list sheets, drawn over Settings too, since its index opens them. */
@Composable
fun ListPanels(browser: BrowserModel, strings: Strings) {
    HistoryPanel(browser, strings, browser.panel == Panel.HISTORY)
    ArchivePanel(browser, strings, browser.panel == Panel.ARCHIVE)
    BookmarksPanel(browser, strings, browser.panel == Panel.BOOKMARKS)
    DownloadsPanel(browser, strings, browser.panel == Panel.DOWNLOADS)
    ImportPanel(browser, strings, browser.panel == Panel.IMPORT)
}

// History

/** The space's history by day, searchable, each page a tap away; a row swipes (or its button taps) out of the list. */
@Composable
private fun HistoryPanel(browser: BrowserModel, strings: Strings, visible: Boolean) {
    val app = browser.app
    var query by rememberSaveable(visible) { mutableStateOf("") }
    var confirming by remember(visible) { mutableStateOf(false) }
    val title = strings.t("history.title")
    val space = app.activeSpaceId
    val needle = query.trim()
    // Read again whenever the store moves.
    val any = remember(app.revision, space) { app.store.history(space, "", 0u, 1u).isNotEmpty() }
    val entries = remember(app.revision, space, needle) { app.store.history(space, needle, 0u, HISTORY_SHOWN) }
    PanelSheet(visible, title, "history-screen", strings.sheetWords(title), { browser.panel = null }, maxFraction = LIST_FRACTION) {
        SheetSearchField(query, { query = it }, strings.t("history.search"), "history-search")
        when {
            !any -> EmptyNote(strings.t("history.empty"), strings.t("history.emptyDetail"), "history-empty")
            entries.isEmpty() -> NoMatches(strings.t("history.noMatches", mapOf("query" to needle)), "history-no-matches")
            else -> dayGroups(entries) { it.lastVisit }.forEach { (id, group) ->
                SectionLabel(strings.t("history.group.${id.name.lowercase()}"))
                group.forEach { entry ->
                    val rowTitle = pageTitle(entry.title, entry.url)
                    SiteRow(
                        browser, entry.url, rowTitle, "${siteName(entry.url)} · ${clockTime(entry.lastVisit, strings.locale)}",
                        strings.t("history.openLabel", mapOf("title" to rowTitle)), strings.t("history.removeLabel", mapOf("title" to rowTitle)),
                        "history-open-${entry.url}", "history-remove-${entry.url}",
                        onOpen = { browser.openListed(entry.url) },
                        onRemove = { app.dispatch(Action.RemoveHistory(space, entry.url)) },
                    )
                }
            }
        }
        if (any) {
            ClearFooter(
                confirming, { confirming = it }, strings.t("history.clear"), strings.t("history.clearAll"),
                strings.t("history.clearAll.detail"), strings.t("history.keep"), "history-clear",
            ) { app.dispatch(Action.ClearHistory(space)) }
        }
    }
}

// Archive

/** The space's closed tabs by the day they closed, searchable; a tap brings one back as a tab. */
@Composable
private fun ArchivePanel(browser: BrowserModel, strings: Strings, visible: Boolean) {
    val app = browser.app
    var query by rememberSaveable(visible) { mutableStateOf("") }
    var confirming by remember(visible) { mutableStateOf(false) }
    val title = strings.t("archive.title")
    val space = app.activeSpaceId
    val items = remember(app.revision, space) { app.store.archive(space) }
    val needle = query.trim().lowercase()
    val matches = if (needle.isEmpty()) items else items.filter { it.tab.title.lowercase().contains(needle) || it.tab.url.lowercase().contains(needle) }
    PanelSheet(visible, title, "archive-screen", strings.sheetWords(title), { browser.panel = null }, maxFraction = LIST_FRACTION) {
        if (items.isEmpty()) {
            EmptyNote(strings.t("archive.empty"), strings.t("archive.emptyDetail"), "archive-empty")
            return@PanelSheet
        }
        SheetSearchField(query, { query = it }, strings.t("archive.search"), "archive-search")
        if (matches.isEmpty()) NoMatches(strings.t("archive.noMatches", mapOf("query" to needle)), "archive-no-matches")
        dayGroups(matches) { it.closedAt }.forEach { (id, group) ->
            SectionLabel(strings.t("history.group.${id.name.lowercase()}"))
            group.forEach { item ->
                val rowTitle = pageTitle(item.tab.title, item.tab.url)
                SiteRow(
                    browser, item.tab.url, rowTitle, "${siteName(item.tab.url)} · ${clockTime(item.closedAt, strings.locale)}",
                    strings.t("history.openLabel", mapOf("title" to rowTitle)), strings.t("archive.removeLabel", mapOf("title" to rowTitle)),
                    "archive-restore-${item.tab.id}", "archive-remove-${item.tab.id}",
                    onOpen = { browser.restoreArchived(item.tab.id) },
                    onRemove = { app.dispatch(Action.RemoveArchived(item.tab.id)) },
                )
            }
        }
        ClearFooter(
            confirming, { confirming = it }, strings.t("archive.clear"), strings.t("archive.clear"),
            strings.t("archive.clear.detail"), strings.t("archive.keep"), "archive-clear",
        ) { app.dispatch(Action.ClearArchive(space)) }
    }
}

// Bookmarks

/**
 * The space's bookmark tree a folder at a time, in the order it was saved. Search looks through every link, whichever
 * folder it's in. Removing a folder asks first, since it takes everything inside with it.
 */
@Composable
private fun BookmarksPanel(browser: BrowserModel, strings: Strings, visible: Boolean) {
    val app = browser.app
    // Each opening starts at the top, with no search.
    var folderId by remember(visible) { mutableStateOf("bookmarks") }
    var query by remember(visible) { mutableStateOf("") }
    // The folder whose remove button was tapped: its row asks before anything goes.
    var confirming by remember(visible) { mutableStateOf<String?>(null) }
    val space = app.activeSpaceId
    val listing = remember(app.revision, space, folderId, query) { app.store.bookmarkListing(space, folderId, query) }
    val parent = listing.parentId
    val title = if (parent == null) strings.t("bookmarks.title") else listing.title.ifEmpty { strings.t("bookmarks.untitled") }
    val needle = query.trim()
    val enter = { id: String ->
        confirming = null
        folderId = id
    }
    PanelSheet(
        visible, title, "bookmarks-screen", strings.sheetWords(title), { browser.panel = null },
        onBack = parent?.let { { enter(it) } }, maxFraction = LIST_FRACTION,
    ) {
        // The way to bring bookmarks from another browser, under the list's top.
        val importRow = @Composable {
            ActionRow(strings.t("bookmarks.import"), "bookmarks-import", icon = BayIcon.IMPORT, chevron = true) { browser.panel = Panel.IMPORT }
        }
        if (listing.nodes == 0u) {
            EmptyNote(strings.t("bookmarks.empty"), strings.t("bookmarks.emptyDetail"), "bookmarks-empty")
            importRow()
            return@PanelSheet
        }
        SheetSearchField(query, { query = it }, strings.t("bookmarks.search"), "bookmarks-search")
        if (listing.rows.isEmpty()) {
            NoMatches(
                if (needle.isEmpty()) strings.t("bookmarks.folderEmpty") else strings.t("bookmarks.noMatches", mapOf("query" to needle)),
                "bookmarks-no-matches",
            )
        }
        listing.rows.forEach { row ->
            when (val node = row.node) {
                is BookmarkNode.Url -> {
                    val rowTitle = pageTitle(node.title, node.url)
                    SiteRow(
                        browser, node.url, rowTitle, siteName(node.url),
                        strings.t("history.openLabel", mapOf("title" to rowTitle)), strings.t("bookmarks.removeLabel", mapOf("title" to rowTitle)),
                        "bookmark-open-${node.url}", "bookmark-remove-${node.url}",
                        onOpen = { browser.openListed(node.url) },
                        onRemove = { app.dispatch(Action.RemoveBookmark(space, node.id)) },
                    )
                }
                is BookmarkNode.Folder -> FolderRow(
                    strings, node.title.ifEmpty { strings.t("bookmarks.untitled") }, row.links, confirming == node.id,
                    onOpen = { enter(node.id) },
                    onAskRemove = { confirming = node.id },
                    onRemove = {
                        confirming = null
                        app.dispatch(Action.RemoveBookmark(space, node.id))
                    },
                    onKeep = { confirming = null },
                )
            }
        }
        if (parent == null && needle.isEmpty()) {
            Box(Modifier.padding(top = Space.lg)) { importRow() }
        }
    }
}

@Composable
private fun FolderRow(
    strings: Strings,
    name: String,
    links: UInt,
    confirming: Boolean,
    onOpen: () -> Unit,
    onAskRemove: () -> Unit,
    onRemove: () -> Unit,
    onKeep: () -> Unit,
) {
    val colors = Theme.colors
    val detail = when (links) {
        0u -> strings.t("bookmarks.folderEmpty")
        1u -> strings.t("bookmarks.folderOne")
        else -> strings.t("bookmarks.folderCount", mapOf("count" to "$links"))
    }
    if (confirming) {
        Column(Modifier.fillMaxWidth().padding(vertical = Space.sm).testTag("bookmark-folder-confirm-$name")) {
            ActionRow(
                strings.t("bookmarks.removeFolder", mapOf("title" to name)), "bookmark-folder-remove-confirm", icon = BayIcon.DELETE,
                detail = detail, destructive = true, onClick = onRemove,
            )
            ActionRow(strings.t("bookmarks.keep"), "bookmark-folder-keep", onClick = onKeep)
        }
        return
    }
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).hairline(), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.weight(1f).testTag("bookmark-folder-$name")
                .clearAndSetSemantics {
                    contentDescription = strings.t("bookmarks.openFolderLabel", mapOf("title" to name))
                    stateDescription = detail
                    role = Role.Button
                }
                .pressFeedback(onClick = onOpen)
                .padding(vertical = Space.sm),
            horizontalArrangement = Arrangement.spacedBy(Space.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) { BayIconView(BayIcon.FOLDER, size = IconSize.control, color = colors.accent) }
            Column(Modifier.weight(1f)) {
                BayText(name, variant = TextVariant.CALLOUT, maxLines = 1)
                BayText(detail, variant = TextVariant.FOOTNOTE, tone = TextTone.MUTED, maxLines = 1)
            }
            BayIconView(BayIcon.CHEVRON, size = IconSize.inline, color = colors.muted)
        }
        RemoveButton(strings.t("bookmarks.removeLabel", mapOf("title" to name)), "bookmark-folder-remove-$name", onAskRemove)
    }
}

// Downloads

/** Downloads, newest first: tap a finished one to open it. Removing one only takes it off the list. */
@Composable
private fun DownloadsPanel(browser: BrowserModel, strings: Strings, visible: Boolean) {
    val app = browser.app
    val title = strings.t("downloads.title")
    // While private tabs are locked, their downloads stay out of sight too.
    val items = if (browser.locked) app.downloads.filter { !it.private } else app.downloads
    PanelSheet(visible, title, "downloads-panel", strings.sheetWords(title), { browser.panel = null }, maxFraction = 0.7f) {
        if (items.isEmpty()) {
            BayText(strings.t("downloads.empty"), Modifier.testTag("downloads-empty"), tone = TextTone.MUTED)
            return@PanelSheet
        }
        items.forEachIndexed { index, item -> DownloadRow(browser, strings, item, index) }
        if (items.any { it.state != DownloadState.DOWNLOADING }) {
            Box(Modifier.padding(top = Space.md)) {
                ActionRow(strings.t("downloads.clearList"), "downloads-clear") { app.dispatch(Action.ClearDownloads) }
            }
        }
    }
}

@Composable
private fun DownloadRow(browser: BrowserModel, strings: Strings, item: DownloadItem, index: Int) {
    val status = downloadStatus(item, strings)
    val running = item.state == DownloadState.DOWNLOADING
    val finished = item.state == DownloadState.FINISHED
    Row(Modifier.fillMaxWidth().hairline(), horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
        Column(
            Modifier.weight(1f).heightIn(min = 56.dp).testTag("download-$index")
                .pressFeedback(enabled = finished) { browser.openDownload(item) }
                // The row says the file and its status; the status line keeps its own node, so it can be found by id.
                .semantics {
                    contentDescription = "${item.filename}, $status"
                    role = Role.Button
                    if (!finished) disabled()
                }
                .padding(vertical = Space.sm),
            verticalArrangement = Arrangement.Center,
        ) {
            BayText(item.filename, Modifier.clearAndSetSemantics {}, maxLines = 1)
            BayText(status, Modifier.testTag("download-$index-status"), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED, maxLines = 1)
            if (running) DownloadProgress(item, Modifier.padding(top = Space.sm))
        }
        val label = if (running) strings.t("downloads.cancelLabel", mapOf("filename" to item.filename))
        else strings.t("downloads.removeLabel", mapOf("filename" to item.filename))
        PillButton(
            if (running) strings.t("downloads.cancel") else strings.t("downloads.remove"),
            Modifier.testTag("download-$index-${if (running) "cancel" else "remove"}").semantics { contentDescription = label },
            compact = true,
        ) {
            if (running) Engine.cancelDownload(item.id) else browser.app.dispatch(Action.RemoveDownload(item.id))
        }
    }
}

/**
 * A running download's bar: it eases to each new fraction, and while the size is unknown or the download is waiting a
 * short segment sweeps across instead, so it never looks frozen. The status line says the percentage in words.
 */
@Composable
fun DownloadProgress(item: DownloadItem, modifier: Modifier = Modifier) {
    val colors = Theme.colors
    val known = item.total > 0 && item.waiting == null
    BoxWithConstraints(modifier.fillMaxWidth().height(4.dp).clip(CircleShape).background(colors.fill).clearAndSetSemantics {}) {
        if (known) {
            val fraction by animateFloatAsState((item.received.toFloat() / item.total).coerceIn(0f, 1f), tween(450), label = "download")
            Box(Modifier.fillMaxHeight().fillMaxWidth(fraction).background(colors.accent, CircleShape))
        } else {
            val sweep = rememberInfiniteTransition(label = "sweep")
            val position by sweep.animateFloat(0f, 1f, infiniteRepeatable(tween(1100, easing = LinearEasing), RepeatMode.Restart), label = "position")
            val width = maxWidth
            Box(Modifier.fillMaxHeight().width(width * 0.35f).offset(x = width * (position * 1.35f - 0.35f)).background(colors.accent, CircleShape))
        }
    }
}

/** "1.2 MB", "340 KB", with the number written the current language's way. */
fun formatBytes(bytes: Long, strings: Strings): String {
    val format = NumberFormat.getNumberInstance(Locale.forLanguageTag(strings.locale))
    format.minimumFractionDigits = 1
    format.maximumFractionDigits = 1
    if (bytes >= 1_000_000_000) return "${format.format(bytes / 1_000_000_000.0)} GB"
    if (bytes >= 1_000_000) return "${format.format(bytes / 1_000_000.0)} MB"
    format.minimumFractionDigits = 0
    format.maximumFractionDigits = 0
    if (bytes >= 1_000) return "${format.format(Math.round(bytes / 1_000.0))} KB"
    return strings.t("downloads.size.bytes", mapOf("size" to format.format(bytes)))
}

/** What a download is doing, in a few words. */
fun downloadStatus(item: DownloadItem, strings: Strings): String = when (item.state) {
    DownloadState.DOWNLOADING -> when {
        item.waiting != null -> item.waiting!!
        item.total > 0 -> strings.t(
            "downloads.status.progress",
            mapOf(
                "percent" to "${item.received * 100 / item.total}",
                "received" to formatBytes(item.received, strings),
                "total" to formatBytes(item.total, strings),
            ),
        )
        item.received > 0 -> strings.t("downloads.status.soFar", mapOf("size" to formatBytes(item.received, strings)))
        else -> strings.t("downloads.status.starting")
    }
    DownloadState.FINISHED -> formatBytes(if (item.total > 0) item.total else item.received, strings)
    DownloadState.CANCELLED -> strings.t("downloads.status.cancelled")
    // Bay's own note is saved in English; the engine's messages arrive in the device's language already.
    DownloadState.FAILED -> if (downloadInterrupted(item)) strings.t("downloads.interrupted") else item.error ?: strings.t("downloads.status.failed")
}

// Shared pieces

/** Entries (newest first) in the day groups the core picks by the phone's calendar: Today, Yesterday, This week, Earlier. */
private fun <T> dayGroups(entries: List<T>, at: (T) -> Long): List<Pair<DayGroupId, List<T>>> {
    val day = Calendar.getInstance().apply {
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
    }
    val today = day.timeInMillis
    val yesterday = (day.clone() as Calendar).apply { add(Calendar.DAY_OF_MONTH, -1) }.timeInMillis
    val week = (day.clone() as Calendar).apply { add(Calendar.DAY_OF_MONTH, -6) }.timeInMillis
    return groupByDay(entries.map(at), DayBounds(today, yesterday, week)).map { group ->
        group.id to group.entries.map { entries[it.toInt()] }
    }
}

/** "14:05" or "2:05 PM", as the language writes a time. */
private fun clockTime(millis: Long, locale: String): String =
    DateFormat.getTimeInstance(DateFormat.SHORT, Locale.forLanguageTag(locale)).format(Date(millis))

/** A sheet's search field, on the fill under the sheet's rows. */
@Composable
private fun SheetSearchField(value: String, onChange: (String) -> Unit, placeholder: String, testID: String) {
    val colors = Theme.colors
    Row(
        Modifier.fillMaxWidth().padding(bottom = Space.xs).heightIn(min = 44.dp).background(colors.fill, CircleShape).padding(horizontal = Space.lg),
        horizontalArrangement = Arrangement.spacedBy(Space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BayIconView(BayIcon.SEARCH, size = IconSize.small, color = colors.muted)
        BasicTextField(
            value,
            onChange,
            Modifier.weight(1f).testTag(testID).semantics { contentDescription = placeholder },
            singleLine = true,
            textStyle = TextVariant.BODY.style(color = colors.foreground),
            cursorBrush = SolidColor(colors.accent),
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Search),
            decorationBox = { inner ->
                Box {
                    if (value.isEmpty()) BayText(placeholder, tone = TextTone.MUTED)
                    inner()
                }
            },
        )
    }
}

/** A site's icon, title and detail line that opens it, with a remove button; swiping the row left removes it too. */
@Composable
private fun SiteRow(
    browser: BrowserModel,
    url: String,
    title: String,
    detail: String,
    openLabel: String,
    removeLabel: String,
    testID: String,
    removeTestID: String,
    onOpen: () -> Unit,
    onRemove: () -> Unit,
) {
    val colors = Theme.colors
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val offset = remember { Animatable(0f) }
    val distance = with(density) { REMOVE_DISTANCE.toPx() }
    val away = with(density) { REMOVE_WIDTH.toPx() }
    Box(Modifier.fillMaxWidth()) {
        // What the swipe uncovers.
        BayIconView(
            BayIcon.DELETE,
            Modifier.align(Alignment.CenterEnd).padding(end = 20.dp).alpha((-offset.value / distance).coerceIn(0f, 1f)),
            size = IconSize.row,
            color = colors.danger,
        )
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp)
                .graphicsLayer { translationX = offset.value }
                .background(colors.surface)
                .hairline()
                // Sideways only: a vertical drag scrolls the list, and a tap still opens the page.
                .pointerInput(Unit) {
                    detectHorizontalDragGestures(
                        onDragEnd = {
                            scope.launch {
                                if (offset.value < -distance) {
                                    offset.animateTo(-away, tween(160))
                                    onRemove()
                                } else {
                                    offset.animateTo(0f, spring())
                                }
                            }
                        },
                        onDragCancel = { scope.launch { offset.animateTo(0f, spring()) } },
                        onHorizontalDrag = { _, amount -> scope.launch { offset.snapTo(minOf(0f, offset.value + amount)) } },
                    )
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                Modifier.weight(1f).testTag(testID)
                    .clearAndSetSemantics {
                        contentDescription = openLabel
                        // The site and time, read after the title.
                        stateDescription = detail
                        role = Role.Button
                    }
                    .pressFeedback(onClick = onOpen)
                    .padding(vertical = Space.sm),
                horizontalArrangement = Arrangement.spacedBy(Space.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SiteIcon(browser.app, url)
                Column(Modifier.weight(1f)) {
                    BayText(title, variant = TextVariant.CALLOUT, maxLines = 1)
                    BayText(detail, variant = TextVariant.FOOTNOTE, tone = TextTone.MUTED, maxLines = 1)
                }
            }
            RemoveButton(removeLabel, removeTestID, onRemove)
        }
    }
}

@Composable
private fun RemoveButton(label: String, testID: String, onClick: () -> Unit) {
    Box(
        Modifier.size(44.dp).testTag(testID).clearAndSetSemantics { contentDescription = label; role = Role.Button }.pressFeedback(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { BayIconView(BayIcon.CLOSE, size = IconSize.small, color = Theme.colors.muted) }
}

/** The faint line under each list row. */
@Composable
private fun Modifier.hairline(): Modifier {
    val color = Theme.colors.foreground.copy(alpha = 0.05f)
    return drawBehind {
        val line = 1.dp.toPx()
        drawRect(color, topLeft = Offset(0f, size.height - line), size = Size(size.width, line))
    }
}

/** What an empty list says, in the middle of the sheet. */
@Composable
private fun EmptyNote(title: String, detail: String, testID: String) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 48.dp).testTag(testID),
        verticalArrangement = Arrangement.spacedBy(Space.sm),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        BayText(title, Modifier.semantics { heading() }, variant = TextVariant.HEADLINE, textAlign = TextAlign.Center)
        BayText(detail, variant = TextVariant.SUBHEAD, tone = TextTone.MUTED, textAlign = TextAlign.Center)
    }
}

@Composable
private fun NoMatches(text: String, testID: String) {
    BayText(
        text,
        Modifier.fillMaxWidth().padding(vertical = Space.xxl).testTag(testID).semantics { liveRegion = LiveRegionMode.Polite },
        tone = TextTone.MUTED,
        textAlign = TextAlign.Center,
    )
}

/** The destructive row under a list that asks once before it clears everything. */
@Composable
private fun ClearFooter(
    confirming: Boolean,
    setConfirming: (Boolean) -> Unit,
    label: String,
    confirmLabel: String,
    detail: String,
    keepLabel: String,
    testID: String,
    onClear: () -> Unit,
) {
    // Lined up with the rows above it: the icon in the site icon's column, the words where their titles start.
    val trash: @Composable () -> Unit = {
        Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) {
            BayIconView(BayIcon.DELETE, size = IconSize.control, color = Theme.colors.danger)
        }
    }
    Column(Modifier.fillMaxWidth().padding(top = Space.lg)) {
        if (confirming) {
            ActionRow(confirmLabel, "$testID-confirm", detail = detail, destructive = true, leading = trash, inset = 0.dp, gap = Space.md) {
                setConfirming(false)
                onClear()
            }
            ActionRow(keepLabel, "$testID-cancel", leading = { Box(Modifier.size(28.dp)) }, inset = 0.dp, gap = Space.md) { setConfirming(false) }
        } else {
            ActionRow(label, testID, destructive = true, leading = trash, inset = 0.dp, gap = Space.md) { setConfirming(true) }
        }
    }
}

/** The latest download, above the bar: its progress while it comes in, then Open once it's saved. A tap shows every download. */
@Composable
fun DownloadToast(browser: BrowserModel, strings: Strings, item: DownloadItem) {
    val colors = Theme.colors
    val status = downloadStatus(item, strings)
    val finished = item.state == DownloadState.FINISHED
    val heading = if (finished) strings.t("downloadToast.downloaded", mapOf("filename" to item.filename)) else item.filename
    val shape = androidx.compose.foundation.shape.RoundedCornerShape(bay.design.Radius.card)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(colors.surface, shape).padding(Space.md),
        verticalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(Space.md), verticalAlignment = Alignment.CenterVertically) {
            BayIconView(
                if (finished) BayIcon.CHECK else if (item.state == DownloadState.DOWNLOADING) BayIcon.DOWNLOAD else BayIcon.ERROR,
                size = IconSize.row,
                color = if (item.state == DownloadState.FAILED) colors.danger else colors.accent,
            )
            Column(
                Modifier.weight(1f).testTag("download-toast")
                    .clearAndSetSemantics {
                        contentDescription = strings.t("downloadToast.showAll", mapOf("filename" to item.filename, "status" to status))
                        role = Role.Button
                    }
                    .pressFeedback { browser.panel = Panel.DOWNLOADS },
            ) {
                BayText(heading, weight = androidx.compose.ui.text.font.FontWeight.Medium, maxLines = 1)
                BayText(status, Modifier.testTag("download-toast-status"), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED, maxLines = 1)
            }
            if (finished) {
                val label = strings.t("downloadToast.openLabel", mapOf("filename" to item.filename))
                PillButton(strings.t("downloadToast.open"), Modifier.testTag("download-toast-open").semantics { contentDescription = label }, compact = true) {
                    browser.openDownload(item)
                }
            }
        }
        if (item.state == DownloadState.DOWNLOADING) DownloadProgress(item)
    }
}
