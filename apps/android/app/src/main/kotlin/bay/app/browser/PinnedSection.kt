package bay.app.browser

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import androidx.compose.ui.zIndex
import bay.app.Strings
import bay.core.BrowserFolder
import bay.core.PinKind
import bay.core.PinnedSite
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.Haptics
import bay.design.IconSize
import bay.design.Radius
import bay.design.Space
import bay.design.TextVariant
import bay.design.Theme
import bay.design.overWallpaper
import bay.design.pressFeedback
import bay.design.style

/** What the Pinned section's name field is for: a new folder, or one being renamed where it sits. */
sealed interface FolderNaming {
    data object New : FolderNaming

    data class Rename(val id: String) : FolderNaming
}

/** A pinned row being dragged: which, how far it has come, what it's over ("top", "folder:<id>", "pin:<id>"), and where everything sits in the window. */
private class PinDrag {
    var id by mutableStateOf<String?>(null)
    var offset by mutableFloatStateOf(0f)
    var target by mutableStateOf<String?>(null)
    val frames = mutableMapOf<String, Rect>()
}

/**
 * The pinned rows, loose ones first and then the folders, under "Pinned" with a + for a new folder. Holding a row lifts
 * it to drag into a folder, out of one (onto "Pinned"), or beside another; let go where it was, its actions are offered.
 * Holding a folder offers Rename and Delete.
 */
@Composable
fun PinnedSection(browser: BrowserModel, strings: Strings, rows: List<PinnedSite>, activeUrl: String?, naming: FolderNaming?, onNaming: (FolderNaming?) -> Unit) {
    val app = browser.app
    val view = LocalView.current
    val colors = Theme.colors
    val toggles = remember { mutableStateMapOf<String, Boolean>() }
    val drag = remember { PinDrag() }
    val loose = rows.filter { it.folderId == null }
    val folders = app.folders.map { folder -> folder to rows.filter { it.folderId == folder.id } }
    fun isOpen(id: String, inside: List<PinnedSite>) = toggles[id] ?: inside.any { it.url == activeUrl }
    val visible = loose.map { it.id } + folders.flatMap { (folder, inside) -> if (isOpen(folder.id, inside)) inside.map { it.id } else emptyList() }

    // A dragged row let go over a target: onto "Pinned" it comes out of its folder, onto a folder it goes in, onto
    // another row it goes beside it, in that row's folder (after it when dragged down to it).
    fun drop(row: PinnedSite, target: String) {
        when {
            target == "top" -> browser.movePin(row, PinKind.ROW, null)
            target.startsWith("folder:") -> {
                val id = target.removePrefix("folder:")
                browser.movePin(row, PinKind.ROW, id)
                toggles[id] = true
            }
            target.startsWith("pin:") -> {
                val id = target.removePrefix("pin:")
                val beside = app.pins.firstOrNull { it.id == id } ?: return
                browser.movePin(row, PinKind.ROW, beside.folderId, id, visible.indexOf(row.id) < visible.indexOf(id))
            }
        }
        Haptics.tick(view)
    }

    @Composable
    fun pinRow(row: PinnedSite, indent: Boolean) = key(row.id) {
        PinRow(browser, strings, row, row.url == activeUrl, indent, drag, onDrop = ::drop, onFolderOpened = { toggles[it] = true })
    }

    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(
            Modifier.fillMaxWidth().onGloballyPositioned { drag.frames["top"] = it.boundsInWindow() }
                .background(colors.accent.copy(alpha = if (drag.target == "top") 0.25f else 0f), RoundedCornerShape(Radius.control))
                .padding(start = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BayText(strings.t("tabs.pinned"), Modifier.weight(1f), variant = TextVariant.FOOTNOTE, weight = FontWeight.Medium, color = colors.overWallpaper)
            Box(
                Modifier.size(48.dp, 36.dp).testTag("tab-pinned-new-folder")
                    .clearAndSetSemantics { contentDescription = strings.t("tabs.newFolder"); role = Role.Button }
                    .pressFeedback {
                        Haptics.press(view)
                        onNaming(FolderNaming.New)
                    },
                contentAlignment = Alignment.Center,
            ) { BayIconView(BayIcon.ADD, size = IconSize.inline, color = colors.muted) }
        }
        loose.forEach { pinRow(it, indent = false) }
        folders.forEach { (folder, inside) ->
            key(folder.id) {
                if (naming == FolderNaming.Rename(folder.id)) {
                    FolderNameField(folder.name, strings.t("tabs.folderName")) { name ->
                        onNaming(null)
                        if (name != null && name != folder.name) browser.renameFolder(folder.id, name)
                    }
                } else {
                    FolderRow(browser, strings, folder, inside.size, isOpen(folder.id, inside), drag.target == "folder:${folder.id}", { toggles[folder.id] = !isOpen(folder.id, inside) }, { onNaming(FolderNaming.Rename(folder.id)) }) {
                        drag.frames["folder:${folder.id}"] = it
                    }
                }
            }
            if (isOpen(folder.id, inside)) inside.forEach { pinRow(it, indent = true) }
        }
        if (naming == FolderNaming.New) {
            FolderNameField("", strings.t("tabs.folderName")) { name ->
                onNaming(null)
                if (name != null) browser.newFolder(name)
            }
        }
    }
}

