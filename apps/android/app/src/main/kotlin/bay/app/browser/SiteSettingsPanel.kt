package bay.app.browser

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import bay.app.Strings
import bay.core.SiteBlockGroup
import bay.core.SwipeMode
import bay.core.siteFontLabel
import bay.core.siteFonts
import bay.design.ActionRow
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.IconSize
import bay.design.PanelSheet
import bay.design.RowDivider
import bay.design.RowGroup
import bay.design.Space
import bay.design.TextTone
import bay.design.TextVariant
import bay.design.Theme
import bay.design.pressFeedback

/** The page zoom a site can pick, in percent (the core's `TEXT_SIZE_*`). */
private const val ZOOM_MIN = 80
private const val ZOOM_MAX = 200
private const val ZOOM_STEP = 10

private val ROW_HEIGHT = bay.design.Row.height

/**
 * This site's own choices, as Settings draws its pages: what blocking did here first, then how Bay behaves here (the
 * desktop site leading), its font and zoom, which kinds of blocking run here, what was downloaded from it, the
 * connection, and Bay's Settings at the foot.
 */
@Composable
fun SiteSettingsPanel(browser: BrowserModel, strings: Strings, visible: Boolean, onSettings: () -> Unit) {
    // The font list sits one step away, so the sheet stays short.
    var fontPage by remember(visible) { mutableStateOf(false) }
    val app = browser.app
    val url = browser.activeUrl
    val setting = browser.siteSetting
    val close = { browser.panel = null }
    val global = app.preferences.siteFont
    if (fontPage) {
        val title = strings.t("site.font")
        PanelSheet(visible, title, "site-settings", strings.sheetWords(title), close, onBack = { fontPage = false }) {
            RowGroup {
                ActionRow(
                    strings.t("site.font.sameAs", mapOf("font" to strings.t(siteFontLabel(global)))),
                    "site-font-same",
                    selected = setting.font == null,
                ) { browser.setSiteFont(null) }
                siteFonts().forEach { font ->
                    val name = font.name.lowercase()
                    RowDivider(afterIcon = false)
                    ActionRow(strings.t(siteFontLabel(font)), "site-font-$name", selected = setting.font == font) {
                        browser.setSiteFont(font)
                    }
                }
            }
            BayText(
                strings.t("settings.siteFont.note"),
                Modifier.padding(horizontal = Space.lg).padding(top = Space.sm).testTag("site-font-note"),
                variant = TextVariant.FOOTNOTE,
                tone = TextTone.MUTED,
            )
        }
        return
    }
    val title = strings.t("site.title")
    val blocking = browser.blocking
    val changed = setting.textSize != null || setting.reader || setting.desktopMode || setting.swipe != null ||
        setting.font != null || setting.fullscreen || setting.forceDark || !setting.miniPlayer
    val downloaded = app.store.downloadsFrom(url)
    val swipe = setting.swipe ?: app.preferences.swipeToNavigate
    PanelSheet(
        visible, title, "site-settings", strings.sheetWords(title), close,
        header = {
            // In line with the rows below: the site's icon centred over their icons, its name over their labels.
            Row(Modifier.weight(1f).padding(start = Space.lg - 2.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                if (url.isNotEmpty()) SiteIcon(app, url, size = 28.dp)
                BayText(
                    siteName(url),
                    Modifier.weight(1f).testTag("site-settings-host").semantics { heading() },
                    variant = TextVariant.HEADLINE,
                    maxLines = 1,
                )
            }
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(Space.md)) {
            // What blocking did on this page, and a way to see it as the site made it: moved here from the page menu.
            if (blocking != PageBlocking.OFF) {
                BlockingCard(browser, strings, blocking) {
                    browser.panel = null
                    browser.restoreOriginal()
                }
            }
            RowGroup(strings.t("site.bayHere")) {
                ActionRow(strings.t("site.desktop"), "site-desktop", icon = BayIcon.DESKTOP, toggle = setting.desktopMode) {
                    browser.setDesktop(!setting.desktopMode)
                }
                RowDivider()
                ActionRow(strings.t("site.forceDark"), "site-force-dark", icon = BayIcon.DARK, toggle = setting.forceDark) {
                    browser.changeSiteSetting { it.copy(forceDark = !setting.forceDark) }
                }
                RowDivider()
                ActionRow(strings.t("site.fullscreen"), "site-fullscreen", icon = BayIcon.FULLSCREEN, toggle = setting.fullscreen) {
                    browser.changeSiteSetting { it.copy(fullscreen = !setting.fullscreen) }
                }
                RowDivider()
                // Settings keeps the whole choice, Off included; here it's anywhere or from the edges.
                ActionRow(
                    strings.t("site.swipeAnywhere"), "site-swipe", icon = BayIcon.SWIPE, toggle = swipe == SwipeMode.ANYWHERE,
                ) {
                    // Back on the global choice, the site keeps none of its own (and has nothing to reset).
                    val next = if (swipe == SwipeMode.ANYWHERE) SwipeMode.EDGES else SwipeMode.ANYWHERE
                    browser.changeSiteSetting { it.copy(swipe = next.takeIf { mode -> mode != app.preferences.swipeToNavigate }) }
                }
                RowDivider()
                ActionRow(strings.t("site.miniPlayer"), "site-mini-player", icon = BayIcon.PIP, toggle = setting.miniPlayer) {
                    browser.changeSiteSetting { it.copy(miniPlayer = !setting.miniPlayer) }
                }
                RowDivider()
                ActionRow(strings.t("site.reader"), "site-reader", icon = BayIcon.READER, toggle = setting.reader) {
                    browser.changeSiteSetting { it.copy(reader = !setting.reader) }
                }
            }
            // The page wouldn't take the font chosen: said here rather than failing without a word.
            if (app.activeTabId in browser.fontBlocked) {
                BayText(
                    strings.t("site.font.blocked"),
                    Modifier.padding(horizontal = Space.lg).testTag("site-font-blocked"),
                    variant = TextVariant.FOOTNOTE,
                    tone = TextTone.MUTED,
                )
            }
            RowGroup {
                ActionRow(
                    strings.t("site.font"), "site-font", icon = BayIcon.FONT,
                    value = setting.font?.let { strings.t(siteFontLabel(it)) } ?: strings.t("site.font.same"),
                    chevron = true,
                ) { fontPage = true }
                RowDivider()
                SiteZoomRow(strings, setting.textSize?.toInt(), app.preferences.textSize.toInt()) { zoom ->
                    browser.changeSiteSetting { it.copy(textSize = zoom?.toDouble()) }
                }
            }
            if (blocking == PageBlocking.ON) {
                RowGroup(strings.t("site.blockingHere")) {
                    listOf(SiteBlockGroup.ADS, SiteBlockGroup.TRACKERS, SiteBlockGroup.COOKIES).forEachIndexed { index, group ->
                        val name = group.name.lowercase()
                        val off = group in setting.blockOff
                        if (index > 0) RowDivider(afterIcon = false)
                        ActionRow(strings.t("site.block.$name"), "site-block-$name", toggle = !off) {
                            browser.changeSiteSetting { it.copy(blockOff = if (off) it.blockOff - group else it.blockOff + group) }
                        }
                    }
                }
            }
            if (downloaded > 0u) {
                RowGroup {
                    ActionRow(
                        strings.t("site.downloaded"), "site-downloaded", icon = BayIcon.DOWNLOAD,
                        value = "$downloaded", chevron = true,
                    ) { browser.panel = Panel.DOWNLOADS }
                }
            }
            if (url.isNotEmpty()) RowGroup { Connection(strings, url.startsWith("https://")) }
            if (changed) {
                RowGroup {
                    ActionRow(strings.t("site.reset"), "site-reset", icon = BayIcon.DELETE, destructive = true) {
                        browser.changeSiteSetting {
                            it.copy(
                                textSize = null, reader = false, desktopMode = false, swipe = null,
                                font = null, fullscreen = false, forceDark = false, miniPlayer = true,
                            )
                        }
                    }
                }
            }
            RowGroup {
                ActionRow(strings.t("site.settings"), "site-bay-settings", icon = BayIcon.SETTINGS, chevron = true) {
                    browser.panel = null
                    onSettings()
                }
            }
        }
    }
}

/** Page zoom with − and + at its end; the percentage goes back to Bay's own zoom. */
@Composable
private fun SiteZoomRow(strings: Strings, zoom: Int?, global: Int, onChange: (Int?) -> Unit) {
    val value = zoom ?: global
    Row(
        Modifier.fillMaxWidth().heightIn(min = ROW_HEIGHT).padding(start = Space.lg, end = Space.sm),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BayIconView(BayIcon.TEXT_SIZE, size = IconSize.control)
        BayText(strings.t("site.zoom"), maxLines = 1)
        Spacer(Modifier.weight(1f))
        Row(Modifier.background(Theme.colors.fill, CircleShape), verticalAlignment = Alignment.CenterVertically) {
            ZoomStep(BayIcon.MINUS, "site-zoom-smaller", strings.t("site.zoom.out"), value > ZOOM_MIN) { onChange(maxOf(ZOOM_MIN, value - ZOOM_STEP)) }
            Box(
                Modifier.widthIn(min = 52.dp).heightIn(min = 36.dp).testTag("site-zoom-value")
                    .clearAndSetSemantics {
                        contentDescription = strings.t("site.zoom.reset", mapOf("size" to "$global"))
                        stateDescription = strings.percent(value)
                        role = Role.Button
                    }
                    .pressFeedback(enabled = zoom != null) { onChange(null) },
                contentAlignment = Alignment.Center,
            ) {
                BayText(
                    strings.percent(value),
                    variant = TextVariant.SUBHEAD,
                    weight = if (zoom == null) FontWeight.Normal else FontWeight.SemiBold,
                    tone = if (zoom == null) TextTone.MUTED else TextTone.DEFAULT,
                )
            }
            ZoomStep(BayIcon.ADD, "site-zoom-larger", strings.t("site.zoom.in"), value < ZOOM_MAX) { onChange(minOf(ZOOM_MAX, value + ZOOM_STEP)) }
        }
    }
}

@Composable
private fun ZoomStep(icon: BayIcon, testID: String, label: String, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.size(40.dp, 36.dp).alpha(if (enabled) 1f else 0.35f).testTag(testID)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button }
            .pressFeedback(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { BayIconView(icon, size = IconSize.small) }
}

/** Whether pages from here travel encrypted: said, not tapped. */
@Composable
private fun Connection(strings: Strings, secure: Boolean) {
    val label = if (secure) strings.t("site.secure") else strings.t("site.notSecure")
    val detail = if (secure) strings.t("site.secure.detail") else strings.t("site.notSecure.detail")
    Row(
        Modifier.fillMaxWidth().heightIn(min = ROW_HEIGHT).padding(horizontal = Space.lg, vertical = Space.md).testTag("site-connection")
            .clearAndSetSemantics {
                contentDescription = label
                stateDescription = detail
            },
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BayIconView(BayIcon.LOCK, size = IconSize.control, color = if (secure) Theme.colors.foreground else Theme.colors.danger)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            BayText(label, tone = if (secure) TextTone.DEFAULT else TextTone.DANGER)
            BayText(detail, variant = TextVariant.SUBHEAD, tone = TextTone.MUTED)
        }
    }
}
