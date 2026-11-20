package bay.app.browser

import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.zIndex
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.focus.focusRequester
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
    /** Takes the keyboard as it appears. */
    focus: Boolean = false,
) {
    val colors = Theme.colors
    val focuser = remember { androidx.compose.ui.focus.FocusRequester() }
    if (focus) LaunchedEffect(Unit) { runCatching { focuser.requestFocus() } }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).background(colors.fill, RoundedCornerShape(12.dp)).padding(horizontal = Space.lg),
        horizontalArrangement = Arrangement.spacedBy(Space.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) { leading() }
        BasicTextField(
            value,
            onChange,
            Modifier.weight(1f).focusRequester(focuser).testTag(testID).semantics { contentDescription = placeholder },
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
    // Over the list: a row being renamed or moved.
    var edit by remember { mutableStateOf<DrawerEdit?>(null) }
    // The search field, shown once the list is pulled down at its top; null while hidden.
    var query by remember { mutableStateOf<String?>(null) }
    // Each row's top and bottom in the list, and the row being dragged to a new place with how far it has gone.
    val bounds = remember { mutableStateMapOf<String, Pair<Float, Float>>() }
    var dragging by remember { mutableStateOf<String?>(null) }
    var dragged by remember { mutableStateOf(0f) }
    androidx.activity.compose.BackHandler {
        when {
            edit != null -> edit = null
            query != null -> query = null
            else -> browser.closeDrawer()
        }
    }
    val space = app.spaces.firstOrNull { it.id == app.activeSpaceId } ?: app.spaces.firstOrNull()
    val color = space?.let { spaceColor(it.color) } ?: Theme.colors.muted
    val wash by androidx.compose.animation.animateColorAsState(color, label = "drawer-wash")
    val searching = !query.isNullOrBlank()
    // Read from the store, so they follow its revision: a move, rename or removal redraws them.
    @Suppress("UNUSED_VARIABLE") val revision = app.revision
    val rows = if (searching) {
        app.store.bookmarkListing(app.activeSpaceId, BOOKMARKS_TOP, query.orEmpty()).rows.mapNotNull { found ->
            (found.node as? bay.core.BookmarkNode.Url)?.let { bay.core.BookmarkTreeRow(it.id, false, it.title, it.url, 0u, 0u, false) }
        }
    } else {
        app.store.bookmarkTreeRows(app.activeSpaceId, open.toList())
    }
    val pullToSearch = with(androidx.compose.ui.platform.LocalDensity.current) { 64.dp.toPx() }
    val pull = remember {
        object : androidx.compose.ui.input.nestedscroll.NestedScrollConnection {
            var pulled = 0f

            override fun onPostScroll(
                consumed: androidx.compose.ui.geometry.Offset,
                available: androidx.compose.ui.geometry.Offset,
                source: androidx.compose.ui.input.nestedscroll.NestedScrollSource,
            ): androidx.compose.ui.geometry.Offset {
                if (available.y > 0 && source == androidx.compose.ui.input.nestedscroll.NestedScrollSource.UserInput) {
                    pulled += available.y
                    if (pulled > pullToSearch && query == null) query = ""
                } else if (consumed.y < 0) {
                    pulled = 0f
                }
                return androidx.compose.ui.geometry.Offset.Zero
            }

            override suspend fun onPreFling(available: androidx.compose.ui.unit.Velocity): androidx.compose.ui.unit.Velocity {
                pulled = 0f
                return androidx.compose.ui.unit.Velocity.Zero
            }
        }
    }

    /** Puts the dragged row where it was let go: into a folder dropped on its middle, else beside the row under it. */
    fun drop(id: String) {
        val (top, bottom) = bounds[id] ?: return
        val center = (top + bottom) / 2 + dragged
        val target = rows.firstOrNull { row -> row.id != id && bounds[row.id]?.let { center >= it.first && center < it.second } == true } ?: return
        val (targetTop, targetBottom) = bounds.getValue(target.id)
        val third = (targetBottom - targetTop) / 3
        val place = if (target.folder && center > targetTop + third && center < targetBottom - third) {
            bay.core.BookmarkDrop(target.id, null)
        } else {
            app.store.bookmarkDrop(app.activeSpaceId, id, target.id, center > (targetTop + targetBottom) / 2) ?: return
        }
        app.dispatch(Action.MoveBookmark(app.activeSpaceId, id, place.parentId, place.index))
    }

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
                                    query = null
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
                        SpaceChips(app.spaces, app.activeSpaceId, strings, onChoose = {
                            query = null
                            browser.switchSpace(it, announce = false)
                        })
                    }
                    query?.let { text ->
                        Row(Modifier.padding(horizontal = Space.lg), horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.weight(1f)) {
                                Field(text, { query = it }, strings.t("bookmarks.search"), "drawer-search", leading = {
                                    BayIconView(BayIcon.SEARCH, size = IconSize.row, color = Theme.colors.muted)
                                }, focus = true)
                            }
                            Box(
                                Modifier.size(40.dp).testTag("drawer-search-close")
                                    .clearAndSetSemantics { contentDescription = strings.t("save.cancel"); role = Role.Button }
                                    .pressFeedback { query = null },
                                contentAlignment = Alignment.Center,
                            ) { BayIconView(BayIcon.CLOSE, size = IconSize.small, color = Theme.colors.muted) }
                        }
                    }
                    Column(
                        Modifier.weight(1f).nestedScroll(pull).verticalScroll(rememberScrollState())
                            .padding(horizontal = Space.sm).padding(bottom = 80.dp),
                    ) {
                        if (rows.isEmpty() && space != null && !searching) {
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
                                offset = if (dragging == row.id) dragged else 0f,
                                canDrag = !searching,
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
                                onRename = { edit = DrawerEdit.Rename(row) },
                                onMove = { edit = DrawerEdit.Move(row) },
                                onPlaced = { top, bottom -> bounds[row.id] = top to bottom },
                                onDragStart = { dragging = row.id; dragged = 0f },
                                onDrag = { dragged += it },
                                onDragEnd = {
                                    drop(row.id)
                                    dragging = null
                                    dragged = 0f
                                },
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
                when (val editing = edit) {
                    is DrawerEdit.Rename -> DrawerRename(app, strings, editing.row, onCancel = { edit = null }) { title, url ->
                        app.dispatch(Action.RenameBookmark(app.activeSpaceId, editing.row.id, title, url))
                        edit = null
                    }
                    is DrawerEdit.Move -> DrawerMove(app, strings, editing.row, onCancel = { edit = null }) { folder ->
                        app.dispatch(Action.MoveBookmark(app.activeSpaceId, editing.row.id, folder, null))
                        open = open + folder
                        edit = null
                    }
                    null -> {}
                }
            }
        }
    }
}