/** A pinned folder: a row that opens to show the pinned rows in it, as the desktop's Pinned folders do; held, Rename and Delete. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FolderRow(browser: BrowserModel, strings: Strings, folder: BrowserFolder, count: Int, open: Boolean, targeted: Boolean, onToggle: () -> Unit, onRename: () -> Unit, onPlaced: (Rect) -> Unit) {
    val view = LocalView.current
    val colors = Theme.colors
    var menu by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.fillMaxWidth().testTag("tab-folder-${folder.id}")
                .onGloballyPositioned { onPlaced(it.boundsInWindow()) }
                .semantics(mergeDescendants = true) {
                    stateDescription = if (open) "expanded" else "collapsed"
                    customActions = listOf(
                        CustomAccessibilityAction(strings.t("tabs.renameFolder")) { onRename(); true },
                        CustomAccessibilityAction(strings.t("tabs.deleteFolder")) { browser.deleteFolder(folder.id); true },
                    )
                }
                .combinedClickable(remember { MutableInteractionSource() }, null, onLongClick = {
                    Haptics.tick(view)
                    menu = true
                }, onClick = onToggle)
                .background(colors.accent.copy(alpha = if (targeted) 0.25f else 0f), RoundedCornerShape(Radius.control))
                .heightIn(min = 40.dp).padding(horizontal = Space.sm),
            horizontalArrangement = Arrangement.spacedBy(Space.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BayIconView(BayIcon.FOLDER, size = IconSize.small)
            BayText(folder.name, Modifier.weight(1f), variant = TextVariant.CALLOUT, maxLines = 1)
            if (count > 0) BayText("$count", variant = TextVariant.FOOTNOTE, color = colors.overWallpaper)
            BayIconView(BayIcon.CHEVRON, Modifier.graphicsLayer { rotationZ = if (open) 90f else 0f }, size = IconSize.inline, color = colors.muted)
        }
        if (menu) {
            HoldMenu(onDismiss = { menu = false }) {
                MenuChoice(strings.t("tabs.renameFolder")) { menu = false; onRename() }
                MenuChoice(strings.t("tabs.deleteFolder"), destructive = true) { menu = false; browser.deleteFolder(folder.id) }
            }
        }
    }
}

/**
 * A pinned row: its site's icon and name. A tap opens its tab; held, it lifts and follows the finger and lands where
 * it's let go; held and let go without moving, its menu opens (into or out of a folder, Unpin).
 */
