package bay.app.browser

import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import bay.app.AppModel
import bay.app.Strings
import bay.core.Action
import bay.core.BookmarkLocation
import bay.core.BookmarkNode
import bay.core.BrowserSpace
import bay.core.siteName
import bay.design.ActionRow
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.Haptics
import bay.design.IconSize
import bay.design.PanelSheet
import bay.design.RowGroup
import bay.design.SheetIconButton
import bay.design.Space
import bay.design.TextVariant
import bay.design.Theme
import bay.design.pressFeedback
import bay.design.style
import java.util.UUID

/** The id of a space's top folder. */
private const val TOP = "bookmarks"

/**
 * The spaces in a row of chips: the one chosen filled with its colour and named, the others as their glyph on a wash of
 * their colour, and a + for a new space. For saving a bookmark into a space, and the bookmarks drawer.
 */
@Composable
fun SpaceChips(spaces: List<BrowserSpace>, chosen: String, strings: Strings, onChoose: (String) -> Unit, onAdd: (() -> Unit)? = null) {
    val view = LocalView.current
    Row(Modifier.horizontalScroll(rememberScrollState()).testTag("space-chips"), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
        spaces.forEach { space ->
            val name = spaceName(space, strings)
            val picked = space.id == chosen
            val color = spaceColor(space.color)
            Row(
                Modifier.height(40.dp).testTag("space-chip-${space.id}")
                    .clearAndSetSemantics {
                        contentDescription = name
                        role = Role.Button
                        selected = picked
                    }
                    .pressFeedback {
                        Haptics.press(view)
                        onChoose(space.id)
                    }
                    .background(if (picked) color else color.copy(alpha = 0.2f), RoundedCornerShape(12.dp))
                    .padding(horizontal = if (picked) Space.md else Space.sm),
                horizontalArrangement = Arrangement.spacedBy(Space.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SpaceGlyph(space, name, 22.dp)
                if (picked) BayText(name, variant = TextVariant.SUBHEAD, weight = FontWeight.SemiBold, color = Color.White, maxLines = 1)
            }
        }
        if (onAdd != null) {
            Box(
                Modifier.size(40.dp).testTag("space-chip-add")
                    .clearAndSetSemantics { contentDescription = strings.t("save.newSpace"); role = Role.Button }
                    .pressFeedback(onClick = onAdd)
                    .background(Theme.colors.fill, RoundedCornerShape(12.dp)),
                contentAlignment = Alignment.Center,
            ) { BayIconView(BayIcon.ADD, size = IconSize.small, color = Theme.colors.muted) }
        }
    }
}

/**
 * Saving the page as a bookmark: its title and address, the space it goes in, and the folder, as a form with Cancel and
 * Save at its top. A page already saved opens where it is, and Save moves or renames it there; Remove takes it out.
 */
@Composable
fun SavePanel(browser: BrowserModel, strings: Strings, visible: Boolean) {
    val app = browser.app
    val view = LocalView.current
    var title by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var space by remember { mutableStateOf("") }
    var folder by remember { mutableStateOf(TOP) }
    var naming by remember { mutableStateOf(false) }
    var folderName by remember { mutableStateOf("") }
    var saved by remember { mutableStateOf<BookmarkLocation?>(null) }
    // Each time it opens: the page's title and address, and where it's saved now, or the space showing and its last folder.
    LaunchedEffect(visible) {
        if (!visible) return@LaunchedEffect
        url = browser.activeUrl
        saved = app.store.bookmarkLocation(url)
        title = saved?.title ?: browser.activeTab?.title?.ifEmpty { null } ?: siteName(url)
        space = saved?.spaceId ?: app.activeSpaceId
        folder = saved?.parentId ?: app.store.lastBookmarkFolder(space)
        naming = false
    }
    val close = { browser.panel = null }

    fun save() {
        val address = url.trim()
        if (address.isEmpty()) return
        val current = saved
        if (current != null && current.spaceId != space) app.dispatch(Action.RemoveBookmark(current.spaceId, current.id))
        if (current != null && current.spaceId == space) {
            app.dispatch(Action.MoveBookmark(space, current.id, folder, null))
            app.dispatch(Action.RenameBookmark(space, current.id, title, address))
        } else {
            val node = BookmarkNode.Url(UUID.randomUUID().toString(), folder, title.ifBlank { address }, address, AppModel.now())
            app.dispatch(Action.SaveBookmark(space, node))
        }
        Haptics.done(view)
        close()
        val chosen = app.spaces.firstOrNull { it.id == space }
        val folderTitle = app.store.bookmarkFolders(space).firstOrNull { it.id == folder && it.id != TOP }?.title
        val place = folderTitle ?: chosen?.let { spaceName(it, strings) }.orEmpty()
        val opened = folder
        browser.showTopNote(TopNote(System.nanoTime(), strings.t("save.addedTo", mapOf("place" to place)), chosen) { browser.openDrawer(opened) })
    }

    fun makeFolder() {
        val name = folderName.trim()
        naming = false
        folderName = ""
        if (name.isEmpty()) return
        val id = UUID.randomUUID().toString()
        app.dispatch(Action.AddBookmarks(space, listOf(BookmarkNode.Folder(id, TOP, name, emptyList(), AppModel.now()))))
        folder = id
    }

    val heading = strings.t("save.title")
    PanelSheet(
        visible,
        heading,
        "save-sheet",
        strings.sheetWords(heading),
        onClose = close,
        header = {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                SheetIconButton(BayIcon.CLOSE, strings.t("save.cancel"), Modifier.testTag("save-cancel"), onClick = close)
                BayText(heading, Modifier.weight(1f).semantics { heading() }, variant = TextVariant.HEADLINE, weight = FontWeight.SemiBold, maxLines = 1, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                Box(
                    Modifier.size(36.dp).testTag("save-done")
                        .clearAndSetSemantics { contentDescription = strings.t("save.done"); role = Role.Button }
                        .pressFeedback(onClick = ::save)
                        .background(Theme.colors.accentFill, CircleShape),
                    contentAlignment = Alignment.Center,
                ) { BayIconView(BayIcon.TICK, size = IconSize.small, color = Theme.colors.accentForeground) }
            }
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(Space.md)) {
            Field(title, { title = it }, strings.t("save.titleField"), "save-title", leading = { SiteIcon(app, url, 28.dp) })
            Field(url, { url = it }, strings.t("save.addressField"), "save-url", leading = { BayIconView(BayIcon.LINK, size = IconSize.row, color = Theme.colors.muted) }, address = true)
            SpaceChips(app.spaces, space, strings, onChoose = { id ->
                space = id
                folder = saved?.takeIf { it.spaceId == id }?.parentId ?: app.store.lastBookmarkFolder(id)
            }) {
                close()
                browser.newSpace()
            }
            RowGroup(strings.t("save.folders")) {
                app.store.bookmarkFolders(space).forEach { choice ->
                    val top = choice.id == TOP
                    Box(Modifier.padding(start = Space.lg * maxOf(0, choice.depth.toInt() - 1))) {
                        ActionRow(
                            if (top) strings.t("save.topOfList") else choice.title,
                            "save-folder-${choice.id}",
                            icon = if (top) BayIcon.BOOKMARK else BayIcon.FOLDER,
                            selected = choice.id == folder,
                        ) { folder = choice.id }
                    }
                }
                if (naming) {
                    Field(folderName, { folderName = it }, strings.t("save.folderName"), "save-folder-name", leading = { BayIconView(BayIcon.FOLDER, size = IconSize.control, color = Theme.colors.muted) }, onDone = ::makeFolder)
                } else {
                    ActionRow(strings.t("save.newFolder"), "save-new-folder", icon = BayIcon.ADD) { naming = true }
                }
            }
            val current = saved
            if (current != null) {
                RowGroup {
                    ActionRow(strings.t("pageMenu.removeBookmark"), "save-remove", icon = BayIcon.DELETE, destructive = true) {
                        app.dispatch(Action.RemoveBookmark(current.spaceId, current.id))
                        close()
                    }
                }
            }
        }
    }
}

/** A filled field, as Android draws one, with its icon at the start. */
@Composable
private fun Field(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    testID: String,
    leading: @Composable () -> Unit,
    address: Boolean = false,
    onDone: (() -> Unit)? = null,
) {
    val colors = Theme.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).background(colors.fill, RoundedCornerShape(12.dp)).padding(horizontal = Space.lg),
        horizontalArrangement = Arrangement.spacedBy(Space.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) { leading() }
        BasicTextField(
            value,
            onChange,
            Modifier.weight(1f).testTag(testID).semantics { contentDescription = placeholder },
            singleLine = true,
            textStyle = (if (address) TextVariant.SUBHEAD else TextVariant.BODY).style(FontWeight.Normal, if (address) colors.muted else colors.foreground),
            cursorBrush = SolidColor(colors.accent),
            keyboardOptions = KeyboardOptions(
                keyboardType = if (address) KeyboardType.Uri else KeyboardType.Text,
                imeAction = ImeAction.Done,
                autoCorrectEnabled = !address,
            ),
            keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty()) BayText(placeholder, variant = TextVariant.BODY, color = colors.muted, maxLines = 1)
                    inner()
                }
            },
        )
    }
}

