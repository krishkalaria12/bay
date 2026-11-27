package bay.app.browser

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import bay.app.Strings
import bay.core.resolveLink
import bay.design.ActionRow
import bay.design.BayIcon
import bay.design.BayText
import bay.design.PanelSheet
import bay.design.Radius
import bay.design.RowDivider
import bay.design.RowGroup
import bay.design.Space
import bay.design.TextTone
import bay.design.TextVariant
import bay.design.Theme
import bay.engine.EngineEvent
import kotlinx.coroutines.launch

/** Where "Where does it go?" got to: still asking, or the answer (a destination, or none when unreachable). */
private sealed interface Destination {
    data object Checking : Destination
    data class Found(val url: String?) : Destination
}

/**
 * A long-pressed link's (or bare image's) menu: what to do with it, and for a link, "Where does it go?" follows its
 * redirects and says where it ends.
 */
@Composable
fun LinkMenu(browser: BrowserModel, strings: Strings, visible: Boolean) {
    val link = browser.link
    val title = strings.t("linkMenu.title")
    val close = { browser.panel = null }
    PanelSheet(visible, title, "link-menu", strings.sheetWords(title), close, maxFraction = 0.85f) {
        if (link != null) key(link.url) { LinkActions(browser, strings, link, close) }
    }
}

@Composable
private fun LinkActions(browser: BrowserModel, strings: Strings, link: EngineEvent.LinkPress, close: () -> Unit) {
    val app = browser.app
    // A link on a private page opens privately, in front or behind.
    val privately = browser.activeTab?.private == true
    val scope = rememberCoroutineScope()
    var destination by remember { mutableStateOf<Destination?>(null) }
    val act = { action: () -> Unit ->
        {
            close()
            action()
        }
    }
    // No live preview here yet: the page on screen doesn't draw again after a second page view has (Known gaps).
    if (link.title.isNotEmpty() && link.title != link.url) {
        BayText(link.title, Modifier.padding(horizontal = Space.xs), variant = TextVariant.CALLOUT, weight = FontWeight.Medium, maxLines = 2)
    }
    BayText(
        link.url,
        Modifier.padding(horizontal = Space.xs).padding(bottom = Space.lg).testTag("link-menu-url"),
        variant = TextVariant.FOOTNOTE,
        tone = TextTone.MUTED,
        maxLines = 3,
    )
    RowGroup {
        if (link.image) {
            ActionRow(strings.t("linkMenu.openImage"), "link-open-tab", icon = BayIcon.ADD, onClick = act { browser.openTab(link.url, privately) })
            RowDivider()
            ActionRow(strings.t("linkMenu.copyImage"), "link-image-copy", icon = BayIcon.COPY, onClick = act { browser.copyAddress(link.url) })
            RowDivider()
            ActionRow(strings.t("linkMenu.shareImage"), "link-image-share", icon = BayIcon.SHARE, onClick = act { browser.share(link.url) })
            RowDivider()
            ActionRow(strings.t("linkMenu.saveImage"), "link-image-save", icon = BayIcon.DOWNLOAD, onClick = act { browser.saveImage(link.url) })
        } else {
            ActionRow(strings.t("linkMenu.openTab"), "link-open-tab", icon = BayIcon.ADD, onClick = act { browser.openTab(link.url, privately) })
            RowDivider()
            ActionRow(
                strings.t("linkMenu.openBackground"), "link-open-background", icon = BayIcon.TABS,
                onClick = act { browser.openTab(link.url, privately, background = true) },
            )
            RowDivider()
            ActionRow(strings.t("linkMenu.copyLink"), "link-copy", icon = BayIcon.LINK, onClick = act { browser.copyAddress(link.url) })
            RowDivider()
            ActionRow(strings.t("linkMenu.share"), "link-share", icon = BayIcon.SHARE, onClick = act { browser.share(link.url) })
            RowDivider()
            val checking = destination == Destination.Checking
            ActionRow(
                if (checking) strings.t("linkMenu.checking") else strings.t("linkMenu.where"), "link-destination",
                icon = BayIcon.FORWARD, enabled = !checking,
            ) {
                destination = Destination.Checking
                // Resolving belongs to the menu: closing it (or opening it on another link) drops the answer.
                scope.launch { destination = Destination.Found(resolveLink(app.http, link.url)) }
            }
        }
    }
    when (val answer = destination) {
        is Destination.Found -> if (answer.url != null) {
            Column(
                Modifier.fillMaxWidth().padding(top = Space.md).background(Theme.colors.fill, RoundedCornerShape(Radius.card)).padding(Space.lg)
                    .semantics { liveRegion = LiveRegionMode.Polite },
                verticalArrangement = Arrangement.spacedBy(Space.xs),
            ) {
                BayText(strings.t("linkMenu.destination"), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED)
                SelectionContainer { BayText(answer.url, Modifier.testTag("link-destination-result")) }
            }
        } else {
            BayText(
                strings.t("linkMenu.unreachable"),
                Modifier.padding(top = Space.md).testTag("link-destination-error").semantics { liveRegion = LiveRegionMode.Assertive },
                variant = TextVariant.SUBHEAD,
                tone = TextTone.DANGER,
            )
        }
        else -> {}
    }
}
