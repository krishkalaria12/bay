package bay.app.browser

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import bay.app.Strings
import bay.core.BrowserTab
import bay.core.PinKind
import bay.design.ActionRow
import bay.design.BayIcon
import bay.design.PanelSheet
import bay.design.RowDivider
import bay.design.RowGroup
import bay.design.Space
import bay.design.TextVariant
import bay.design.Theme
import bay.design.style

private enum class MenuPage { MAIN, MOVE, NEW_FOLDER, RENAME_FOLDER }

/** Holding the Tabs button: quick tab actions, the spaces and the space's folders, without opening the switcher. */
@Composable
fun TabsMenu(browser: BrowserModel, strings: Strings, visible: Boolean) {
    val app = browser.app
    var page by remember(visible) { mutableStateOf(MenuPage.MAIN) }
    var name by remember(visible) { mutableStateOf("") }
    val close = { browser.panel = null }
    val act = { action: () -> Unit ->
        {
            close()
            action()
        }
    }
    val selected = browser.activeFolderId
    val startNaming = { next: MenuPage ->
        name = if (next == MenuPage.RENAME_FOLDER) app.folders.firstOrNull { it.id == selected }?.name.orEmpty() else ""
        page = next
    }
    when (page) {
        MenuPage.MAIN -> {
            val title = strings.t("tabsMenu.title")
            val count = browser.switcherTabs.size
            PanelSheet(visible, title, "tabs-menu", strings.sheetWords(title), close, maxFraction = 0.85f) {
                RowGroup {
                    ActionRow(strings.t("tabsMenu.newTab"), "tabs-menu-new", icon = BayIcon.ADD, onClick = act { browser.search(true) })
                    RowDivider()
                    ActionRow(strings.t("tabsMenu.newPrivateTab"), "tabs-menu-private", icon = BayIcon.PRIVATE, onClick = act { browser.search(true, privately = true) })
                    RowDivider()
                    ActionRow(strings.t("tabsMenu.archiveTab"), "tabs-menu-archive", icon = BayIcon.ARCHIVE, onClick = act { browser.archive(app.activeTabId) })
                    if (count > 1) {
                        RowDivider()
                        ActionRow(
                            strings.t("tabsMenu.archiveAll", mapOf("count" to "$count")), "tabs-menu-archive-all", icon = BayIcon.ARCHIVE,
                            destructive = true, onClick = act { browser.archiveAll() },
                        )
                    }
                }
                RowGroup(strings.t("tabsMenu.spaces")) {
                    app.spaces.forEach { space ->
                        ActionRow(spaceName(space, strings), "tabs-menu-space-${space.id}", selected = space.id == app.activeSpaceId, onClick = act { browser.selectSpace(space.id) })
                        RowDivider(afterIcon = false)
                    }
                    ActionRow(strings.t("tabsMenu.newSpace"), "tabs-menu-new-space", icon = BayIcon.ADD, onClick = act { browser.newSpace() })
                    browser.activeSpace?.let { space ->
                        RowDivider()
                        ActionRow(strings.t("tabsMenu.editSpace", mapOf("name" to spaceName(space, strings))), "tabs-menu-edit-space", icon = BayIcon.TUNE) {
                            browser.panel = Panel.SPACE_EDIT
                        }
                    }
                }
                RowGroup(strings.t("tabsMenu.moveTab")) {
                    ActionRow(strings.t("tabsMenu.moveTabTo"), "tabs-menu-move", chevron = true) { page = MenuPage.MOVE }
                }
                RowGroup(strings.t("tabsMenu.folders")) {
                    if (app.folders.isEmpty()) {
                        ActionRow(strings.t("tabsMenu.noFolders"), "tabs-menu-folders-empty") { startNaming(MenuPage.NEW_FOLDER) }
                        RowDivider(afterIcon = false)
                    } else {
                        app.folders.forEach { folder ->
                            ActionRow(folder.name, "tabs-menu-folder-${folder.id}", selected = folder.id == selected) { browser.activeFolderId = folder.id }
                            RowDivider(afterIcon = false)
                        }
                    }
                    ActionRow(strings.t("tabsMenu.newFolder"), "tabs-menu-new-folder", icon = BayIcon.ADD) { startNaming(MenuPage.NEW_FOLDER) }
                    if (selected != null) {
                        RowDivider()
                        ActionRow(strings.t("tabsMenu.renameFolder"), "tabs-menu-rename-folder") { startNaming(MenuPage.RENAME_FOLDER) }
                        RowDivider(afterIcon = false)
                        ActionRow(
                            strings.t("tabsMenu.deleteFolder"), "tabs-menu-delete-folder", detail = strings.t("tabsMenu.deleteFolder.detail"),
                            destructive = true, onClick = act { browser.deleteFolder(selected) },
                        )
                    }
                }
            }
        }
        MenuPage.MOVE -> {
            val title = strings.t("tabsMenu.moveTab")
            PanelSheet(visible, title, "tabs-menu", strings.sheetWords(title), close, onBack = { page = MenuPage.MAIN }) {
                RowGroup(strings.t("tabsMenu.spaces")) {
                    app.spaces.forEachIndexed { index, space ->
                        if (index > 0) RowDivider(afterIcon = false)
                        ActionRow(
                            spaceName(space, strings), "tabs-menu-move-space-${space.id}", selected = space.id == app.activeSpaceId,
                            onClick = act { browser.moveActiveTab(space.id, null) },
                        )
                    }
                }
                if (app.folders.isNotEmpty()) {
                    RowGroup(strings.t("tabsMenu.folders")) {
                        app.folders.forEachIndexed { index, folder ->
                            if (index > 0) RowDivider(afterIcon = false)
                            ActionRow(
                                folder.name, "tabs-menu-move-folder-${folder.id}", selected = folder.id == selected,
                                onClick = act { browser.moveActiveTab(app.activeSpaceId, folder.id) },
                            )
                        }
                    }
                }
            }
        }
        MenuPage.NEW_FOLDER, MenuPage.RENAME_FOLDER -> {
            val current = app.folders.firstOrNull { it.id == selected }?.name
            val title = when {
                page == MenuPage.NEW_FOLDER -> strings.t("tabsMenu.newFolderTitle")
                current != null -> strings.t("tabsMenu.rename", mapOf("name" to current))
                else -> strings.t("tabsMenu.renameFolder")
            }
            val save = {
                val trimmed = name.trim()
                if (trimmed.isNotEmpty()) {
                    if (page == MenuPage.NEW_FOLDER) browser.newFolder(trimmed) else selected?.let { browser.renameFolder(it, trimmed) }
                }
                page = MenuPage.MAIN
            }
            PanelSheet(visible, title, "tabs-menu", strings.sheetWords(title), close, onBack = { page = MenuPage.MAIN }) {
                NameField(name, { name = it }, title, save)
                Box(Modifier.padding(top = Space.sm)) { ActionRow(strings.t("tabsMenu.done"), "tabs-menu-name-save", onClick = save) }
            }
        }
    }
}