/** The drawer's top folder, as the core names it. */
private const val BOOKMARKS_TOP = "bookmarks"

/** What the drawer has open over its list: a row being renamed, or being moved to another folder. */
private sealed interface DrawerEdit {
    data class Rename(val row: bay.core.BookmarkTreeRow) : DrawerEdit

    data class Move(val row: bay.core.BookmarkTreeRow) : DrawerEdit
}

/** A card over the drawer's list, on a dim, closing when the dim is tapped. */
@Composable
private fun DrawerCard(testID: String, onCancel: () -> Unit, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Box(
        Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.45f))
            .pointerInput(Unit) { detectTapGestures { onCancel() } },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier.padding(Space.lg).fillMaxWidth().background(Theme.colors.surface, RoundedCornerShape(20.dp))
                .pointerInput(Unit) { detectTapGestures {} }
                .padding(Space.lg).testTag(testID),
            verticalArrangement = Arrangement.spacedBy(Space.md),
            content = content,
        )
    }
}

/** A bookmark's title and address, or a folder's name, changed in place. */
@Composable
private fun DrawerRename(app: AppModel, strings: Strings, row: bay.core.BookmarkTreeRow, onCancel: () -> Unit, onSave: (String, String?) -> Unit) {
    var title by remember(row.id) { mutableStateOf(row.title) }
    var url by remember(row.id) { mutableStateOf(row.url) }
    val save = { onSave(title, if (row.folder) null else url) }
    DrawerCard("drawer-rename", onCancel) {
        BayText(strings.t("drawer.rename"), variant = TextVariant.HEADLINE)
        Field(title, { title = it }, strings.t(if (row.folder) "save.folderName" else "save.titleField"), "drawer-rename-title", leading = {
            if (row.folder) BayIconView(BayIcon.FOLDER, size = IconSize.control, color = Theme.colors.muted) else SiteIcon(app, row.url, 28.dp)
        }, focus = true, onDone = if (row.folder) save else null)
        if (!row.folder) {
            Field(url, { url = it }, strings.t("save.addressField"), "drawer-rename-url", leading = {
                BayIconView(BayIcon.LINK, size = IconSize.row, color = Theme.colors.muted)
            }, address = true, onDone = save)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm, Alignment.End)) {
            bay.design.PillButton(strings.t("save.cancel"), Modifier.testTag("drawer-rename-cancel"), compact = true, onClick = onCancel)
            bay.design.PillButton(strings.t("save.done"), Modifier.testTag("drawer-rename-save"), compact = true, enabled = title.isNotBlank(), onClick = save)
        }
    }
}

