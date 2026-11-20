package bay.app.browser

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import bay.app.Strings
import bay.core.BrowserTab
import bay.core.PinKind
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.IconSize
import bay.design.PanelSheet
import bay.design.Space
import bay.design.TextTone
import bay.design.TextVariant
import bay.design.Theme
import bay.design.pressFeedback

/**
 * A tab's sheet, from holding its card, in the page menu's look: the tab's site and address on top; Share, Copy link,
 * Duplicate and Close as tiles; the space it's in (another chip moves it there); and how it's pinned, Off, Essential or
 * Pinned, with the space's folders under Pinned and a new one made there. Choices here keep the sheet open, so the
 * change shows; the tiles and moving the tab close it.
 */
@Composable
fun PinPanel(browser: BrowserModel, strings: Strings, visible: Boolean) {
    val app = browser.app
    val tab: BrowserTab = browser.pinTab ?: return
    val title = tab.title.ifEmpty { displayUrl(tab.url) }
    val pin = app.pins.firstOrNull { it.url == tab.url }
    var naming by remember(tab.id) { mutableStateOf(false) }
    fun close() {
        browser.panel = null
    }
    PanelSheet(
        visible, title, "pin-menu", strings.sheetWords(title), ::close,
        header = {
            Row(Modifier.weight(1f).semantics(mergeDescendants = true) { heading() }, horizontalArrangement = Arrangement.spacedBy(Space.md), verticalAlignment = Alignment.CenterVertically) {
                SiteIcon(app, tab.url, 32.dp)
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    BayText(title, variant = TextVariant.HEADLINE, weight = FontWeight.SemiBold, maxLines = 1)
                    BayText(displayUrl(tab.url), variant = TextVariant.FOOTNOTE, tone = TextTone.MUTED, maxLines = 1)
                }
            }
        },
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            MenuTile("tab-sheet-share", BayIcon.SHARE, strings.t("pageMenu.share")) {
                close()
                browser.share(tab.url)
            }
            MenuTile("tab-sheet-copy", BayIcon.LINK, strings.t("pageMenu.copyLink")) {
                close()
                browser.copyAddress(tab.url)
            }
            MenuTile("tab-sheet-duplicate", BayIcon.COPY, strings.t("tabSheet.duplicate")) {
                close()
                browser.duplicate(tab)
            }
            MenuTile("pin-menu-close-tab", BayIcon.CLOSE, strings.t("tabSheet.close"), description = strings.t("pin.close")) {
                close()
                browser.archive(tab.id)
            }
        }
        if (app.spaces.size > 1) {
            Section(strings.t("pin.spaces")) {
                SpaceChips(app.spaces, tab.spaceId, strings, onChoose = { id ->
                    if (id != tab.spaceId) {
                        close()
                        browser.moveTab(tab, id)
                    }
                })
            }
        }
        Section(strings.t("pin.pinAs")) {
            PinKindPicker(strings, pin?.kind) { kind -> browser.setPin(tab, kind, if (kind == PinKind.ROW) pin?.folderId else null) }
            if (pin?.kind == PinKind.ROW) {
                BayText(strings.t("pin.folder"), Modifier.padding(top = Space.sm), variant = TextVariant.FOOTNOTE, weight = FontWeight.Medium, tone = TextTone.MUTED)
                if (naming) {
                    // A folder named here takes the tab straight in.
                    FolderNameField("", strings.t("tabs.folderName")) { name ->
                        naming = false
                        if (name != null) browser.setPin(tab, PinKind.ROW, browser.newFolder(name))
                    }
                } else {
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
                        FolderChip(strings.t("pin.noFolder"), null, pin.folderId == null, "pin-menu-folder-none") { browser.setPin(tab, PinKind.ROW, null) }
                        app.folders.forEach { folder ->
                            FolderChip(folder.name, BayIcon.FOLDER, pin.folderId == folder.id, "pin-menu-folder-${folder.id}") { browser.setPin(tab, PinKind.ROW, folder.id) }
                        }
                        Box(
                            Modifier.size(36.dp).testTag("pin-menu-new-folder").background(Theme.colors.fill, CircleShape)
                                .clearAndSetSemantics { contentDescription = strings.t("tabs.newFolder"); role = Role.Button }
                                .pressFeedback { naming = true },
                            contentAlignment = Alignment.Center,
                        ) { BayIconView(BayIcon.ADD, size = IconSize.small, color = Theme.colors.muted) }
                    }
                }
            }
        }
    }
}

/** A group with a small heading over it. */
@Composable
private fun Section(heading: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = Space.lg), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        BayText(heading, variant = TextVariant.FOOTNOTE, weight = FontWeight.Medium, tone = TextTone.MUTED)
        content()
    }
}

/** Off, Essential or Pinned in one control, the way the tab is pinned now filled. */
@Composable
private fun PinKindPicker(strings: Strings, kind: PinKind?, choose: (PinKind?) -> Unit) {
    val colors = Theme.colors
    Row(Modifier.fillMaxWidth().background(colors.fill, CircleShape).padding(3.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        listOf(Triple(strings.t("pin.off"), null, "pin-menu-off"), Triple(strings.t("pin.essentialShort"), PinKind.ESSENTIAL, "pin-menu-essential"), Triple(strings.t("pin.pinned"), PinKind.ROW, "pin-menu-row"))
            .forEach { (label, value, id) ->
                val chosen = kind == value
                Box(
                    Modifier.weight(1f).heightIn(min = 36.dp).testTag(id)
                        .then(if (chosen) Modifier.shadow(2.dp, CircleShape).background(colors.surface, CircleShape) else Modifier)
                        .clearAndSetSemantics { contentDescription = label; role = Role.Tab; selected = chosen }
                        .pressFeedback { choose(value) },
                    contentAlignment = Alignment.Center,
                ) { BayText(label, variant = TextVariant.SUBHEAD, weight = if (chosen) FontWeight.SemiBold else FontWeight.Medium, maxLines = 1) }
            }
    }
}

/** One of the folders a pinned row can sit in, as a chip; the chosen one filled in the accent. */
@Composable
private fun FolderChip(label: String, icon: BayIcon?, chosen: Boolean, id: String, onClick: () -> Unit) {
    val colors = Theme.colors
    val ink = if (chosen) Color.White else colors.foreground
    Row(
        Modifier.height(36.dp).testTag(id).background(if (chosen) colors.accent else colors.fill, CircleShape)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button; selected = chosen }
            .pressFeedback(onClick = onClick).padding(horizontal = Space.md),
        horizontalArrangement = Arrangement.spacedBy(Space.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) BayIconView(icon, size = IconSize.inline, color = ink)
        BayText(label, variant = TextVariant.SUBHEAD, weight = FontWeight.Medium, color = ink, maxLines = 1)
    }
}
