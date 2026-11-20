package bay.app.browser

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import bay.app.Strings
import bay.core.BrowserTab
import bay.core.PinKind
import bay.design.ActionRow
import bay.design.BayIcon
import bay.design.BayText
import bay.design.PanelSheet
import bay.design.RowDivider
import bay.design.RowGroup
import bay.design.Space
import bay.design.TextVariant
import bay.design.Theme

/**
 * A tab's sheet, from holding its card: the space it's in (another chip moves it there), how it's pinned (an Essential,
 * a pinned row, or a row in one of the space's folders, as the desktop's sidebar has them, with a new folder made here),
 * and closing it. The way it is pinned now is ticked; choosing it again unpins it.
 */
@Composable
fun PinPanel(browser: BrowserModel, strings: Strings, visible: Boolean) {
    val app = browser.app
    val tab: BrowserTab = browser.pinTab ?: return
    val title = tab.title.ifEmpty { displayUrl(tab.url) }
    val pin = app.pins.firstOrNull { it.url == tab.url }
    var naming by remember(tab.id) { mutableStateOf(false) }
    PanelSheet(visible, title, "pin-menu", strings.sheetWords(title), { browser.panel = null }) {
        if (app.spaces.size > 1) {
            Column(Modifier.padding(bottom = Space.md)) {
                BayText(strings.t("pin.spaces"), Modifier.padding(start = Space.lg, bottom = Space.sm), variant = TextVariant.FOOTNOTE, weight = FontWeight.Medium, color = Theme.colors.muted)
                SpaceChips(app.spaces, tab.spaceId, strings, onChoose = { id ->
                    browser.panel = null
                    browser.moveTab(tab, id)
                })
            }
        }
        RowGroup(strings.t("pin.pinAs")) {
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
            RowDivider()
            if (naming) {
                // A folder named here takes the tab straight in.
                Box(Modifier.padding(horizontal = Space.sm, vertical = Space.xs)) {
                    FolderNameField("", strings.t("tabs.folderName")) { name ->
                        naming = false
                        if (name != null) browser.pin(tab, PinKind.ROW, browser.newFolder(name))
                    }
                }
            } else {
                ActionRow(strings.t("tabs.newFolder"), "pin-menu-new-folder", icon = BayIcon.ADD) { naming = true }
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
