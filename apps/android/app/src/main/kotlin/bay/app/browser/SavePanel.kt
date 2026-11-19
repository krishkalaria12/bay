package bay.app.browser

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
        browser.showTopNote(TopNote(System.nanoTime(), strings.t("save.addedTo", mapOf("place" to place)), chosen) { browser.panel = Panel.BOOKMARKS })
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