/** The space's folders to move a row into, indented as they nest; a folder can't go into itself or its own. */
@Composable
private fun DrawerMove(app: AppModel, strings: Strings, row: bay.core.BookmarkTreeRow, onCancel: () -> Unit, onMove: (String) -> Unit) {
    val folders = app.store.bookmarkFolders(app.activeSpaceId)
    // A folder's own folders follow it one step deeper, up to the next at its depth or above.
    val inside = HashSet<String>()
    if (row.folder) {
        var depth: UInt? = null
        for (folder in folders) {
            val at = depth
            if (folder.id == row.id) {
                depth = folder.depth
                inside += folder.id
            } else if (at != null && folder.depth > at) {
                inside += folder.id
            } else {
                depth = null
            }
        }
    }
    DrawerCard("drawer-move", onCancel) {
        BayText(strings.t("drawer.moveTitle"), variant = TextVariant.HEADLINE)
        Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
            folders.filter { it.id !in inside }.forEach { folder ->
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 44.dp).testTag("drawer-move-${folder.id}")
                        .pressFeedback { onMove(folder.id) }
                        .padding(start = Space.sm + Space.lg * folder.depth.toInt(), end = Space.sm),
                    horizontalArrangement = Arrangement.spacedBy(Space.md),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    BayIconView(BayIcon.FOLDER, size = IconSize.row, color = Theme.colors.foreground)
                    BayText(folder.title.ifEmpty { strings.t("save.topOfList") }, Modifier.weight(1f), maxLines = 1)
                }
            }
        }
    }
}

/**
 * One row of the drawer: a folder with its count, turning to show it's open, or a link with its site's icon. The page
 * showing sits on a light wash. Holding a row picks it up to drag it to a new place; let go where it was, it offers
 * sharing a link, renaming, moving and removing.
 */
@Composable
private fun DrawerRow(
    app: AppModel,
    strings: Strings,
    row: bay.core.BookmarkTreeRow,
    current: Boolean,
    open: Boolean,
    offset: Float,
    canDrag: Boolean,
    onTap: () -> Unit,
    onRemove: () -> Unit,
    onShare: () -> Unit,
    onRename: () -> Unit,
    onMove: () -> Unit,
    onPlaced: (Float, Float) -> Unit,
    onDragStart: () -> Unit,
    onDrag: (Float) -> Unit,
    onDragEnd: () -> Unit,
) {
    val colors = Theme.colors
    var menu by remember { mutableStateOf(false) }
    val lifted = offset != 0f
    val title = row.title.ifEmpty { displayUrl(row.url) }
    val label = if (row.folder) {
        "$title, ${if (row.links.toInt() == 1) strings.t("drawer.linksOne") else strings.t("drawer.links", mapOf("count" to "${row.links}"))}"
    } else {
        title
    }
    val view = androidx.compose.ui.platform.LocalView.current
    Box(
        Modifier.zIndex(if (lifted) 1f else 0f)
            .onGloballyPositioned { coordinates ->
                val top = coordinates.positionInParent().y
                onPlaced(top, top + coordinates.size.height)
            }
            .graphicsLayer { translationY = offset },
    ) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("drawer-row-${row.id}")
                .clip(RoundedCornerShape(12.dp))
                .background(
                    when {
                        lifted -> Color.White.copy(alpha = 0.16f)
                        current -> Color.White.copy(alpha = 0.1f)
                        else -> Color.Transparent
                    },
                )
                .semantics(mergeDescendants = true) {
                    contentDescription = label
                    role = Role.Button
                    onClick { onTap(); true }
                    customActions = listOf(
                        androidx.compose.ui.semantics.CustomAccessibilityAction(strings.t("drawer.rename")) { onRename(); true },
                        androidx.compose.ui.semantics.CustomAccessibilityAction(strings.t("drawer.move")) { onMove(); true },
                        androidx.compose.ui.semantics.CustomAccessibilityAction(strings.t("drawer.remove")) { onRemove(); true },
                    )
                }
                // One gesture for all three: a tap opens the row; held, it lifts, follows the finger and lands where
                // it's let go; held and let go without moving, its menu opens.
                .pointerInput(row.id, canDrag) {
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        var cancelled = false
                        val up = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                            waitForUpOrCancellation().also { if (it == null) cancelled = true }
                        }
                        when {
                            up != null -> {
                                up.consume()
                                onTap()
                            }
                            cancelled -> {}
                            else -> {
                                view.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
                                if (canDrag) onDragStart()
                                var moved = 0f
                                drag(down.id) { change ->
                                    val dy = change.positionChange().y
                                    moved += kotlin.math.abs(dy)
                                    change.consume()
                                    if (canDrag) onDrag(dy)
                                }
                                if (moved < 8.dp.toPx()) menu = true
                                if (canDrag) onDragEnd()
                            }
                        }
                    }
                }
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
                    MenuChoice(strings.t("drawer.rename")) { menu = false; onRename() }
                    MenuChoice(strings.t("drawer.move")) { menu = false; onMove() }
                    MenuChoice(strings.t("drawer.remove"), destructive = true) { menu = false; onRemove() }
                }
            }
        }
    }
}

@Composable
internal fun MenuChoice(label: String, destructive: Boolean = false, onClick: () -> Unit) {
    BayText(
        label,
        Modifier.fillMaxWidth().heightIn(min = 44.dp).pressFeedback(onClick = onClick).padding(horizontal = Space.lg, vertical = Space.md),
        color = if (destructive) Theme.colors.danger else Theme.colors.foreground,
        maxLines = 1,
    )
}