@Composable
private fun NameField(value: String, onChange: (String) -> Unit, label: String, onDone: () -> Unit) {
    val colors = Theme.colors
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    Box(
        Modifier.fillMaxWidth().padding(top = Space.xs).heightIn(min = 44.dp).background(colors.fill, CircleShape).padding(horizontal = Space.lg),
        contentAlignment = Alignment.CenterStart,
    ) {
        BasicTextField(
            value,
            onChange,
            Modifier.fillMaxWidth().focusRequester(focus).testTag("tabs-menu-name").semantics { contentDescription = label },
            singleLine = true,
            textStyle = TextVariant.BODY.style(color = colors.foreground),
            cursorBrush = SolidColor(colors.accent),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { onDone() }),
        )
    }
}

/**
 * A tab's pinning, from holding its card: an Essential, a pinned row, or a row in one of the space's folders, as the
 * desktop's sidebar has them. The way it is pinned now is ticked; choosing it again unpins it.
 */
@Composable
fun PinPanel(browser: BrowserModel, strings: Strings, visible: Boolean) {
    val app = browser.app
    val tab: BrowserTab = browser.pinTab ?: return
    val title = tab.title.ifEmpty { displayUrl(tab.url) }
    val pin = app.pins.firstOrNull { it.url == tab.url }
    PanelSheet(visible, title, "pin-menu", strings.sheetWords(title), { browser.panel = null }) {
        RowGroup {
            ActionRow(strings.t("pin.essential"), "pin-menu-essential", icon = BayIcon.BOOKMARK, selected = pin?.kind == PinKind.ESSENTIAL) {
                browser.pin(tab, PinKind.ESSENTIAL, null)
            }
            RowDivider()
            ActionRow(strings.t("pin.row"), "pin-menu-row", icon = BayIcon.PIN, selected = pin?.kind == PinKind.ROW && pin.folderId == null) {
                browser.pin(tab, PinKind.ROW, null)
            }
            app.folders.forEach { folder ->
                RowDivider()
                ActionRow(
                    strings.t("pin.into", mapOf("folder" to folder.name)), "pin-menu-folder-${folder.id}", icon = BayIcon.FOLDER,
                    selected = pin?.kind == PinKind.ROW && pin.folderId == folder.id,
                ) { browser.pin(tab, PinKind.ROW, folder.id) }
            }
        }
        Box(Modifier.padding(top = Space.md)) {
            RowGroup {
                ActionRow(strings.t("pin.close"), "pin-menu-close-tab", icon = BayIcon.CLOSE, destructive = true) {
                    browser.panel = null
                    browser.archive(tab.id)
                }
            }
        }
    }
}