/** How much of the screen the drawer's panel covers; the rest is the page's sliver. */
private const val DRAWER_WIDTH = 0.86f

/**
 * The bookmarks drawer: a dark panel the height of the screen sliding out over the page from the right, a sliver of the
 * page still showing at its left. On top, the space chips; below, the space's bookmarks, folders opening where they
 * sit; a + at its foot to save the page here. Its wash is the space's colour. A sideways swipe moves to the next space
 * (switching to it); a tap on the sliver, or Back, puts it away.
 */
@Composable
fun BookmarksDrawer(browser: BrowserModel, strings: Strings) {
    val app = browser.app
    var open by remember { mutableStateOf(setOfNotNull(browser.drawerFolder)) }
    var swipe by remember { mutableStateOf(0f) }
    androidx.activity.compose.BackHandler(onBack = browser::closeDrawer)
    val space = app.spaces.firstOrNull { it.id == app.activeSpaceId } ?: app.spaces.firstOrNull()
    val color = space?.let { spaceColor(it.color) } ?: Theme.colors.muted
    val wash by androidx.compose.animation.animateColorAsState(color, label = "drawer-wash")
    val rows = app.store.bookmarkTreeRows(app.activeSpaceId, open.toList())
    Row(Modifier.fillMaxSize().testTag("bookmarks-drawer")) {
        Box(
            Modifier.weight(1f - DRAWER_WIDTH).fillMaxHeight().background(Color.Black.copy(alpha = 0.35f)).testTag("drawer-close")
                .clearAndSetSemantics { contentDescription = strings.t("drawer.close"); role = Role.Button }
                .pressFeedback(onClick = browser::closeDrawer),
        )
        bay.design.BayTheme(dark = true) {
            Box(
                Modifier.weight(DRAWER_WIDTH).fillMaxHeight()
                    .background(Color(0xFF101012))
                    .background(androidx.compose.ui.graphics.Brush.verticalGradient(listOf(wash.copy(alpha = 0.45f), wash.copy(alpha = 0.12f), Color.Transparent)))
                    .pointerInput(app.activeSpaceId) {
                        detectHorizontalDragGestures(
                            onDragEnd = {
                                val index = app.spaces.indexOfFirst { it.id == app.activeSpaceId }
                                val next = index + if (swipe < 0) 1 else -1
                                if (kotlin.math.abs(swipe) > 80.dp.toPx() && next in app.spaces.indices) {
                                    open = emptySet()
                                    browser.switchSpace(app.spaces[next].id, announce = false)
                                }
                                swipe = 0f
                            },
                            onDragCancel = { swipe = 0f },
                            onHorizontalDrag = { _, amount -> swipe += amount },
                        )
                    }
                    .statusBarsPadding().navigationBarsPadding(),
            ) {
                Column(Modifier.fillMaxSize().padding(top = Space.sm), verticalArrangement = Arrangement.spacedBy(Space.md)) {
                    Box(Modifier.padding(horizontal = Space.lg)) {
                        SpaceChips(app.spaces, app.activeSpaceId, strings, onChoose = { browser.switchSpace(it, announce = false) })
                    }
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = Space.sm).padding(bottom = 80.dp)) {
                        if (rows.isEmpty() && space != null) {
                            Column(Modifier.padding(Space.lg), verticalArrangement = Arrangement.spacedBy(Space.md)) {
                                BayText(strings.t("drawer.empty", mapOf("space" to spaceName(space, strings))), variant = TextVariant.CALLOUT, color = Theme.colors.muted)
                                bay.design.PillButton(strings.t("drawer.saveHere"), Modifier.testTag("drawer-empty-save")) {
                                    browser.closeDrawer()
                                    browser.panel = Panel.SAVE
                                }
                            }
                        }
                        rows.forEach { row ->
                            DrawerRow(app, strings, row, row.url == browser.activeUrl, row.id in open,
                                onTap = {
                                    if (row.folder) {
                                        open = if (row.id in open) open - row.id else open + row.id
                                    } else {
                                        browser.closeDrawer()
                                        browser.open(OpenTarget.Url(row.url), false)
                                    }
                                },
                                onRemove = { app.dispatch(Action.RemoveBookmark(app.activeSpaceId, row.id)) },
                                onShare = { browser.share(row.url) },
                            )
                        }
                    }
                }
                Box(
                    Modifier.align(Alignment.BottomEnd).padding(Space.lg).size(52.dp).testTag("drawer-add")
                        .clearAndSetSemantics { contentDescription = strings.t("drawer.saveHere"); role = Role.Button }
                        .pressFeedback {
                            browser.closeDrawer()
                            browser.panel = Panel.SAVE
                        }
                        .background(Theme.colors.fill, CircleShape),
                    contentAlignment = Alignment.Center,
                ) { BayIconView(BayIcon.ADD, size = IconSize.control) }
            }
        }
    }
}

