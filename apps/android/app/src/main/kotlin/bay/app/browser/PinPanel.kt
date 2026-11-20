package bay.app.browser

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import bay.app.Strings
import bay.core.BrowserTab
import bay.core.PinKind
import bay.design.ActionRow
import bay.design.BayIcon
import bay.design.PanelSheet
import bay.design.RowDivider
import bay.design.RowGroup
import bay.design.Space

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
