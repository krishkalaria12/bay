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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
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
import bay.core.siteName
import bay.design.ActionRow
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.IconSize
import bay.design.PanelSheet
import bay.design.RowDivider
import bay.design.RowGroup
import bay.design.RowTint
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
 * This site's own choices, as Settings draws its pages: its zoom, desktop page and blocking first, then how Bay behaves
 * here, what was downloaded from it, the connection, and Bay's Settings at the foot.
 */
@Composable
fun SiteSettingsPanel(browser: BrowserModel, strings: Strings, visible: Boolean, onSettings: () -> Unit) {
    // Swipe's choices sit one step away, so the sheet fits without scrolling.
    var swipePage by remember(visible) { mutableStateOf(false) }
    val app = browser.app
    val url = browser.activeUrl
    val setting = browser.siteSetting
    val close = { browser.panel = null }
    if (swipePage) {
        val title = strings.t("settings.swipe")
        val global = app.preferences.swipeToNavigate
        PanelSheet(visible, title, "site-settings", strings.sheetWords(title), close, onBack = { swipePage = false }) {
            RowGroup {
                ActionRow(
                    strings.t("site.swipe.follow", mapOf("mode" to strings.t("settings.swipe.${global.name.lowercase()}"))),
                    "site-swipe-follow",
                    selected = setting.swipe == null,
                ) { browser.changeSiteSetting { it.copy(swipe = null) } }
                listOf(SwipeMode.ANYWHERE, SwipeMode.EDGES, SwipeMode.OFF).forEach { mode ->
                    val name = mode.name.lowercase()
                    RowDivider(afterIcon = false)
                    ActionRow(strings.t("settings.swipe.$name"), "site-swipe-$name", selected = setting.swipe == mode) {
                        browser.changeSiteSetting { it.copy(swipe = mode) }
                    }
                }
            }
            BayText(
                strings.t("site.swipe.note"),
                Modifier.padding(horizontal = Space.lg).padding(top = Space.sm).testTag("site-swipe-note"),
                variant = TextVariant.FOOTNOTE,
                tone = TextTone.MUTED,
            )
        }
        return
    }
    val title = strings.t("site.title")
    val blocking = browser.blocking
    val changed = setting.textSize != null || setting.reader || setting.desktopMode || setting.swipe != null
    val downloaded = app.store.downloadsFrom(url)
    PanelSheet(
        visible, title, "site-settings", strings.sheetWords(title), close, maxFraction = 0.85f,
        header = {
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                if (url.isNotEmpty()) SiteIcon(app, url, size = 30.dp)
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
            RowGroup {
                SiteZoomRow(strings, setting.textSize?.toInt(), app.preferences.textSize.toInt()) { zoom ->
                    browser.changeSiteSetting { it.copy(textSize = zoom?.toDouble()) }
                }
                RowDivider()
                ActionRow(strings.t("site.desktop"), "site-desktop", icon = BayIcon.DESKTOP, tint = RowTint.language, toggle = setting.desktopMode) {
                    browser.setDesktop(!setting.desktopMode)
                }
                if (blocking != PageBlocking.OFF) {
                    RowDivider()
                    ActionRow(
                        strings.t("pageMenu.blocking"), "site-blocking", icon = BayIcon.SHIELD, tint = RowTint.blocking,
                        detail = when (blocking) {
                            PageBlocking.PAUSED -> strings.t("pageMenu.blocking.paused")
                            PageBlocking.RESTORED -> strings.t("pageMenu.blocking.restored")
                            else -> null
                        },
                        toggle = blocking == PageBlocking.ON,
                        onClick = browser::toggleBlocking,
                    )
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
            RowGroup(strings.t("site.bayHere")) {
                ActionRow(strings.t("site.reader"), "site-reader", icon = BayIcon.READER, tint = RowTint.bookmarks, toggle = setting.reader) {
                    browser.changeSiteSetting { it.copy(reader = !setting.reader) }
                }
                RowDivider()
                val mode = (setting.swipe ?: app.preferences.swipeToNavigate).name.lowercase()
                ActionRow(
                    strings.t("settings.swipe"), "site-swipe", icon = BayIcon.BACK, tint = RowTint.browsing,
                    value = strings.t("settings.swipe.$mode"), chevron = true,
                ) { swipePage = true }
            }
            if (downloaded > 0u) {
                RowGroup {
                    ActionRow(
                        strings.t("site.downloaded"), "site-downloaded", icon = BayIcon.DOWNLOAD, tint = RowTint.downloads,
                        value = "$downloaded", chevron = true,
                    ) { browser.panel = Panel.DOWNLOADS }
                }
            }
            if (url.isNotEmpty()) RowGroup { Connection(strings, url.startsWith("https://")) }
            if (changed) {
                RowGroup {
                    ActionRow(strings.t("site.reset"), "site-reset", icon = BayIcon.DELETE, tint = RowTint.delete, destructive = true) {
                        browser.changeSiteSetting { it.copy(textSize = null, reader = false, desktopMode = false, swipe = null) }
                    }
                }
            }
            RowGroup {
                ActionRow(strings.t("site.settings"), "site-bay-settings", icon = BayIcon.SETTINGS, tint = RowTint.browsing, chevron = true) {
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
        TintedIcon(BayIcon.TEXT_SIZE, RowTint.display)
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

@Composable
private fun TintedIcon(icon: BayIcon, tint: Color) {
    Box(Modifier.size(29.dp).background(tint, RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
        BayIconView(icon, size = IconSize.small, color = Color.White)
    }
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
        TintedIcon(BayIcon.LOCK, if (secure) RowTint.blocking else RowTint.delete)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            BayText(label, tone = if (secure) TextTone.DEFAULT else TextTone.DANGER)
            BayText(detail, variant = TextVariant.SUBHEAD, tone = TextTone.MUTED)
        }
    }
}