/**
 * One row of the drawer: a folder with its count, turning to show it's open, or a link with its site's icon. The page
 * showing sits on a light wash. Holding a row offers sharing a link and removing either.
 */
@Composable
private fun DrawerRow(
    app: AppModel,
    strings: Strings,
    row: bay.core.BookmarkTreeRow,
    current: Boolean,
    open: Boolean,
    onTap: () -> Unit,
    onRemove: () -> Unit,
    onShare: () -> Unit,
) {
    val colors = Theme.colors
    var menu by remember { mutableStateOf(false) }
    val title = row.title.ifEmpty { displayUrl(row.url) }
    val label = if (row.folder) {
        "$title, ${if (row.links.toInt() == 1) strings.t("drawer.linksOne") else strings.t("drawer.links", mapOf("count" to "${row.links}"))}"
    } else {
        title
    }
    Box {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("drawer-row-${row.id}")
                .clip(RoundedCornerShape(12.dp))
                .background(if (current) Color.White.copy(alpha = 0.1f) else Color.Transparent)
                .semantics(mergeDescendants = true) {
                    contentDescription = label
                    role = Role.Button
                }
                .combinedClickable(onLongClick = { menu = true }, onClick = onTap)
                .padding(start = Space.md + Space.lg * row.depth.toInt(), end = Space.md),
            horizontalArrangement = Arrangement.spacedBy(Space.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (row.folder) {
                BayIconView(BayIcon.FOLDER, size = IconSize.row, color = colors.foreground)
            } else {
                SiteIcon(app, row.url, 24.dp, bare = true)
            }
            BayText(title, Modifier.weight(1f), weight = if (row.folder) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1)
            if (row.folder) {
                if (row.links > 0u) BayText("${row.links}", variant = TextVariant.FOOTNOTE, color = colors.muted)
                BayIconView(BayIcon.CHEVRON, size = IconSize.inline, color = colors.muted, modifier = Modifier.graphicsLayer { rotationZ = if (open) 90f else 0f })
            }
        }
        if (menu) {
            androidx.compose.ui.window.Popup(alignment = Alignment.TopEnd, onDismissRequest = { menu = false }, properties = androidx.compose.ui.window.PopupProperties(focusable = true)) {
                Column(Modifier.width(200.dp).background(colors.surface, RoundedCornerShape(12.dp)).padding(vertical = Space.xs)) {
                    if (!row.folder) MenuChoice(strings.t("drawer.share")) { menu = false; onShare() }
                    MenuChoice(strings.t("drawer.remove"), destructive = true) { menu = false; onRemove() }
                }
            }
        }
    }
}

@Composable
private fun MenuChoice(label: String, destructive: Boolean = false, onClick: () -> Unit) {
    BayText(
        label,
        Modifier.fillMaxWidth().heightIn(min = 44.dp).pressFeedback(onClick = onClick).padding(horizontal = Space.lg, vertical = Space.md),
        color = if (destructive) Theme.colors.danger else Theme.colors.foreground,
        maxLines = 1,
    )
}