@Composable
private fun PinRow(browser: BrowserModel, strings: Strings, row: PinnedSite, active: Boolean, indent: Boolean, drag: PinDrag, onDrop: (PinnedSite, String) -> Unit, onFolderOpened: (String) -> Unit) {
    val app = browser.app
    val view = LocalView.current
    val colors = Theme.colors
    var menu by remember { mutableStateOf(false) }
    val lifted = drag.id == row.id
    val key = "pin:${row.id}"
    val title = row.title.ifEmpty { displayUrl(row.url) }
    Box(Modifier.zIndex(if (lifted) 1f else 0f).graphicsLayer { translationY = if (lifted) drag.offset else 0f }) {
        Row(
            Modifier.fillMaxWidth().testTag("tab-pinned-${row.id}")
                .onGloballyPositioned { if (!lifted) drag.frames[key] = it.boundsInWindow() }
                .semantics(mergeDescendants = true) {
                    contentDescription = title
                    role = Role.Button
                    selected = active
                    onClick { browser.openPin(row); true }
                    customActions = listOf(CustomAccessibilityAction(strings.t("pin.unpin")) { browser.unpin(row); true })
                }
                .pointerInput(row.id) {
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        var cancelled = false
                        val up = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                            waitForUpOrCancellation().also { if (it == null) cancelled = true }
                        }
                        when {
                            up != null -> {
                                up.consume()
                                browser.openPin(row)
                            }
                            cancelled -> {}
                            else -> {
                                Haptics.tick(view)
                                val start = (drag.frames[key]?.topLeft ?: Offset.Zero) + down.position
                                var moved = 0f
                                drag.id = row.id
                                drag.offset = 0f
                                drag(down.id) { change ->
                                    val dy = change.positionChange().y
                                    change.consume()
                                    moved += kotlin.math.abs(dy)
                                    drag.offset += dy
                                    val y = start.y + drag.offset
                                    val over = drag.frames.entries.firstOrNull { it.key != key && y >= it.value.top && y < it.value.bottom }?.key
                                    if (over != drag.target) {
                                        drag.target = over
                                        if (over != null) Haptics.press(view)
                                    }
                                }
                                val target = drag.target
                                drag.id = null
                                drag.offset = 0f
                                drag.target = null
                                if (moved < 8.dp.toPx()) menu = true else if (target != null) onDrop(row, target)
                            }
                        }
                    }
                }
                .background(
                    when {
                        drag.target == key -> colors.accent.copy(alpha = 0.25f)
                        lifted || active -> colors.fill
                        else -> Color.Transparent
                    },
                    RoundedCornerShape(Radius.control),
                )
                .heightIn(min = 40.dp).padding(start = if (indent) Space.xl + Space.sm else Space.sm, end = Space.sm),
            horizontalArrangement = Arrangement.spacedBy(Space.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SiteIcon(app, row.url, 20.dp)
            BayText(title, Modifier.weight(1f), variant = TextVariant.CALLOUT, weight = if (active) FontWeight.SemiBold else null, maxLines = 1)
        }
        if (menu) {
            HoldMenu(onDismiss = { menu = false }) {
                app.folders.firstOrNull { it.id == row.folderId }?.let { folder ->
                    MenuChoice(strings.t("pin.takeOut", mapOf("folder" to folder.name))) { menu = false; browser.movePin(row, PinKind.ROW, null) }
                }
                app.folders.filter { it.id != row.folderId }.forEach { folder ->
                    MenuChoice(strings.t("pin.moveTo", mapOf("folder" to folder.name))) {
                        menu = false
                        browser.movePin(row, PinKind.ROW, folder.id)
                        onFolderOpened(folder.id)
                    }
                }
                MenuChoice(strings.t("pin.unpin"), destructive = true) { menu = false; browser.unpin(row) }
            }
        }
    }
}

/** The small menu a held row opens beside itself, as the bookmarks drawer's rows do. */
@Composable
fun HoldMenu(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    Popup(alignment = Alignment.TopEnd, onDismissRequest = onDismiss, properties = PopupProperties(focusable = true)) {
        Column(Modifier.width(220.dp).background(Theme.colors.surface, RoundedCornerShape(12.dp)).padding(vertical = Space.xs).testTag("hold-menu")) { content() }
    }
}

/** A folder's name typed where the folder sits: Done or leaving the field keeps it; left empty, nothing changes (null). */
@Composable
fun FolderNameField(name: String, placeholder: String, onDone: (String?) -> Unit) {
    val colors = Theme.colors
    val focus = remember { FocusRequester() }
    // The cursor starts after the name, to add to it or delete back from it.
    var text by remember { mutableStateOf(androidx.compose.ui.text.input.TextFieldValue(name, androidx.compose.ui.text.TextRange(name.length))) }
    var done by remember { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    fun finish() {
        if (done) return
        done = true
        onDone(text.text.trim().ifEmpty { null })
    }
    LaunchedEffect(Unit) { focus.requestFocus() }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 40.dp).background(colors.fill, RoundedCornerShape(Radius.control)).padding(horizontal = Space.sm),
        horizontalArrangement = Arrangement.spacedBy(Space.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BayIconView(BayIcon.FOLDER, size = IconSize.small, color = colors.muted)
        Box(Modifier.weight(1f)) {
            if (text.text.isEmpty()) BayText(placeholder, variant = TextVariant.CALLOUT, color = colors.muted, maxLines = 1)
            BasicTextField(
                text,
                { text = it },
                Modifier.fillMaxWidth().focusRequester(focus).testTag("tab-folder-name")
                    .onFocusChanged {
                        if (focused && !it.isFocused) finish()
                        focused = it.isFocused
                    }
                    .semantics { contentDescription = placeholder },
                singleLine = true,
                textStyle = TextVariant.CALLOUT.style(color = colors.foreground),
                cursorBrush = SolidColor(colors.accent),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { finish() }),
            )
        }
    }
}
